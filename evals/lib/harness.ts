/**
 * The eval harness.
 *
 * Every eval answers one question about the system, prints a number, and
 * fails when the number misses its target. The targets are the spec's
 * promises; the numbers are measurements, not opinions.
 *
 * The deterministic evals run everywhere (CI included). The nightly ones
 * need a real provider and are skipped when there is no key.
 */

export interface EvalResult {
  id: string;
  name: string;
  /** The measurement, and what it was measured against. */
  metric: string;
  value: number;
  target: number;
  /** Which direction the target goes: "at least" or "at most". */
  direction: "at least" | "at most";
  passed: boolean;
  /** A line of context for a human reading the report. */
  note?: string;
  skipped?: boolean;
}

export interface EvalReport {
  results: EvalResult[];
  skipped: number;
  failed: number;
  passed: number;
}

/** Run the evals and print a report. Returns the report. */
export async function runEvals(
  suite: Array<{ id: string; name: string; run: () => Promise<EvalResult | EvalResult[]> }>,
): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const item of suite) {
    const started = Date.now();
    let outcome: EvalResult | EvalResult[];
    try {
      outcome = await item.run();
    } catch (error) {
      outcome = {
        id: item.id,
        name: item.name,
        metric: "the eval ran",
        value: 0,
        target: 1,
        direction: "at least",
        passed: false,
        note: error instanceof Error ? error.message : String(error),
      };
    }
    const list = Array.isArray(outcome) ? outcome : [outcome];
    for (const result of list) {
      results.push(result);
      const took = Date.now() - started;
      const mark = result.skipped ? "skip" : result.passed ? " pass" : " FAIL";
      console.log(
        `${mark}  ${result.id}  ${result.name}\n        ${result.metric}: ${result.value}` +
          ` (target ${result.direction} ${result.target})` +
          (result.note ? `\n        ${result.note}` : "") +
          (took > 50 ? `\n        ${took}ms` : ""),
      );
    }
  }
  const failed = results.filter((result) => !result.passed && !result.skipped).length;
  const skipped = results.filter((result) => result.skipped).length;
  const passed = results.length - failed - skipped;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  return { results, skipped, failed, passed };
}

/** Build a result and decide whether it passed. */
export function atLeast(
  id: string,
  name: string,
  metric: string,
  value: number,
  target: number,
  note?: string,
): EvalResult {
  return {
    id,
    name,
    metric,
    value: Number(value.toFixed(4)),
    target,
    direction: "at least",
    passed: value >= target,
    ...(note ? { note } : {}),
  };
}

export function atMost(
  id: string,
  name: string,
  metric: string,
  value: number,
  target: number,
  note?: string,
): EvalResult {
  return {
    id,
    name,
    metric,
    value: Number(value.toFixed(4)),
    target,
    direction: "at most",
    passed: value <= target,
    ...(note ? { note } : {}),
  };
}

export function skipped(id: string, name: string, why: string): EvalResult {
  return {
    id,
    name,
    metric: "skipped",
    value: 0,
    target: 0,
    direction: "at least",
    passed: true,
    skipped: true,
    note: why,
  };
}

/** The percentile of a list of numbers. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}
