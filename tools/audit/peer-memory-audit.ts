#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { auditPeerMemory } from "../../apps/server/src/audit/peer-memory";
import { existsSync } from "fs";

function main() {
  const dbPath = process.argv[2] || process.env.AGNI_DB_PATH;

  if (!dbPath) {
    console.error("Usage: peer-memory-audit.ts <database-path> or set AGNI_DB_PATH");
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.error(`Database file does not exist: ${dbPath}`);
    process.exit(1);
  }

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    console.error(`Failed to open database: ${error}`);
    process.exit(1);
  }

  try {
    const result = auditPeerMemory(db);
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}

main();
