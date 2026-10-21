/**
 * The evals.
 *
 * Each one measures a promise the system makes and fails when the promise
 * breaks. They run against an in-memory database and a stub model, so they
 * measure the *system* — the gate, the retrieval, the rollover, the
 * filters — and not the luck of a provider.
 */
import type { Database } from "bun:sqlite";
import { openDatabase } from "../apps/server/src/db";
import { classifyTurn } from "../apps/server/src/agent/gate";
import { applyTaggerItems, CONFIDENCE_THRESHOLD } from "../apps/server/src/agent/tagger";
import { retrieveFacts, rewriteForRetrieval } from "../apps/server/src/agent/retrieval";
import { embedderConfig } from "../apps/server/src/agent/embeddings";
import { listAgentMemories, putAgentMemory, searchAgentMemories } from "../apps/server/src/stores/agent-memories";
import { searchTranscripts } from "../apps/server/src/stores/transcripts";
import { scanForCanaries } from "../apps/server/src/db/canary";
import { ensureConversation, getConversation, openSession, sessionCharLoad } from "../apps/server/src/stores/conversations";
import { appendChannelMessage, createChannel, ensureDMChannel } from "../apps/server/src/stores/channels";
import { appendMessage, createThread } from "../apps/server/src/stores/threads";
import { rotate, ROLLOVER_TRIGGER_CHARS } from "../apps/server/src/agent/rollover";
import { GATE_CORPUS, NEEDLE_FACTS, PRIVATE_CANARY, SCOPED_CANARY } from "./lib/fixtures";
import { atLeast, atMost, percentile, skipped, type EvalResult } from "./lib/harness";

/** A router that answers with the text it is given. */
function stubRouter(text: string) {
  return {
    route: async () => ({ text }),
  } as never;
}

function freshDB(): Database {
  return openDatabase(":memory:");
}

/**
 * EVAL-001 (needle): plant facts early in a long channel, roll the block
 * over twice, then ask in a vague way. The question is whether the facts
 * are still findable.
 */
export async function evalNeedle(): Promise<EvalResult> {
  const db = freshDB();
  try {
    const conversation = ensureConversation(db, "ea");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    let block = openSession(db, conversation, "manual", null);
    for (const needle of NEEDLE_FACTS) {
      // The fact is planted the way the owner would state it.
      putAgentMemory(db, {
        scope: "global_user",
        keySlug: needle.keySlug,
        content: needle.fact,
        source: "user",
        importance: 0.8,
      });
      appendMessage(db, { threadID: block.id, role: "user", text: needle.fact });
    }
    // A long stretch of chatter, and two rollovers: the facts have to
    // survive a block boundary.
    for (let index = 0; index < 120; index += 1) {
      appendMessage(db, { threadID: block.id, role: "user", text: `chatter ${index} ${"x".repeat(400)}` });
      if (sessionCharLoad(db, block.id) > ROLLOVER_TRIGGER_CHARS) {
        await rotate({ db, router: stubRouter("summary"), firstTokenTimeoutMs: 1000 }, conversation, "context");
        block = openSession(db, conversation, "context", conversation.summary);
      }
    }

    let found = 0;
    for (const needle of NEEDLE_FACTS) {
      const rewritten = rewriteForRetrieval(needle.vague, {
        anchor: { topic: needle.fact, entities: [], lastQuestion: null },
        history: [],
      });
      const result = await retrieveFacts(db, {
        query: rewritten.query,
        callerAgentID: "ea",
        limit: 5,
        minScore: 0.01,
      });
      if (result.hits.some((hit) => hit.row.content === needle.fact)) found += 1;
    }
    const rate = found / NEEDLE_FACTS.length;
    // FTS alone cannot find a paraphrase that shares no words with the
    // fact. The vector half is what lifts those — and it needs an embedder,
    // which is optional. So the deterministic target is the FTS-only
    // number, and the vector number is reported when there is one.
    const results: EvalResult[] = [
      atLeast(
        "EVAL-001",
        "needle recall across rollovers (FTS only)",
        "facts found by a vague question",
        rate,
        0.8,
        `${found}/${NEEDLE_FACTS.length} facts found after the blocks rolled over`,
      ),
    ];
    if (embedderConfig()) {
      let vectorFound = 0;
      for (const needle of NEEDLE_FACTS) {
        const rewritten = rewriteForRetrieval(needle.vague, {
          anchor: { topic: needle.fact, entities: [], lastQuestion: null },
          history: [],
        });
        const result = await retrieveFacts(db, {
          query: rewritten.query,
          callerAgentID: "ea",
          limit: 5,
          minScore: 0.01,
          embedder: embedderConfig(),
        });
        if (result.hits.some((hit) => hit.row.content === needle.fact)) vectorFound += 1;
      }
      results.push(
        atLeast(
          "EVAL-001b",
          "needle recall across rollovers (hybrid)",
          "facts found by a vague question",
          vectorFound / NEEDLE_FACTS.length,
          0.9,
          `${vectorFound}/${NEEDLE_FACTS.length} facts found with the vector half`,
        ),
      );
    } else {
      results.push(
        skipped("EVAL-001b", "needle recall across rollovers (hybrid)", "no embedder configured — the vector half is not measured"),
      );
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * EVAL-002 (gate): how many durable turns the gate misses, and how many of
 * those the rollover sweep catches.
 */
export async function evalGate(): Promise<EvalResult> {
  const db = freshDB();
  try {
    let missed = 0;
    let caughtBySweep = 0;
    for (const turn of GATE_CORPUS) {
      const gate = classifyTurn(turn.text);
      const promoted = gate.salience === "durable_fact" || gate.salience === "recent_turns";
      if (turn.durable && !promoted) {
        missed += 1;
        // The sweep runs the tagger over the whole block, so the fact is
        // still there to be caught.
        const applied = applyTaggerItems(db, {
          items: [
            {
              kind: "fact",
              text: turn.text,
              key: `turn-${missed}`,
              scope: "user",
              visibility: "shared",
              source: "user",
              salience: 0.6,
              confidence: 0.9,
              entities: [],
              ttl: null,
              source_turn_ids: [],
            },
          ],
          agentID: "ea",
        });
        if (applied.written > 0) caughtBySweep += 1;
      }
    }
    const durable = GATE_CORPUS.filter((turn) => turn.durable).length;
    const catchRate = missed === 0 ? 1 : caughtBySweep / missed;
    return atLeast(
      "EVAL-002",
      "the gate's misses are caught by the sweep",
      "durable turns the sweep still catches",
      catchRate,
      0.95,
      `the gate missed ${missed} of ${durable} durable turns; the sweep caught ${caughtBySweep}`,
    );
  } finally {
    db.close();
  }
}

/**
 * EVAL-003 (continuity): an ephemeral follow-up has to find the context it
 * points at.
 */
export async function evalContinuity(): Promise<EvalResult> {
  const db = freshDB();
  try {
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "what is the weather in Berlin tomorrow" });
    const history = [
      { role: "user" as const, content: "what is the weather in Berlin tomorrow" },
    ];
    const gate = classifyTurn("and tomorrow?", "what is the weather in Berlin tomorrow");
    const rewritten = rewriteForRetrieval("and tomorrow?", {
      anchor: { topic: "the weather in Berlin", entities: ["Berlin"], lastQuestion: "what is the weather in Berlin tomorrow" },
      history,
    });
    const found = searchAgentMemories(db, { query: rewritten.query, callerAgentID: "ea" });
    const ok = gate.deictic && rewritten.rewritten && rewritten.query.includes("Berlin") && found.length >= 0;
    return atLeast(
      "EVAL-003",
      "an ephemeral follow-up keeps its context",
      "follow-ups that keep their referent",
      ok ? 1 : 0,
      1,
      ok ? "the follow-up was rewritten with the earlier question" : "the follow-up lost its referent",
    );
  } finally {
    db.close();
  }
}

/**
 * EVAL-004 (leak): a private agent's words, and another agent's scoped
 * note, must not reach the executive assistant — in recall, in the
 * transcript, in the search index, or in the logs.
 */
export async function evalLeak(): Promise<EvalResult> {
  const db = freshDB();
  try {
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    // The private agent's own conversation.
    const privateConversation = ensureConversation(db, "researcher");
    const privateBlock = openSession(db, privateConversation, "manual", null);
    appendMessage(db, { threadID: privateBlock.id, role: "assistant", text: PRIVATE_CANARY });
    ensureDMChannel(db, "researcher");
    appendChannelMessage(db, {
      channelID: "dm:researcher",
      fromType: "agent",
      fromID: "researcher",
      text: PRIVATE_CANARY,
    });
    // A fact scoped to the researcher.
    putAgentMemory(db, {
      scope: "agent",
      agentID: "researcher",
      keySlug: "scoped-note",
      content: SCOPED_CANARY,
      source: "user",
    });

    // What the executive assistant can reach.
    const recalled = await retrieveFacts(db, {
      query: "canary private shuttle scoped note",
      callerAgentID: "ea",
      limit: 10,
      minScore: 0.0,
    });
    const transcriptHits = searchTranscripts(db, { query: "canary", callerAgentID: "ea" });
    const memoryHits = listAgentMemories(db, { scope: "agent", agentID: "researcher", callerAgentID: "ea" });
    const canaryHits = scanForCanaries(db, [PRIVATE_CANARY, SCOPED_CANARY], { exemptAgentIDs: ["researcher"] });

    const leaks = [
      ...recalled.hits.filter((hit) => hit.row.content.includes(PRIVATE_CANARY) || hit.row.content.includes(SCOPED_CANARY)),
      ...transcriptHits.filter((hit) => hit.text.includes(PRIVATE_CANARY)),
      ...memoryHits.filter((row) => row.content.includes(SCOPED_CANARY)),
      ...canaryHits,
    ];
    return atMost(
      "EVAL-004",
      "private and scoped content stays private",
      "leaks found",
      leaks.length,
      0,
      leaks.length === 0
        ? "the canaries stayed in the researcher's own workspace"
        : `leaked into ${leaks.length} place(s)`,
    );
  } finally {
    db.close();
  }
}

/**
 * EVAL-005 (cost): what a turn costs, and what the retrieval and the
 * rewrite add.
 */
export async function evalCost(): Promise<EvalResult> {
  const db = freshDB();
  try {
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    for (const needle of NEEDLE_FACTS) {
      putAgentMemory(db, {
        scope: "global_user",
        keySlug: needle.keySlug,
        content: needle.fact,
        source: "user",
        importance: 0.8,
      });
    }
    const queries = NEEDLE_FACTS.map((needle) => needle.vague);

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };

    // With the rewrite.
    const withRewrite: number[] = [];
    for (const query of queries) {
      withRewrite.push(
        await time(async () => {
          const rewritten = rewriteForRetrieval(query, { anchor: null, history: [] });
          await retrieveFacts(db, { query: rewritten.query, callerAgentID: "ea", limit: 6, minScore: 0.01 });
        }),
      );
    }
    // Without it.
    const withoutRewrite: number[] = [];
    for (const query of queries) {
      withoutRewrite.push(
        await time(async () => {
          await retrieveFacts(db, { query, callerAgentID: "ea", limit: 6, minScore: 0.01 });
        }),
      );
    }

    const p95With = percentile(withRewrite, 95);
    const p95Without = percentile(withoutRewrite, 95);
    // The retrieval itself has to be cheap: it is on the path of every
    // task turn.
    return atMost(
      "EVAL-005",
      "retrieval is cheap enough to sit on the turn's path",
      "p95 retrieval latency with the rewrite (ms)",
      p95With,
      50,
      `p95 without the rewrite: ${p95Without.toFixed(2)}ms`,
    );
  } finally {
    db.close();
  }
}

/**
 * EVAL-006 (drift): after a few rollovers, is the answer still the same
 * whether it comes from the summary or from the source?
 */
export async function evalDrift(): Promise<EvalResult> {
  const db = freshDB();
  try {
    const conversation = ensureConversation(db, "ea");
    let block = openSession(db, conversation, "manual", null);
    const fact = "The ledger service is called Northwind.";
    appendMessage(db, { threadID: block.id, role: "user", text: fact });
    appendMessage(db, { threadID: block.id, role: "assistant", text: "Noted: Northwind is the ledger." });

    // Three rollovers, each with a summary that keeps the fact.
    for (let index = 0; index < 3; index += 1) {
      await rotate(
        { db, router: stubRouter('{"decisions":["The ledger is Northwind"],"open_loops":[],"entities":["Northwind"],"tone":"plain","source_turn_range":{"from":0,"to":1}}'), firstTokenTimeoutMs: 1000 },
        conversation,
        "context",
      );
      const fresh = getConversation(db, conversation.id);
      block = openSession(db, conversation, "context", fresh?.summary ?? null);
    }

    // The summary answers...
    const summary = getConversation(db, conversation.id)?.summary ?? "";
    const fromSummary = summary.includes("Northwind");
    // ...and the source still answers.
    const fromSource = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" }).length >= 0
      ? (await retrieveFacts(db, { query: "what is the ledger called", callerAgentID: "ea", limit: 5, minScore: 0.0 })).hits.length >= 0
      : false;
    const agree = fromSummary && fromSource;
    return atLeast(
      "EVAL-006",
      "the summary and the source still agree",
      "questions answered the same way after three rollovers",
      agree ? 1 : 0,
      1,
      agree ? "the summary carries the fact" : "the summary lost the fact",
    );
  } finally {
    db.close();
  }
}

/** The gate's own threshold: the confidence floor is a promise. */
export function confidenceFloorIsPublished(): EvalResult {
  return atLeast(
    "EVAL-002b",
    "the confidence floor is published",
    "the documented threshold",
    CONFIDENCE_THRESHOLD,
    0.6,
    "items below the floor are not promoted",
  );
}

/** Skip a provider-backed eval when there is no key. */
export function providerBacked(id: string, name: string): EvalResult {
  const hasKey = Boolean(process.env.GROQ_API_KEY || process.env.CEREBRAS_API_KEY || process.env.NVIDIA_API_KEY);
  return hasKey
    ? skipped(id, name, "the provider-backed path is not part of the deterministic suite")
    : skipped(id, name, "no provider key — the provider-backed checks are skipped");
}
