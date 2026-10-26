/**
 * Schema migrations. Append only: never edit an applied migration — add a new
 * numbered one instead. Applied inside a transaction; ids are recorded in
 * `schema_migrations`.
 *
 * FTS5 note: the search indexes are standalone (not external-content), so the
 * write path inserts into both the table and its index — one obvious write
 * path, no trigger magic. See docs/architecture.md (S2/S4).
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL,              -- running | done
        stop_reason TEXT,                 -- end | cancelled | error | timeout | budget
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX idx_turns_thread ON turns(thread_id, started_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL,               -- user | assistant | system | tool
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

      CREATE TABLE usage_ledger (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        day TEXT NOT NULL,                -- YYYY-MM-DD (UTC) for per-day caps
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_usage_day ON usage_ledger(day, provider);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        turn_id TEXT,
        action TEXT NOT NULL,
        preview TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | decided
        decision TEXT,                            -- once | always | reject
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        due_at TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'open',      -- open | done | snoozed
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE links (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        note TEXT,
        tags TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        summary TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT,
        state TEXT NOT NULL DEFAULT 'queued',     -- queued | running | done | failed
        run_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_state ON jobs(state, run_at);

      -- Write-time search indexes (S2: memory is a tool, S4: index at ingest).
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text, summary);
      CREATE VIRTUAL TABLE links_fts USING fts5(id UNINDEXED, title, summary, note, tags);
    `,
  },
  {
    id: 2,
    name: "jobs_result",
    sql: `
      ALTER TABLE jobs ADD COLUMN result TEXT;
    `,
  },
  {
    id: 3,
    name: "jobs_enabled",
    sql: `
      -- Routines can be paused from the client without deleting them.
      ALTER TABLE jobs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    id: 4,
    name: "scale_query_indexes",
    sql: `
      CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
      CREATE INDEX idx_jobs_claim ON jobs(state, enabled, run_at);
    `,
  },
  {
    id: 5,
    name: "p2_store_fields_and_indexes",
    sql: `
      ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;
      ALTER TABLE tasks ADD COLUMN owner_device_id TEXT;
      ALTER TABLE memories ADD COLUMN owner_device_id TEXT;
      ALTER TABLE links ADD COLUMN owner_device_id TEXT;
      DROP TABLE memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text, summary, tags);
      INSERT INTO memories_fts(id, text, summary, tags)
        SELECT id, text, coalesce(summary, ''), coalesce(tags, '') FROM memories;
      DROP TABLE links_fts;
      CREATE VIRTUAL TABLE links_fts USING fts5(id UNINDEXED, title, summary, note, tags);
      INSERT INTO links_fts(id, title, summary, note, tags)
        SELECT id, coalesce(title, ''), coalesce(summary, ''), coalesce(note, ''), coalesce(tags, '') FROM links;
      CREATE INDEX idx_links_url ON links(url);
      CREATE INDEX idx_tasks_status_due ON tasks(status, due_at, snoozed_until);
      CREATE TABLE brief_runs (
        local_date TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        notification_sent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 6,
    name: "p3_tool_calls_and_sessions",
    sql: `
      -- Durable tool-call records: one row per tool invocation in a task lane turn.
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args TEXT NOT NULL,
        result TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id, created_at);

      -- Durable session state for long-running task turns: the raw model
      -- message array, compaction summaries, and the HITL approval ledger.
      CREATE TABLE agent_sessions (
        thread_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        state TEXT NOT NULL,            -- running | awaiting_approval | done | failed
        message_log TEXT NOT NULL,      -- JSON array of ChatMessage + tool records
        summary TEXT,                   -- compaction summary of pruned history
        step_count INTEGER NOT NULL DEFAULT 0,
        token_count INTEGER NOT NULL DEFAULT 0,
        max_steps INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_agent_sessions_turn ON agent_sessions(turn_id);

      -- HITL approval ledger: one row per pending approval request.
      ALTER TABLE approvals ADD COLUMN call_id TEXT;
      ALTER TABLE approvals ADD COLUMN tool_name TEXT;
    `,
  },
  {
    id: 7,
    name: "conversations_and_session_blocks",
    sql: `
      -- The conversation model: one conversation per agent is the user-facing
      -- chat; each row of threads becomes an invisible session block (a
      -- context span) inside it. active_thread_id is the live block;
      -- summary is the bounded carried summary text the next block opens
      -- with. Existing threads backfill into one conversation per agent.
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        active_thread_id TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE threads ADD COLUMN conversation_id TEXT;
      ALTER TABLE threads ADD COLUMN closed_at TEXT;
      -- manual (/new) | context (rollover at pressure) | background (job turn)
      ALTER TABLE threads ADD COLUMN closed_by TEXT;
      -- The carried summary this block opened with (debuggability only).
      ALTER TABLE threads ADD COLUMN opened_carry TEXT;
      CREATE INDEX idx_threads_conversation ON threads(conversation_id, created_at);

      INSERT INTO conversations (id, agent_id, created_at, updated_at)
        SELECT 'cnv_' || lower(hex(randomblob(8))), agent_id, min(created_at), max(updated_at)
        FROM threads GROUP BY agent_id;

      UPDATE threads
        SET conversation_id = (SELECT c.id FROM conversations c WHERE c.agent_id = threads.agent_id);

            UPDATE conversations SET active_thread_id = (
        SELECT t.id FROM threads t
        WHERE t.conversation_id = conversations.id
        ORDER BY t.updated_at DESC, t.created_at DESC LIMIT 1
      );
    `,
  },
  {
    id: 8,
    name: "plugin_connections",
    sql: `
      -- One row per catalog plugin bound to one account (agent's own vs the
      -- owner's). Tokens stay here, server-side only — the daemon host is the
      -- trust boundary; clients only ever see the frame snapshot which never
      -- carries them.
      CREATE TABLE plugin_connections (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        account TEXT NOT NULL,                       -- agent | owner
        status TEXT NOT NULL DEFAULT 'disconnected', -- pending | connected | error | disconnected
        account_label TEXT,                          -- the signed-in email
        scopes TEXT,                                 -- JSON array actually granted
        capabilities TEXT,                           -- JSON policy snapshot at connect time
        tokens TEXT,                                 -- JSON {state?, refresh_token?, access_token?, expires_at?}
        error TEXT,
        grant_started_at TEXT,
        connected_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(plugin_id, account)
      );
      CREATE INDEX idx_plugin_connections_status ON plugin_connections(status);
    `,
  },
  {
    id: 9,
    name: "channels_agents_memory",
    sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_channels_agent ON channels(agent_id);

      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        turn_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_channel_messages_channel ON channel_messages(channel_id, created_at);
    `,
  },
  {
    id: 10,
    name: "master_spec_channels_agents_memories",
    sql: `
      ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';
      ALTER TABLE agents ADD COLUMN default_name TEXT;
      ALTER TABLE agents ADD COLUMN display_name TEXT;
      ALTER TABLE agents ADD COLUMN system_prompt TEXT;
      ALTER TABLE agents ADD COLUMN avatar_color TEXT;
      ALTER TABLE agents ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'dm';
      ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
      ALTER TABLE channels ADD COLUMN parent_turn_id TEXT;

      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        member_type TEXT NOT NULL DEFAULT 'agent',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, member_id)
      );

      ALTER TABLE channel_messages ADD COLUMN from_type TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE channel_messages ADD COLUMN from_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE channel_messages ADD COLUMN to_agent_id TEXT;
      ALTER TABLE channel_messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE channel_messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_channel_messages_channel2 ON channel_messages(channel_id, created_at);

      CREATE TABLE IF NOT EXISTS channel_summaries (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'agent',
        agent_id TEXT NOT NULL,
        key_slug TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, key_slug)
      );

      INSERT OR IGNORE INTO agents (id, name, role, default_name, display_name, system_prompt, avatar_color, onboarded, created_at, updated_at) VALUES
        ('ea', 'Agni Bot', 'orchestrator', 'Agni Bot', 'Agni Bot', 'You are the executive assistant.', '#c96442', 0, datetime('now'), datetime('now')),
        ('researcher', 'Researcher', 'agent', 'Researcher', 'Researcher', 'You are the researcher.', '#4a90d9', 0, datetime('now'), datetime('now')),
        ('coder', 'Coder', 'agent', 'Coder', 'Coder', 'You are the coder.', '#4caf50', 0, datetime('now'), datetime('now')),
        ('analyst', 'Analyst', 'agent', 'Analyst', 'Analyst', 'You are the analyst.', '#9c27b0', 0, datetime('now'), datetime('now'));
    `,
  },
  {
    id: 11,
    name: "agent_memories_semantic_key",
    sql: `
      -- Finalize agent_memories: agent_id is nullable for global memories,
      -- add type/tags/importance, rename text→content, and enforce a
      -- semantic key uniqueness that treats NULL agent_id (global) the same
      -- as the empty string so global and per-agent slugs don't collide.
      CREATE TABLE agent_memories_new (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'agent',
        agent_id TEXT,
        type TEXT NOT NULL DEFAULT 'fact',
        key_slug TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        importance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO agent_memories_new (id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at)
        SELECT id, scope, agent_id, 'fact', key_slug, text, NULL, 0, created_at, updated_at
        FROM agent_memories;

      DROP TABLE agent_memories;

      ALTER TABLE agent_memories_new RENAME TO agent_memories;

      CREATE UNIQUE INDEX idx_agent_memories_semantic_key
        ON agent_memories(scope, COALESCE(agent_id, ''), key_slug);
    `,
  },
  {
    id: 12,
    name: "channel_memory_constraints_and_main_channel",
    sql: `
      -- The published contract keys membership by both participant kind and id.
      CREATE TABLE channel_members_v12 (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        participant_type TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        PRIMARY KEY (channel_id, participant_type, participant_id)
      );
      INSERT OR IGNORE INTO channel_members_v12 (channel_id, participant_type, participant_id, role)
        SELECT channel_id, member_type, member_id, 'member' FROM channel_members;
      DROP TABLE channel_members;
      ALTER TABLE channel_members_v12 RENAME TO channel_members;

      CREATE TABLE channel_summaries_v12 (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        last_compacted_message_id TEXT,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO channel_summaries_v12 (id, channel_id, summary, updated_at)
        SELECT id, channel_id, summary, created_at FROM channel_summaries;
      DROP TABLE channel_summaries;
      ALTER TABLE channel_summaries_v12 RENAME TO channel_summaries;

      CREATE TABLE agent_memories_v12 (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        agent_id TEXT,
        type TEXT NOT NULL,
        key_slug TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO agent_memories_v12 (id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at)
        SELECT id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at FROM agent_memories;
      DROP TABLE agent_memories;
      ALTER TABLE agent_memories_v12 RENAME TO agent_memories;
      CREATE UNIQUE INDEX idx_agent_memories_semantic_key
        ON agent_memories(scope, COALESCE(agent_id, ''), key_slug);
      CREATE INDEX idx_agent_memories_scope ON agent_memories(scope, agent_id, importance DESC);

      UPDATE agents SET default_name = COALESCE(default_name, name), display_name = COALESCE(display_name, name),
        system_prompt = COALESCE(system_prompt, ''), avatar_color = COALESCE(avatar_color, color, '#f0b95a');
      UPDATE agents SET role = 'orchestrator', default_name = 'Agni Bot', display_name = 'Agni Bot'
        WHERE id = 'ea' AND display_name = 'EA';
      INSERT OR IGNORE INTO agents (id, name, color, role, default_name, display_name, system_prompt, avatar_color, onboarded, created_at, updated_at)
        VALUES ('agni', 'Agni', '#f0b95a', 'orchestrator', 'Agni', 'Agni', 'You are the primary assistant.', '#f0b95a', 1, datetime('now'), datetime('now'));

      INSERT OR IGNORE INTO channels (id, name, agent_id, type, visibility, parent_turn_id, created_at, updated_at)
        VALUES ('main', 'Main', 'ea', 'main', 'public', NULL, datetime('now'), datetime('now'));
      INSERT OR IGNORE INTO channel_members (channel_id, participant_type, participant_id, role)
        VALUES ('main', 'agent', 'ea', 'owner'), ('main', 'user', 'user', 'member');
    `,
  },
  {
    id: 13,
    name: "channel_message_ui_hint",
    sql: `ALTER TABLE channel_messages ADD COLUMN ui_hint TEXT;`,
  },
  {
    id: 14,
    name: "channel_messages_drop_legacy_columns",
    sql: `
      -- The finalized channel message row carries sender identity in
      -- from_type/from_id and no longer needs the legacy role/status pair.
      ALTER TABLE channel_messages DROP COLUMN role;
      ALTER TABLE channel_messages DROP COLUMN status;
    `,
  },
  {
    id: 15,
    name: "agents_tool_allowlist",
    sql: `
      -- An agent the assistant creates at runtime has to survive a restart:
      -- its tool allowlist lived only in the process, so a daemon restart
      -- left the row in the database with no tools and no roster entry.
      ALTER TABLE agents ADD COLUMN tools TEXT;
    `,
  },
  {
    id: 16,
    name: "agents_role_detail",
    sql: `
      -- The "role" column is the hierarchy role (orchestrator/agent). The
      -- descriptive role the owner gives an agent ("inbox manager", "second
      -- pair of eyes") is its own column, so it can be set without
      -- overwriting the hierarchy and it survives a restart.
      ALTER TABLE agents ADD COLUMN role_detail TEXT;
    `,
  },
  {
    id: 17,
    name: "agents_visibility_and_message_salience",
    sql: `
      -- Per-agent visibility to the primary assistant (RTE-004):
      -- private   -> nothing leaves the agent's own channel
      -- summary   -> the EA may see task status and one-line outcomes
      -- shared    -> the EA may read the agent's channel directly
      ALTER TABLE agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'summary';

      -- Turn salience (GATE-001): ephemeral turns stay in the durable
      -- transcript and the recent window but are excluded from compaction
      -- and long-term memory extraction.
      ALTER TABLE channel_messages ADD COLUMN salience TEXT NOT NULL DEFAULT 'recent_turns';
      CREATE INDEX idx_channel_messages_salience ON channel_messages(channel_id, salience, created_at);
    `,
  },
  {
    id: 18,
    name: "agent_memories_lifecycle_columns",
    sql: `
      -- MEM-001 foundation: the columns temporal facts, provenance and
      -- retrieval ranking need. All nullable/defaulted so existing rows are
      -- valid and behaviour is unchanged until the writers opt in.
      ALTER TABLE agent_memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';
      ALTER TABLE agent_memories ADD COLUMN valid_from TEXT;
      ALTER TABLE agent_memories ADD COLUMN valid_to TEXT;
      ALTER TABLE agent_memories ADD COLUMN supersedes_id TEXT;
      ALTER TABLE agent_memories ADD COLUMN source_block_id TEXT;
      ALTER TABLE agent_memories ADD COLUMN source_turn_ids TEXT;
      ALTER TABLE agent_memories ADD COLUMN last_used_at TEXT;
      ALTER TABLE agent_memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_memories ADD COLUMN embedding BLOB;
      ALTER TABLE agent_memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
      ALTER TABLE agent_memories ADD COLUMN salience REAL NOT NULL DEFAULT 0.5;
      ALTER TABLE agent_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
      ALTER TABLE agent_memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user';

      CREATE INDEX idx_agent_memories_live ON agent_memories(scope, agent_id, valid_to);
      CREATE INDEX idx_agent_memories_supersedes ON agent_memories(supersedes_id);
    `,
  },
  {
    id: 19,
    name: "delegation_tasks",
    sql: `
      -- DEL-001/DEL-005: asynchronous delegation is a task with an owner, an
      -- origin, and its own lifecycle. Kept separate from the user-facing
      -- status column so the task list does not grow agent states.
      ALTER TABLE tasks ADD COLUMN owner_agent_id TEXT;
      ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user_direct'; -- user_direct | ea_delegated
      ALTER TABLE tasks ADD COLUMN delegate_state TEXT NOT NULL DEFAULT 'none'; -- none | queued | running | needs_input | done | failed
      ALTER TABLE tasks ADD COLUMN brief TEXT;        -- JSON TaskPacket (goal/constraints/deadline/output_schema)
      ALTER TABLE tasks ADD COLUMN result TEXT;       -- short summary or failure
      ALTER TABLE tasks ADD COLUMN job_id TEXT;       -- the background job that runs it
      ALTER TABLE tasks ADD COLUMN parent_turn_id TEXT; -- the EA turn that delegated it
      CREATE INDEX idx_tasks_delegate ON tasks(delegate_state, owner_agent_id);
    `,
  },
  {
    id: 20,
    name: "agents_memory_scope",
    sql: `
      -- DEL-007: a new agent gets user-scope memory read-only by default.
      -- Existing agents keep their current write access; the orchestrator and
      -- every pre-existing persona are readwrite.
      ALTER TABLE agents ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'readwrite';
      CREATE INDEX idx_agents_memory_scope ON agents(memory_scope);
    `,
  },
  {
    id: 21,
    name: "agents_visibility_defaults",
    sql: `
      -- RTE-004: visibility becomes real. The shipped team is \`shared\`: the
      -- executive assistant is the owner's proxy, so it keeps the full answer
      -- it synthesizes from. A new agent created at runtime starts at
      -- \`summary\` (see create_agent) until the owner says otherwise.
      UPDATE agents SET visibility = 'shared'
       WHERE id IN ('ea', 'agni', 'researcher', 'coder', 'analyst')
         AND visibility = 'summary';
    `,
  },
  {
    id: 22,
    name: "delegation_lifecycle",
    sql: `
      -- DEL-006: a delegated task can ask a question and be answered.
      -- The question, the thread it belongs to, and the parent that has to be
      -- woken when the work lands.
      ALTER TABLE tasks ADD COLUMN child_thread_id TEXT;    -- the specialist's own thread
      ALTER TABLE tasks ADD COLUMN parent_thread_id TEXT;   -- where the answer goes
      ALTER TABLE tasks ADD COLUMN parent_channel_id TEXT;  -- the channel the owner watches
      ALTER TABLE tasks ADD COLUMN parent_agent_id TEXT;   -- who has to be woken
      ALTER TABLE tasks ADD COLUMN pending_question TEXT;  -- the question being asked
      ALTER TABLE tasks ADD COLUMN pending_question_id TEXT;
      ALTER TABLE tasks ADD COLUMN result_delivered_at TEXT; -- the wake was claimed
      ALTER TABLE tasks ADD COLUMN artifact_id TEXT;        -- DEL-004: the full result
      CREATE INDEX idx_tasks_pending ON tasks(delegate_state, pending_question_id);
    `,
  },
  {
    id: 23,
    name: "artifacts",
    sql: `
      -- DEL-004: a delegated result is stored by reference. The task row keeps
      -- a short summary for the caller's context; the full text lives here and
      -- is only ever read through the visibility filter.
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        agent_id TEXT NOT NULL,     -- the agent that produced it
        kind TEXT NOT NULL DEFAULT 'result',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_artifacts_task ON artifacts(task_id);
      CREATE INDEX idx_artifacts_agent ON artifacts(agent_id);
    `,
  },
  {
    id: 24,
    name: "fts_indexes",
    sql: `
      -- MEM-003: facts and transcripts are indexed for search. FTS5 with
      -- external content, kept in sync by triggers, so a write never has to
      -- remember to update the index. The vector half of hybrid retrieval
      -- lands with the embeddings (PR 3c); the BLOB column already exists.
      CREATE VIRTUAL TABLE agent_memories_fts USING fts5(
        content, tags, key_slug,
        content='agent_memories', content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER agent_memories_fts_ai AFTER INSERT ON agent_memories BEGIN
        INSERT INTO agent_memories_fts(rowid, content, tags, key_slug)
        VALUES (new.rowid, new.content, new.tags, new.key_slug);
      END;
      CREATE TRIGGER agent_memories_fts_ad AFTER DELETE ON agent_memories BEGIN
        INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags, key_slug)
        VALUES ('delete', old.rowid, old.content, old.tags, old.key_slug);
      END;
      CREATE TRIGGER agent_memories_fts_au AFTER UPDATE ON agent_memories BEGIN
        INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags, key_slug)
        VALUES ('delete', old.rowid, old.content, old.tags, old.key_slug);
        INSERT INTO agent_memories_fts(rowid, content, tags, key_slug)
        VALUES (new.rowid, new.content, new.tags, new.key_slug);
      END;

      CREATE VIRTUAL TABLE channel_messages_fts USING fts5(
        text,
        content='channel_messages', content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER channel_messages_fts_ai AFTER INSERT ON channel_messages BEGIN
        INSERT INTO channel_messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER channel_messages_fts_ad AFTER DELETE ON channel_messages BEGIN
        INSERT INTO channel_messages_fts(channel_messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER channel_messages_fts_au AFTER UPDATE ON channel_messages BEGIN
        INSERT INTO channel_messages_fts(channel_messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO channel_messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      -- Backfill the indexes for the rows that already exist.
      INSERT INTO agent_memories_fts(agent_memories_fts) VALUES ('rebuild');
      INSERT INTO channel_messages_fts(channel_messages_fts) VALUES ('rebuild');
    `,
  },
  {
    id: 25,
    name: "tagger_batches_and_conflicts",
    sql: `
      -- TAG-001: the tagger works in batches. A message that has been swept
      -- for memory is marked, so the next batch starts where this one
      -- stopped instead of reading the whole channel again.
      ALTER TABLE channel_messages ADD COLUMN tagged_at TEXT;
      CREATE INDEX idx_channel_messages_untagged ON channel_messages(tagged_at, created_at);

      -- MEM-002: a changed fact closes the old one — and the conflict is
      -- recorded, because closing it silently would hide that the two
      -- statements disagreed.
      CREATE TABLE memory_conflicts (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        previous_id TEXT NOT NULL,
        previous_content TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT
      );
      CREATE INDEX idx_memory_conflicts_open ON memory_conflicts(resolved, created_at);
    `,
  },
  {
    id: 26,
    name: "memory_embeddings",
    sql: `
      -- D-02/D-03: the embedder is optional and the vectors live in the
      -- database. The model and its dimensions ride along, so a change of
      -- model re-embeds instead of mixing two vector spaces.
      ALTER TABLE agent_memories ADD COLUMN embedding_model TEXT;
      ALTER TABLE agent_memories ADD COLUMN embedding_dim INTEGER;
      -- MEM-006: consolidation archives what nothing uses; an archived item
      -- is still there, it is just not recalled.
      ALTER TABLE agent_memories ADD COLUMN archived_at TEXT;
      CREATE INDEX idx_agent_memories_archived ON agent_memories(archived_at, valid_to);
    `,
  },
  {
    id: 27,
    name: "rollover_structured_summary",
    sql: `
      -- ROL-005: the carried summary is structured, not free text: the
      -- decisions, the open loops, the entities, the tone, and the turns it
      -- came from. The text version stays for the prompt.
      ALTER TABLE conversations ADD COLUMN summary_json TEXT;
      -- The version of the summary that is current. A second rotation can
      -- land before the first summary does; the newer version wins.
      ALTER TABLE conversations ADD COLUMN summary_version INTEGER NOT NULL DEFAULT 0;
      -- ROL-006: the new block opens with the last turns of the old one.
      ALTER TABLE threads ADD COLUMN opened_tail TEXT;
    `,
  },
  {
    id: 28,
    name: "summary_levels",
    sql: `
      -- CMP-001: summaries in levels. A block summary says what happened in
      -- one session block; a day summary says what happened in a day; an
      -- epoch summary says what happened over a longer stretch. Each level
      -- keeps the range it came from, so a summary can be traced back.
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        level TEXT NOT NULL,          -- block | day | epoch
        parent_id TEXT,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        structured TEXT,
        source_from INTEGER,
        source_to INTEGER,
        day TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_summaries_conversation ON summaries(conversation_id, level, created_at);
      CREATE INDEX idx_summaries_day ON summaries(conversation_id, day, level);
    `,
  },
  {
    id: 29,
    name: "message_attachments",
    sql: `
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        extracted_text TEXT,
        created_at TEXT NOT NULL
      );
      -- Message IDs belong to either messages or channel_messages.
      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        position INTEGER NOT NULL,
        PRIMARY KEY (message_id, attachment_id)
      );
      CREATE INDEX idx_message_attachments_file ON message_attachments(attachment_id);
    `,
  },
  {
    id: 30,
    name: "owner_forms",
    sql: `
      -- A question the agent put to the owner: a set of options to choose
      -- from, or a draft to approve. The row is the durable record; the
      -- answer comes back on the 'form.answer' frame.
      CREATE TABLE forms (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        kind TEXT NOT NULL,               -- choice | email
        question TEXT NOT NULL,
        options TEXT,                     -- JSON array, choice only
        multiple INTEGER NOT NULL DEFAULT 0,
        email TEXT,                       -- JSON {from,to,subject,body}
        status TEXT NOT NULL,             -- pending | answered
        answer TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE INDEX idx_forms_thread ON forms(thread_id, created_at);
    `,
  },
  {
    id: 31,
    name: "appearance_profiles",
    sql: `
      CREATE TABLE appearance_profiles (
        id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE appearance_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_profile_id TEXT REFERENCES appearance_profiles(id) ON DELETE SET NULL
      );
      INSERT INTO appearance_state (singleton, active_profile_id) VALUES (1, NULL);
      CREATE TABLE background_assets (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 32,
    name: "task_workspace",
    sql: `
      CREATE TABLE task_lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO task_lists (id, name, position, created_at, updated_at)
        VALUES ('lst_inbox', 'Inbox', 0, datetime('now'), datetime('now'));

      ALTER TABLE tasks ADD COLUMN list_id TEXT NOT NULL DEFAULT 'lst_inbox';
      ALTER TABLE tasks ADD COLUMN description TEXT;
      ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
      ALTER TABLE tasks ADD COLUMN reminder_at TEXT;
      ALTER TABLE tasks ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX idx_tasks_list ON tasks(list_id, status, due_at);
      CREATE INDEX idx_tasks_parent ON tasks(parent_task_id, status);

      CREATE TABLE task_activity (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at DESC);
    `,
  },
  {
    id: 33,
    name: "task_reminder_jobs",
    sql: `ALTER TABLE tasks ADD COLUMN reminder_job_id TEXT;`,
  },
  {
    id: 34,
    name: "task_repeats",
    sql: `ALTER TABLE tasks ADD COLUMN repeat_rule TEXT NOT NULL DEFAULT 'none';`,
  },
  {
    id: 35,
    name: "task_deadlines_and_labels",
    sql: `
      ALTER TABLE tasks ADD COLUMN deadline_at TEXT;
      ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 36,
    name: "task_workflow_status",
    sql: `ALTER TABLE tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'not_started';`,
  },
  {
    id: 37,
    name: "task_progress_notes",
    sql: `ALTER TABLE tasks ADD COLUMN progress_note TEXT NOT NULL DEFAULT '';`,
  },
  {
    id: 38,
    name: "peer_chains",
    sql: `
      CREATE TABLE peer_chains (
        id TEXT PRIMARY KEY,
        retried INTEGER NOT NULL DEFAULT 0,
        stopped_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE peer_chain_messages (
        chain_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(chain_id, fingerprint)
      );
    `,
  },
];
