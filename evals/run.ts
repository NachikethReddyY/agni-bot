/**
 * `bun run eval` — the acceptance suite.
 *
 * The deterministic evals run everywhere. The nightly run (`bun run
 * eval:nightly`) adds the provider-backed checks and turns the latency
 * budget from a warning into a failure.
 */
import { runEvals } from "./lib/harness";
import {
  confidenceFloorIsPublished,
  evalContinuity,
  evalCost,
  evalDrift,
  evalGate,
  evalLeak,
  evalNeedle,
  providerBacked,
} from "./evals";

const nightly = process.env.AGNI_EVAL_NIGHTLY === "1";

const report = await runEvals([
  { id: "EVAL-001", name: "needle recall", run: evalNeedle },
  { id: "EVAL-002", name: "gate misses and the sweep", run: async () => [await evalGate(), confidenceFloorIsPublished()] },
  { id: "EVAL-003", name: "continuity", run: evalContinuity },
  { id: "EVAL-004", name: "leaks", run: evalLeak },
  { id: "EVAL-005", name: "cost and latency", run: evalCost },
  { id: "EVAL-006", name: "drift", run: evalDrift },
  { id: "EVAL-007", name: "provider-backed quality", run: async () => providerBacked("EVAL-007", "the provider-backed checks") },
]);

if (nightly) {
  console.log("\n(nightly: the latency budget is a failure, not a warning)");
}

if (report.failed > 0) process.exit(1);
