import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface ChannelRow {
  id: string;
  type: string;
  visibility: string;
  name: string;
  agent_id: string;
  parent_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelMemberRow {
  channel_id: string;
  participant_type: string;
  participant_id: string;
  role: string;
}

export interface ChannelMessageRow {
  id: string;
  channel_id: string;
  from_type: string;
  from_id: string;
  to_agent_id: string | null;
  text: string;
  internal: number;
  compacted: number;
  /** Gate salience: temp turns are kept but never compacted (migration 17). */
  salience: string;
  turn_id: string | null;
  ui_hint: string | null;
  peer_influenced?: number;
  created_at: string;
}

export interface ChannelSummaryRow {
  id: string;
  channel_id: string;
  summary: string;
  last_compacted_message_id: string | null;
  token_estimate: number;
  updated_at: string;
}

// --- channels ---------------------------------------------------------------

export function createChannel(
  db: Database,
  input: { type: string; visibility: string; name: string; agentID: string; parentTurnID?: string },
): ChannelRow {
  const row: ChannelRow = {
    id: newID("chn"),
    type: input.type,
    visibility: input.visibility,
    name: input.name,
    agent_id: input.agentID,
    parent_turn_id: input.parentTurnID ?? null,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  db.run(
    `INSERT INTO channels (id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.type, row.visibility, row.name, row.agent_id, row.parent_turn_id, row.created_at, row.updated_at],
  );
  return row;
}

/**
 * The stable DM channel for an agent (`dm:<id>`), created on first use.
 *
 * A delegation can address an agent the owner has never opened a chat with,
 * so the channel cannot be assumed to exist when the specialist replies.
 */
export function ensureDMChannel(db: Database, agentID: string): ChannelRow {
  const id = `dm:${agentID}`;
  const existing = getChannel(db, id);
  if (existing) return existing;
  const row = createChannel(db, { type: "dm", visibility: "public", name: agentID, agentID });
  db.run("UPDATE channels SET id = ? WHERE id = ?", [id, row.id]);
  addChannelMember(db, id, "agent", agentID);
  addChannelMember(db, id, "user", "user");
  return getChannel(db, id) ?? { ...row, id };
}

export function listChannels(db: Database, agentID?: string): ChannelRow[] {
  if (agentID)
    return db
      .query<ChannelRow, [string]>(
        "SELECT id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at FROM channels WHERE agent_id = ? ORDER BY created_at",
      )
      .all(agentID);
  return db
    .query<ChannelRow, []>(
      "SELECT id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at FROM channels ORDER BY created_at",
    )
    .all();
}

export function getChannel(db: Database, id: string): ChannelRow | null {
  return (
    db
      .query<ChannelRow, [string]>(
        "SELECT id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at FROM channels WHERE id = ?",
      )
      .get(id) ?? null
  );
}

export function renameChannel(db: Database, id: string, name: string): void {
  db.run("UPDATE channels SET name = ?, updated_at = ? WHERE id = ?", [name, nowISO(), id]);
}

// --- members ----------------------------------------------------------------

export function addChannelMember(
  db: Database,
  channelID: string,
  participantType: string,
  participantID: string,
  role = "member",
): ChannelMemberRow {
  const row: ChannelMemberRow = {
    channel_id: channelID,
    participant_type: participantType,
    participant_id: participantID,
    role,
  };
  db.run(
    "INSERT OR IGNORE INTO channel_members (channel_id, participant_type, participant_id, role) VALUES (?, ?, ?, ?)",
    [row.channel_id, row.participant_type, row.participant_id, row.role],
  );
  return row;
}

export function listChannelMembers(db: Database, channelID: string): ChannelMemberRow[] {
  return db
    .query<ChannelMemberRow, [string]>(
      "SELECT channel_id, participant_type, participant_id, role FROM channel_members WHERE channel_id = ?",
    )
    .all(channelID);
}

// --- messages ---------------------------------------------------------------

export function appendChannelMessage(
  db: Database,
  input: {
    channelID: string;
    fromType: string;
    fromID: string;
    toAgentID?: string | null;
    text: string;
    internal?: boolean;
    turnID?: string | null;
    uiHint?: string | null;
    /** Gate salience; defaults to recent_turns when the caller does not classify. */
    salience?: string;
    peerInfluenced?: boolean;
  },
): ChannelMessageRow {
  const row: ChannelMessageRow = {
    id: newID("chm"),
    channel_id: input.channelID,
    from_type: input.fromType,
    from_id: input.fromID,
    to_agent_id: input.toAgentID ?? null,
    text: input.text,
    internal: input.internal ? 1 : 0,
    compacted: 0,
    salience: input.salience ?? "recent_turns",
    turn_id: input.turnID ?? null,
    ui_hint: input.uiHint ?? null,
    created_at: nowISO(),
  };
  db.run(
    `INSERT INTO channel_messages (id, channel_id, from_type, from_id, to_agent_id, text, internal, compacted, salience, turn_id, ui_hint, created_at, peer_influenced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.channel_id,
      row.from_type,
      row.from_id,
      row.to_agent_id,
      row.text,
      row.internal,
      row.compacted,
      row.salience,
      row.turn_id,
      row.ui_hint,
      row.created_at,
      input.peerInfluenced ? 1 : 0,
    ],
  );
  return row;
}

export function listChannelMessages(db: Database, channelID: string, limit = 200): ChannelMessageRow[] {
  return db
    .query<ChannelMessageRow, [string, number]>(
      `SELECT id, channel_id, from_type, from_id, to_agent_id, text, internal, compacted, salience, turn_id, ui_hint, created_at
       FROM channel_messages WHERE channel_id = ? ORDER BY created_at, rowid LIMIT ?`,
    )
    .all(channelID, limit);
}

export function uncompactedMessages(db: Database, channelID: string, limit = 200): ChannelMessageRow[] {
  return db
    .query<ChannelMessageRow, [string, number]>(
      `SELECT id, channel_id, from_type, from_id, to_agent_id, text, internal, compacted, salience, turn_id, ui_hint, created_at
       FROM channel_messages WHERE channel_id = ? AND compacted = 0 AND salience <> 'temp' AND from_type <> 'system' AND peer_influenced = 0 ORDER BY created_at, rowid LIMIT ?`,
    )
    .all(channelID, limit);
}

export function markMessagesCompacted(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.run(`UPDATE channel_messages SET compacted = 1 WHERE id IN (${placeholders})`, ids);
}

// --- summaries --------------------------------------------------------------

export function upsertChannelSummary(
  db: Database,
  channelID: string,
  summary: string,
  lastCompactedMessageID?: string | null,
  tokenEstimate = 0,
): ChannelSummaryRow {
  const existing = db
    .query<ChannelSummaryRow, [string]>(
      "SELECT id, channel_id, summary, last_compacted_message_id, token_estimate, updated_at FROM channel_summaries WHERE channel_id = ?",
    )
    .get(channelID);
  const now = nowISO();
  if (existing) {
    db.run(
      "UPDATE channel_summaries SET summary = ?, last_compacted_message_id = ?, token_estimate = ?, updated_at = ? WHERE channel_id = ?",
      [summary, lastCompactedMessageID ?? null, tokenEstimate, now, channelID],
    );
    return { ...existing, summary, last_compacted_message_id: lastCompactedMessageID ?? null, token_estimate: tokenEstimate, updated_at: now };
  }
  const row: ChannelSummaryRow = {
    id: newID("chs"),
    channel_id: channelID,
    summary,
    last_compacted_message_id: lastCompactedMessageID ?? null,
    token_estimate: tokenEstimate,
    updated_at: now,
  };
  db.run("INSERT INTO channel_summaries (id, channel_id, summary, last_compacted_message_id, token_estimate, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
    row.id,
    row.channel_id,
    row.summary,
    row.last_compacted_message_id,
    row.token_estimate,
    row.updated_at,
  ]);
  return row;
}

export function getChannelSummary(db: Database, channelID: string): ChannelSummaryRow | null {
  return (
    db
      .query<ChannelSummaryRow, [string]>(
        "SELECT id, channel_id, summary, last_compacted_message_id, token_estimate, updated_at FROM channel_summaries WHERE channel_id = ?",
      )
      .get(channelID) ?? null
  );
}

// --- groups (Phase 4) -------------------------------------------------------

/** Member bots of a channel, the primary (`channels.agent_id`) first. */
export function channelAgentIDs(db: Database, channel: ChannelRow): string[] {
  const members = db
    .query<{ participant_id: string }, [string]>(
      "SELECT participant_id FROM channel_members WHERE channel_id = ? AND participant_type = 'agent' ORDER BY rowid",
    )
    .all(channel.id)
    .map((row) => row.participant_id);
  return [channel.agent_id, ...members.filter((id) => id !== channel.agent_id)];
}

/** A group channel: the owner plus two or more bots; the first bot is the primary. */
export function createGroupChannel(db: Database, name: string, agentIDs: string[]): ChannelRow {
  const ids = [...new Set(agentIDs)];
  if (ids.length < 2) throw new Error("a group needs two or more different bots");
  return db.transaction(() => {
    const row = createChannel(db, { type: "group", visibility: "public", name, agentID: ids[0]! });
    addChannelMember(db, row.id, "user", "user");
    ids.forEach((id, index) => addChannelMember(db, row.id, "agent", id, index === 0 ? "primary" : "member"));
    return row;
  })();
}

export function listGroupChannels(db: Database): ChannelRow[] {
  return db
    .query<ChannelRow, []>(
      "SELECT id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at FROM channels WHERE type = 'group' ORDER BY created_at",
    )
    .all();
}
