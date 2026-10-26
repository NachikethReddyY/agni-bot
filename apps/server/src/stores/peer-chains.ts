import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { nowISO } from "../util/ids";

export function fingerprintPeerRequest(from: string, to: string, intent: string, text: string): string {
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${from}|${to}|${intent}|${normalised}`).digest("hex").slice(0, 16);
}

export function checkPeerRequest(db: Database, chainID: string, fingerprint: string): "ok" | "retry" | "stop" {
  return db.transaction((): "ok" | "retry" | "stop" => {
    const now = nowISO();
    db.run("INSERT OR IGNORE INTO peer_chains(id, created_at) VALUES(?, ?)", [chainID, now]);
    let chain = db.query<{ retried: number; stopped_at: string | null }, [string]>(
      "SELECT retried, stopped_at FROM peer_chains WHERE id = ?",
    ).get(chainID);
    if (!chain) {
      db.run("INSERT INTO peer_chains(id, created_at) VALUES(?, ?)", [chainID, now]);
      chain = db.query<{ retried: number; stopped_at: string | null }, [string]>(
        "SELECT retried, stopped_at FROM peer_chains WHERE id = ?",
      ).get(chainID);
    }
    if (!chain) throw new Error("failed to initialize peer chain");
    if (chain.stopped_at) return "stop";
    const prior = db.query("SELECT 1 FROM peer_chain_messages WHERE chain_id = ? AND fingerprint = ?")
      .get(chainID, fingerprint);
    if (prior) {
      if (chain.retried === 0) {
        db.run("UPDATE peer_chains SET retried = 1 WHERE id = ?", [chainID]);
        return "retry";
      }
      db.run("UPDATE peer_chains SET stopped_at = ? WHERE id = ?", [now, chainID]);
      return "stop";
    }
    db.run("INSERT INTO peer_chain_messages(chain_id, fingerprint, created_at) VALUES(?, ?, ?)", [chainID, fingerprint, now]);
    return "ok";
  })();
}
