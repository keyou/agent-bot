export const migrations = [
  `
  CREATE TABLE IF NOT EXISTS user_contexts (
    context_key TEXT PRIMARY KEY,
    default_agent TEXT NOT NULL,
    current_session_id TEXT,
    previous_session_id TEXT,
    bound_project_cwd TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    local_session_id TEXT PRIMARY KEY,
    context_key TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    acp_session_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS turn_snapshots (
    turn_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    context_key TEXT,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS turn_deliveries (
    turn_id TEXT PRIMARY KEY,
    progress_message_id TEXT,
    final_message_ids_json TEXT NOT NULL DEFAULT '[]',
    final_delivered_at TEXT,
    last_card_hash TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS inbound_event_receipts (
    event_id TEXT PRIMARY KEY,
    event_kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT PRIMARY KEY,
    context_key TEXT NOT NULL,
    reaction_id TEXT NOT NULL,
    emoji_type TEXT NOT NULL,
    local_session_id TEXT,
    turn_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_reactions_turn_status
    ON message_reactions(turn_id, status);
  `,
  `
  CREATE TABLE IF NOT EXISTS message_turn_bindings (
    message_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_turn_bindings_turn
    ON message_turn_bindings(turn_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS fork_title_sequences (
    base_title TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS context_sessions (
    context_key TEXT NOT NULL,
    local_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (context_key, local_session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_context_sessions_local_session
    ON context_sessions(local_session_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS chat_contexts (
    context_key TEXT PRIMARY KEY,
    chat_type TEXT NOT NULL,
    require_mention INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_contexts_type
    ON chat_contexts(chat_type, updated_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS queued_prompts (
    prompt_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    context_key TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    display_prompt TEXT,
    local_image_paths_json TEXT NOT NULL DEFAULT '[]',
    message_id TEXT,
    reply_message_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_queued_prompts_session_order
    ON queued_prompts(local_session_id, created_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS turn_runtime_origins (
    turn_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    remote_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_runtime_origins_session
    ON turn_runtime_origins(local_session_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS turn_parent_links (
    turn_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    parent_turn_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_parent_links_session
    ON turn_parent_links(local_session_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS turn_attempts (
    attempt_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    context_key TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    local_image_paths_json TEXT NOT NULL DEFAULT '[]',
    message_id TEXT,
    reply_message_id TEXT,
    pending_turn_id TEXT,
    turn_id TEXT,
    recovered_from_turn_id TEXT,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_attempts_recovery
    ON turn_attempts(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_turn_attempts_session
    ON turn_attempts(local_session_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_turn_attempts_turn
    ON turn_attempts(turn_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS goal_card_deliveries (
    local_session_id TEXT NOT NULL,
    context_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (local_session_id, context_key)
  );
  CREATE INDEX IF NOT EXISTS idx_goal_card_deliveries_session
    ON goal_card_deliveries(local_session_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS card_action_bindings (
    message_id TEXT NOT NULL,
    token TEXT NOT NULL,
    value_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, token)
  );
  CREATE INDEX IF NOT EXISTS idx_card_action_bindings_created
    ON card_action_bindings(created_at);
  `,
] as const;
