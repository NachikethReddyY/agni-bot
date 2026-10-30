/**
 * `agni chat` — the interactive face of the daemon.
 *
 * One socket, streaming tokens, tool activity strips, approvals, background
 * notifications, and a reconnect that resyncs instead of pretending nothing
 * happened. Deliberately plain: the Tauri app is the pretty client; this one
 * is for the terminal and for tests.
 */
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, type AgentInfo, type MessageInfo, type ServerFrame, type ThreadInfo } from "@agni/protocol";
import { AgniSocket } from "./client";
import { readSecret } from "./secret";

export interface ChatConnection {
  url: string;
  token: string;
  device: string;
}

export interface ChatOptions extends ChatConnection {
  threadID?: string;
  agentID?: string;
  /** Max reconnect attempts after a dropped socket (default 10). */
  maxReconnects?: number;
}

const HELP = `commands
  /new                cut a new session block (a seam; the old prose stays above)
  /threads [n]        list recent session blocks
  /use <n|thr_id>     read a past block (sends still go to the active one)
  /history [n]        print the conversation transcript across blocks
  /agents             list personas
  /agent <id>         switch conversation surface
  /approve [id] once|always|reject   answer an approval request
  /secret [id]       enter a one-time password (hidden input)
  /cancel             stop the running turn
  /status             connection, conversation, and agent state
  /quit               exit (Ctrl+C at the prompt does the same)
anything else is sent to the agent; Ctrl+C while streaming cancels the turn.`;

export async function startChat(options: ChatOptions): Promise<void> {
  const color = makeColors();
  const interactive = process.stdout.isTTY === true;

  let socket = await connectOrExit(options);
  let roster: AgentInfo[] = [];
  let threads: ThreadInfo[] = [];
  let conversationID = "";
  let threadID = options.threadID ?? "";
  let agentID = options.agentID ?? "";
  let activeTurn: string | null = null;
  let pendingSend = false;
  let streamedHeader = false;
  let lastApprovalID: string | null = null;
  const pendingSecrets = new Map<string, Extract<ServerFrame, { type: "secret.request" }>>();
  let closing = false;
  let reconnecting = false;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });

  const print = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };
  const prompt = (): void => {
    if (closing || !interactive || busy()) return;
    rl.setPrompt(color.cyan("you > "));
    rl.prompt();
  };
  const busy = (): boolean => activeTurn !== null || pendingSend;

  // --- frame rendering ------------------------------------------------------

  function render(frame: ServerFrame): void {
    switch (frame.type) {
      case "agents.update":
        roster = frame.agents;
        break;
      case "conversation.ok":
        conversationID = frame.conversationID;
        if (frame.sessionID) threadID = frame.sessionID;
        print(color.dim(`conversation ${frame.conversationID} · active block ${frame.sessionID || "(none yet)"}`));
        break;
      case "session.start":
        print(color.dim(`— session seam (${frame.reason}) · now in ${frame.sessionID}`));
        if (frame.conversationID === conversationID) threadID = frame.sessionID;
        break;
      case "turn.start": {
        const ours = conversationID
          ? frame.conversationID === conversationID
          : threadID === "" || frame.threadID === threadID;
        if (!ours) return; // a background job turn in another conversation
        // The block the turn runs in (a seam may have rotated it just now).
        threadID = frame.threadID;
        activeTurn = frame.turnID;
        pendingSend = false;
        streamedHeader = false;
        break;
      }
      case "token": {
        // Keyed by turn: block ids change at seams, turn ids do not.
        if (frame.turnID !== activeTurn) return;
        if (!streamedHeader) {
          if (interactive) process.stdout.write("\n");
          process.stdout.write(`${color.gold("agni > ")}`);
          streamedHeader = true;
        }
        process.stdout.write(frame.delta);
        break;
      }
      case "turn.end": {
        if (frame.turnID !== activeTurn) return;
        activeTurn = null;
        pendingSend = false;
        if (streamedHeader) process.stdout.write("\n");
        const usage = frame.usage;
        const model = usage?.provider && usage.model ? `${usage.provider}/${usage.model}` : undefined;
        const bits = [
          frame.stopReason !== "end" ? color.yellow(frame.stopReason) : undefined,
          model,
          usage?.latencyMs !== undefined ? `${usage.latencyMs}ms` : undefined,
        ].filter(Boolean);
        if (bits.length > 0) print(color.dim(`— ${bits.join(" · ")}`));
        prompt();
        break;
      }
      case "tool.start":
        print(color.dim(`[tool] ${frame.name}${frame.preview ? `: ${frame.preview}` : ""}`));
        break;
      case "tool.update":
        if (frame.preview) print(color.dim(`[tool] ${frame.preview}`));
        break;
      case "tool.end":
        print(color.dim(`[tool] done (${frame.ok ? "ok" : "failed"})${frame.preview ? `: ${frame.preview}` : ""}`));
        break;
      case "approval.request":
        lastApprovalID = frame.requestID;
        print(color.yellow(`[approval ${frame.requestID}] ${frame.action}`));
        print(indent(frame.preview));
        print(color.dim(`  answer: /approve ${frame.requestID} ${frame.buttons.join("|")}`));
        break;
      case "secret.request":
        pendingSecrets.set(frame.requestID, frame);
        print(color.yellow(`[secret ${frame.requestID}] ${frame.purpose}`));
        print(indent(frame.command));
        print(color.dim(`  enter it: /secret ${frame.requestID} (hidden input) — or use the web app`));
        break;
      case "secret.cancel":
        pendingSecrets.delete(frame.requestID);
        print(color.dim(`[secret ${frame.requestID}] ${frame.reason}`));
        break;
      case "form.request":
        print(color.yellow(`[question ${frame.requestID}] ${frame.question}`));
        if (frame.options?.length) print(`  options: ${frame.options.join(", ")}`);
        break;
      case "notify":
        print(color.cyan(`[notify] ${frame.title}: ${frame.body}`));
        break;
      case "thread.list.ok":
        threads = frame.threads;
        printThreads(threads, color);
        break;
      case "thread.history.ok":
        printHistory(frame.threadID, frame.title, frame.messages, color);
        break;
      case "conversation.history.ok":
        printConversationHistory(frame.messages, color);
        break;
      case "error":
        print(color.yellow(`! ${frame.code}: ${frame.message}`));
        if (pendingSend && activeTurn === null) {
          // Rejected before the turn started (bad thread, no provider, …).
          pendingSend = false;
          prompt();
        }
        if (frame.code === "resync_gap" && conversationID) {
          print(color.dim("(reloading history from the database)"));
          void socket
            .conversationHistory(conversationID, 20)
            .then((history) => printConversationHistory(history.messages, color))
            .catch(() => {});
        }
        break;
      default:
        break;
    }
  }

  // --- connection lifecycle -------------------------------------------------

  function bind(current: AgniSocket): void {
    current.onFrame(render);
    current.onClose((code, reason) => {
      // A close from a socket we already replaced is history, not news.
      if (closing || current !== socket || reconnecting) return;
      activeTurn = null;
      pendingSend = false;
      print(color.yellow(`! disconnected (${code}${reason ? ` ${reason}` : ""})`));
      void reconnect();
    });
  }

  async function reconnect(): Promise<void> {
    reconnecting = true;
    const resumeFrom = socket.lastSeq;
    const maxAttempts = options.maxReconnects ?? 10;
    for (let attempt = 1; attempt <= maxAttempts && !closing; attempt += 1) {
      await Bun.sleep(Math.min(400 * 2 ** (attempt - 1), 8000));
      try {
        const next = await AgniSocket.connect(options.url, options.token, options.device);
        socket = next;
        bind(next);
        next.resync(resumeFrom);
        // A server that accepts and immediately drops would otherwise leave a
        // dead socket with no close handler left to fire.
        await Bun.sleep(250);
        if (next.closed) {
          print(color.dim("  the connection dropped again"));
          continue;
        }
        print(color.dim(`reconnected — resync from seq ${resumeFrom}`));
        reconnecting = false;
        // Rebind the surface: conversation.ok refreshes the active block.
        next.conversationOpen(conversationID, agentID || undefined).catch(() => {});
        if (threadID) socket.send({ type: "thread.open", threadID });
        prompt();
        return;
      } catch (error) {
        print(color.dim(`  reconnect ${attempt}/${maxAttempts} failed: ${messageOf(error)}`));
      }
    }
    reconnecting = false;
    if (!closing) {
      print("could not reconnect — exiting");
      shutdown(0);
    }
  }

  process.on("SIGINT", () => {
    if (activeTurn) {
      socket.send({ type: "msg.cancel", turnID: activeTurn });
      print(color.dim("(cancelling…)"));
      return;
    }
    shutdown(0);
  });

  function shutdown(code: number): void {
    if (closing) return;
    closing = true;
    rl.close();
    socket.close();
    process.exit(code);
  }

  // --- input ----------------------------------------------------------------

  async function sendMessage(text: string): Promise<void> {
    if (conversationID) {
      // The conversation lane: the server picks the active session block.
      pendingSend = true;
      socket.send({ type: "msg.send", conversationID, text });
      return;
    }
    if (!threadID) print(color.dim("(new thread)"));
    pendingSend = true;
    socket.send({ type: "msg.send", threadID, text });
  }

  async function handleLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) {
      prompt();
      return;
    }
    if (!line.startsWith("/")) {
      if (busy()) {
        print(color.dim("(still streaming — /cancel to stop, or wait)"));
        prompt();
        return;
      }
      await sendMessage(line);
      return;
    }

    const [command = "", ...rest] = line.slice(1).split(/\s+/);
    switch (command) {
      case "help":
        print(HELP);
        break;
      case "new":
        if (conversationID) {
          void socket.sessionNew(conversationID).catch((error: unknown) => print(color.yellow(messageOf(error))));
          print(color.dim("(seam cut — continuing in a fresh session block)"));
        } else {
          threadID = "";
          print(color.dim("(next message starts a new thread)"));
        }
        break;
      case "threads": {
        const limit = Number.parseInt(rest[0] ?? "20", 10) || 20;
        void socket.threadList(limit).catch((error: unknown) => print(color.yellow(messageOf(error))));
        break;
      }
      case "use": {
        const target = rest[0];
        const index = Number.parseInt(target ?? "", 10);
        const chosen = Number.isFinite(index) && target !== undefined && /^\d+$/.test(target) ? threads[index - 1] : undefined;
        const id = chosen?.id ?? target;
        if (!id) {
          print("usage: /use <n|thr_id> — /threads first if you need ids");
          break;
        }
        threadID = id;
        socket.send({ type: "thread.open", threadID });
        print(color.dim(`reading ${id}${chosen?.title ? ` "${chosen.title}"` : ""} — sends still land in the active block`));
        void socket.threadHistory(threadID, 20).catch((error: unknown) => print(color.yellow(messageOf(error))));
        break;
      }
      case "history": {
        if (!conversationID) {
          print("(no conversation yet — connected to a pre-v2 server?)");
          break;
        }
        const limit = Number.parseInt(rest[0] ?? "20", 10) || 20;
        void socket.conversationHistory(conversationID, limit).catch((error: unknown) => print(color.yellow(messageOf(error))));
        break;
      }
      case "agents":
        if (roster.length === 0) print("(no roster yet — the server sends agents.update after hello)");
        for (const agent of roster) {
          print(`  ${agent.id.padEnd(10)} ${agent.name}${agent.tools?.length ? ` [${agent.tools.join(",")}]` : ""}`);
        }
        break;
      case "agent": {
        const id = rest[0];
        if (!id) {
          print("usage: /agent <id>");
          break;
        }
        if (roster.length > 0 && !roster.some((agent) => agent.id === id)) {
          print(`unknown agent "${id}" — try /agents`);
          break;
        }
        socket.send({ type: "agent.select", agentID: id });
        agentID = id;
        print(color.dim(`agent → ${id} (switching conversation surface)`));
        // Each agent has one conversation; resolve it and read its active block.
        void socket
          .conversationOpen("", id)
          .then((ok) => {
            conversationID = ok.conversationID;
            if (ok.sessionID) threadID = ok.sessionID;
          })
          .catch((error: unknown) => print(color.yellow(messageOf(error))));
        break;
      }
      case "approve": {
        const id = /^apr_/.test(rest[0] ?? "") ? rest[0] : undefined;
        const decision = (id ? rest[1] : rest[0]) ?? "";
        const requestID = id ?? lastApprovalID;
        if (!requestID) {
          print("(no approval pending — /approve <requestID> <once|always|reject>)");
          break;
        }
        if (!["once", "always", "reject"].includes(decision)) {
          print("decision must be one of: once, always, reject");
          break;
        }
        socket.send({ type: "approve.reply", requestID, decision: decision as "once" | "always" | "reject" });
        print(color.dim(`approval ${requestID} → ${decision}`));
        break;
      }
      case "secret": {
        const requestID = rest[0] ?? [...pendingSecrets.keys()][0];
        const request = requestID ? pendingSecrets.get(requestID) : undefined;
        if (!request) {
          print("(no pending secret — /secret <requestID>)");
          break;
        }
        rl.pause();
        try {
          const value = await readSecret(color.dim("password (hidden): "));
          if (!value) {
            print(color.yellow("empty secret — not sent"));
            break;
          }
          socket.send({ type: "secret.reply", requestID: request.requestID, value });
          pendingSecrets.delete(request.requestID);
          print(color.dim(`secret ${request.requestID} → sent`));
        } catch (error) {
          print(color.yellow(messageOf(error)));
        } finally {
          rl.resume();
          prompt();
        }
        break;
      }
      case "cancel":
        if (activeTurn) {
          socket.send({ type: "msg.cancel", turnID: activeTurn });
          print(color.dim("(cancelling…)"));
        } else {
          print("(nothing running)");
        }
        break;
      case "status":
        print(`  connection:   ${reconnecting ? "reconnecting" : "live"} (${options.url})`);
        print(`  conversation: ${conversationID || "(not resolved yet)"}`);
        print(`  block:        ${threadID || "(assigned on next message)"}`);
        print(`  agent:        ${agentID || "(server default)"}`);
        print(`  lastSeq:      ${socket.lastSeq}`);
        print(`  turn:         ${activeTurn ?? "(idle)"}`);
        break;
      case "quit":
      case "exit":
        shutdown(0);
        return;
      default:
        print(`unknown command "/${command}" — /help`);
        break;
    }
    prompt();
  }

  rl.on("line", (line) => {
    void handleLine(line).catch((error: unknown) => {
      print(color.yellow(`! ${messageOf(error)}`));
      prompt();
    });
  });
  rl.on("close", () => {
    if (!closing) shutdown(0);
  });

  bind(socket);
  if (options.agentID) socket.send({ type: "agent.select", agentID: options.agentID });
  // Resolve the one conversation surface right away; its active block is what
  // plain messages land in (the legacy thread lane stays for /use reading).
  socket.conversationOpen(conversationID, agentID || undefined).catch((error: unknown) => print(color.yellow(messageOf(error))));
  if (threadID) {
    socket.send({ type: "thread.open", threadID });
    void socket.threadHistory(threadID, 20).catch(() => {});
  }
  print(color.dim(`agni ${options.url} · protocol v${PROTOCOL_VERSION}`));
  print(color.dim("type /help for commands"));
  prompt();
}

// --- one-shot commands (also used by `agni threads` / `agni history`) -------

export async function listThreadsCommand(connection: ChatConnection, limit = 20): Promise<void> {
  const color = makeColors();
  const socket = await connectOrExit(connection);
  try {
    const threads = await socket.threadList(limit);
    printThreads(threads, color);
  } finally {
    socket.close();
  }
}

export async function historyCommand(connection: ChatConnection, threadID: string, limit = 50): Promise<void> {
  const color = makeColors();
  const socket = await connectOrExit(connection);
  try {
    const history = await socket.threadHistory(threadID, limit);
    printHistory(history.threadID, history.title, history.messages, color);
  } finally {
    socket.close();
  }
}

// --- formatting --------------------------------------------------------------

interface Colors {
  dim: (text: string) => string;
  yellow: (text: string) => string;
  cyan: (text: string) => string;
  gold: (text: string) => string;
}

function makeColors(): Colors {
  const enabled = process.stdout.isTTY === true && !Bun.env.NO_COLOR;
  const wrap = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { dim: wrap("2"), yellow: wrap("33"), cyan: wrap("36"), gold: wrap("38;5;179") };
}

function printThreads(threads: ThreadInfo[], color: Colors): void {
  if (threads.length === 0) {
    console.log("(no threads yet)");
    return;
  }
  threads.forEach((thread, index) => {
    const title = thread.title ? `"${thread.title}"` : "(untitled)";
    console.log(
      `${String(index + 1).padStart(3)}. ${thread.id}  ${title}  ${color.dim(`${thread.agentID} · ${shortAge(thread.updatedAt)}`)}`,
    );
  });
}

function printHistory(threadID: string, title: string | undefined, messages: MessageInfo[], color: Colors): void {
  console.log(color.dim(`--- ${threadID}${title ? ` "${title}"` : ""} · ${messages.length} messages ---`));
  printMessages(messages, color);
}

/** The cross-block transcript: a seam line wherever the block id changes. */
function printConversationHistory(messages: MessageInfo[], color: Colors): void {
  console.log(color.dim(`--- conversation · ${messages.length} messages ---`));
  printMessages(messages, color);
}

function printMessages(messages: MessageInfo[], color: Colors): void {
  let previousSession: string | undefined;
  for (const message of messages) {
    if (message.sessionID && previousSession && previousSession !== message.sessionID) {
      console.log(color.dim(`   — new session (${message.sessionID}) —`));
    }
    if (message.sessionID) previousSession = message.sessionID;
    const label = message.role === "user" ? "you " : message.role === "assistant" ? "agni" : message.role.slice(0, 4);
    const text = message.text.length > 2000 ? `${message.text.slice(0, 2000)}…` : message.text;
    console.log(`${label} > ${text.replace(/\n/g, "\n      ")}`);
  }
}

function shortAge(iso: string): string {
  const age = Date.now() - Date.parse(iso);
  if (!Number.isFinite(age) || age < 0) return iso;
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  | ${line}`)
    .join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a secret from the terminal without echoing it. Over SSH this reads the
 * SSH pty directly, so the value never leaves the host's stdin. A non-TTY
 * (piped input) refuses rather than pretending to be secure.
 */
async function connectOrExit(connection: ChatConnection): Promise<AgniSocket> {
  try {
    return await AgniSocket.connect(connection.url, connection.token, connection.device);
  } catch (error) {
    console.error(messageOf(error));
    process.exit(1);
  }
}
