/**
 * `bun run scan:canary` — the leak detector for EVAL-004.
 *
 * After a run that planted canary strings (a private agent's words), this
 * checks the places a private agent's text must never reach: the
 * model-visible transcript, durable facts, delegation rows, thread titles,
 * carried summaries, and the log file.
 *
 * The owner-facing transcript is deliberately not scanned: the owner opens
 * the agent's DM directly, and that is the point of a private agent.
 *
 *   AGNI_CANARY="CANARY-ONE,CANARY-TWO" bun run scan:canary
 *   AGNI_DB_PATH=data/agni.sqlite AGNI_LOG_PATH=data/agni.log bun run scan:canary
 */
import { openDatabase } from "../apps/server/src/db";
import { scanForCanaries } from "../apps/server/src/db/canary";

function argCanaries(): string[] {
  const flag = process.argv.find((arg) => arg.startsWith("--canary="));
  if (flag) return flag.slice("--canary=".length).split(",").map((value) => value.trim()).filter(Boolean);
  return (process.env.AGNI_CANARY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const canaries = argCanaries();
if (canaries.length === 0) {
  console.error("no canaries given — set AGNI_CANARY or pass --canary=one,two");
  process.exit(2);
}

const dbPath = process.env.AGNI_DB_PATH?.trim() || "data/agni.sqlite";
const logPath = process.env.AGNI_LOG_PATH?.trim() || "data/agni.log";

const db = openDatabase(dbPath);
let logText: string | undefined;
try {
  logText = await Bun.file(logPath).text();
} catch {
  logText = undefined;
}

const hits = scanForCanaries(db, canaries, logText === undefined ? {} : { logText });
db.close();

if (hits.length === 0) {
  console.log(`clean — ${canaries.length} canary string(s) found in no model-visible sink`);
  process.exit(0);
}

console.error(`LEAK — ${hits.length} hit(s) for ${canaries.length} canary string(s):`);
for (const hit of hits) console.error(`  ${hit.sink} ${hit.rowID} (${hit.column}) contains "${hit.canary}"`);
process.exit(1);
