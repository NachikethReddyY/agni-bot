import { describe, expect, test } from "bun:test";
import { assembleContext, clampToBudget, deriveAnchor, DEFAULT_SLOT_BUDGETS } from "../src/context/compiler";

describe("context assembler", () => {
  test("emits slots in the stable order", () => {
    const prefix = assembleContext({
      personaPrompt: "PERSONA",
      laneHeader: "LANE",
      facts: ["FACT-1"],
      anchor: { topic: "ANCHOR-TOPIC", entities: ["Raft"], lastQuestion: "why?" },
      ledger: ["LEDGER-1"],
      summaries: ["SUMMARY-1"],
      recall: ["RECALL-1"],
      tail: ["TAIL-1"],
    });
    const order = ["PERSONA", "FACT-1", "ANCHOR-TOPIC", "LEDGER-1", "SUMMARY-1", "RECALL-1", "TAIL-1"].map((marker) =>
      prefix.indexOf(marker),
    );
    for (const position of order) expect(position).toBeGreaterThanOrEqual(0);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });

  test("empty slots disappear without leaving blank headers", () => {
    const prefix = assembleContext({ personaPrompt: "P", laneHeader: "L" });
    expect(prefix).toBe("P\n\nL");
  });

  test("clamps a slot to its budget", () => {
    const long = "x".repeat(DEFAULT_SLOT_BUDGETS.summaries * 4 + 100);
    const prefix = assembleContext({ personaPrompt: "P", laneHeader: "L", summaries: [long] });
    const body = prefix.split("Summary of earlier context (server-written, untrusted):\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(DEFAULT_SLOT_BUDGETS.summaries * 4 + 1);
    expect(body.endsWith("…")).toBe(true);
  });

  test("clampToBudget leaves short text untouched", () => {
    expect(clampToBudget("short", 100)).toBe("short");
  });
});

describe("anchor derivation", () => {
  test("captures topic, entities and the last question", () => {
    const anchor = deriveAnchor({
      carrySummary: "We compared Raft and Paxos for the storage layer.",
      history: [
        { role: "user", content: "How does Raft handle split votes?" },
        { role: "assistant", content: "It retries with randomized timeouts." },
      ],
      userText: "Can you explain option 2 again?",
    });
    expect(anchor?.topic).toContain("Raft and Paxos");
    expect(anchor?.entities).toContain("Raft");
    expect(anchor?.lastQuestion).toBe("Can you explain option 2 again?");
  });

  test("returns null when there is nothing to anchor on", () => {
    expect(deriveAnchor({ history: [], userText: "" })).toBeNull();
  });
});
