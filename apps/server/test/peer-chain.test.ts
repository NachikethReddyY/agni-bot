import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { enterDelegation, rootGuardrail } from "../src/agent/guardrails";
import { checkPeerRequest, fingerprintPeerRequest } from "../src/stores/peer-chains";

describe("peer request chains", () => {
  test("owner roots are unique and delegation retains its chain", () => {
    const first = rootGuardrail("owner");
    const second = rootGuardrail("owner");
    expect(first.chainID).not.toBe(second.chainID);
    expect(enterDelegation(first, "specialist", null).chainID).toBe(first.chainID);
  });

  test("retries once, then stops the chain; distinct requests have no hop cap", () => {
    const db = openDatabase(":memory:");
    const first = rootGuardrail("owner").chainID;
    const fingerprint = fingerprintPeerRequest("a", "b", "request", "same request");
    expect(checkPeerRequest(db, first, fingerprint)).toBe("ok");
    expect(checkPeerRequest(db, first, fingerprint)).toBe("retry");
    expect(checkPeerRequest(db, first, fingerprint)).toBe("stop");
    expect(checkPeerRequest(db, first, fingerprintPeerRequest("a", "b", "request", "new request"))).toBe("stop");
    const chain = rootGuardrail("owner").chainID;
    for (let i = 0; i < 15; i++) {
      expect(checkPeerRequest(db, chain, fingerprintPeerRequest("a", "b", "request", `request ${i}`))).toBe("ok");
    }
    expect(checkPeerRequest(db, rootGuardrail("owner").chainID, fingerprint)).toBe("ok");
    db.close();
  });
});
