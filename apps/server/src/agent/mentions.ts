/**
 * `@agent` addressing for the chat surface.
 *
 * The owner talks to bots the way they talk to people: a leading mention
 * means "this message is for that bot". Routing happens here, before the turn
 * starts, so the message is appended to the addressed agent's DM rather than
 * to whatever channel the client happened to have open. The executive
 * assistant is bypassed entirely — a direct mention never goes through it.
 */
import type { Database } from "bun:sqlite";
import { PERSONAS, canonicalAgentID } from "./personas";

export interface AgentMention {
  /** Canonical roster id (for example `researcher`). */
  agentID: string;
  /** The message with the leading `@name` removed. */
  text: string;
}

interface Candidate {
  id: string;
  names: string[];
}

/**
 * Resolve a leading `@name` or `@id` against the live roster.
 *
 * Longest names match first, so `@research bot` beats `@research`, and the
 * mention must end at a word boundary (so `@fridayish` is not a match). The
 * live `display_name` is matched too — the owner types the name they see in
 * the sidebar, not the internal id.
 */
export function resolveAgentMention(db: Database, text: string): AgentMention | null {
  const prefix = /^\s*@/.exec(text);
  if (!prefix) return null;
  const after = text.slice(prefix[0].length);
  if (!after) return null;

  const candidates: Candidate[] = PERSONAS.map((persona) => {
    const row = db
      .query<{ display_name: string | null }, [string]>("SELECT display_name FROM agents WHERE id = ?")
      .get(persona.id);
    const names = [persona.id, persona.name, ...(persona.id === "ea" ? ["agni"] : []), row?.display_name?.trim() ?? ""]
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    return { id: canonicalAgentID(persona.id), names: [...new Set(names)] };
  }).sort((a, b) => longest(b.names) - longest(a.names));

  const lowered = after.toLowerCase();
  for (const candidate of candidates) {
    for (const name of candidate.names) {
      if (!lowered.startsWith(name)) continue;
      const boundary = after.slice(name.length);
      // A mention ends at whitespace or punctuation; `@fridayish` is a typo,
      // not a message to Friday.
      if (boundary !== "" && !/^[\s,:;.!?-]/.test(boundary)) continue;
      const stripped = boundary.replace(/^[\s,:;.!?-]+/, "").trim();
      return { agentID: candidate.id, text: stripped || text.trim() };
    }
  }
  return null;
}

function longest(names: string[]): number {
  return names.reduce((max, name) => Math.max(max, name.length), 0);
}
