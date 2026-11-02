/**
 * Minimal SMTP client over TLS (port 465). Sends one email.
 */
import tls from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

const CRLF_RE = /[\r\n\0]/;

export function checkHeaderValue(name: string, v: unknown): string {
  if (typeof v !== "string" || CRLF_RE.test(v)) throw new Error(`invalid ${name}`);
  return v;
}

export function checkAddress(v: unknown): string {
  const a = checkHeaderValue("address", v);
  if (!/^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(a)) throw new Error("invalid address");
  return a;
}

/** to/cc/bcc: a string becomes [string]; anything else is rejected. */
export function normalizeRecipients(v: unknown): string[] {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length === 0) throw new Error("recipients must be an array of strings");
  return list.map(checkAddress);
}

/** CRLF-normalise and dot-stuff a body (RFC 5321 4.5.2). */
export function dotStuff(body: string): string {
  return body.replace(/\r\n|\r|\n/g, "\r\n").replace(/^\./gm, "..");
}

export async function sendEmail(
  cfg: SmtpConfig,
  from: string,
  to: string[],
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    from = checkAddress(from);
    to = normalizeRecipients(to);
    subject = checkHeaderValue("subject", subject);
    body = dotStuff(String(body));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return new Promise((resolve) => {
    let rcptIdx = 0;
    const socket = tls.connect(cfg.port, cfg.host, { rejectUnauthorized: true });
    let buffer = "";
    let state = "greeting"; // greeting -> ehlo -> auth -> mailfrom -> rcpt -> data -> content -> quit

    const send = (line: string) => socket.write(line + "\r\n");

    socket.on("data", (data) => { try { onData(data); } catch (e) {
      socket.destroy();
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } });

    const onData = (data: string | Buffer) => {
      buffer += data.toString();
      // Wait for complete response (last line starts with code + space, not code + -)
      const lines = buffer.split("\r\n").filter(Boolean);
      const lastLine = lines[lines.length - 1] || "";
      if (/^\d{3}-/.test(lastLine)) return; // multi-line, wait for more

      const code = parseInt(lastLine.slice(0, 3), 10);
      if (isNaN(code)) return;

      buffer = ""; // reset for next command

      if (code >= 400) {
        socket.destroy();
        resolve({ ok: false, error: `SMTP ${code}: ${lastLine}` });
        return;
      }

      switch (state) {
        case "greeting":
          state = "ehlo";
          send("EHLO agni");
          break;
        case "ehlo":
          state = "auth";
          send("AUTH LOGIN");
          break;
        case "auth":
          state = "user";
          send(Buffer.from(cfg.user).toString("base64"));
          break;
        case "user":
          state = "pass";
          send(Buffer.from(cfg.pass).toString("base64"));
          break;
        case "pass":
          state = "mailfrom";
          send(`MAIL FROM:<${from}>`);
          break;
        case "mailfrom":
          state = "rcpt";
          send(`RCPT TO:<${to[rcptIdx++]}>`);
          break;
        case "rcpt":
          // One RCPT at a time; DATA only after every recipient is accepted.
          if (rcptIdx < to.length) send(`RCPT TO:<${to[rcptIdx++]}>`);
          else { state = "data"; send("DATA"); }
          break;
        case "data":
          state = "content";
          // Send headers + body + terminator
          const msg = [
            `From: ${from}`,
            `To: ${to.join(", ")}`,
            `Subject: ${subject}`,
            `Content-Type: text/plain; charset=utf-8`,
            `MIME-Version: 1.0`,
            ``,
            body,
            `.`,
          ].join("\r\n");
          socket.write(msg + "\r\n");
          break;
        case "content":
          state = "quit";
          send("QUIT");
          break;
        case "quit":
          socket.destroy();
          resolve({ ok: true });
          break;
      }
    };

    socket.on("error", (err) => {
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });

    setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "SMTP timeout" });
    }, 30000);
  });
}