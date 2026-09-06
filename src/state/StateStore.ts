import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

export type SessionStatus = "starting" | "ready" | "running" | "closed" | "failed";

export interface UserContextRecord {
  contextKey: string;
  defaultAgent: string;
  currentSessionId?: string;
  previousSessionId?: string;
  boundProjectCwd?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatContextRecord {
  contextKey: string;
  chatType: "p2p" | "group";
  requiresMention: boolean;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  localSessionId: string;
  contextKey: string;
  agentName: string;
  cwd: string;
  acpSessionId?: string;
  runtimeKind?: "acp" | "codex";
  remoteSessionId?: string;
  title?: string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: "auto" | "confirm";
  lastTurnId?: string;
  lastTurnStatus?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export type MessageReactionStatus = "pending" | "updating" | "completed" | "failed" | "cancelled";

export interface MessageReactionRecord {
  messageId: string;
  contextKey: string;
  reactionId: string;
  emojiType: string;
  localSessionId?: string;
  turnId?: string;
  status: MessageReactionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TurnAnchorRecord {
  turnId: string;
  localSessionId: string;
  contextKey?: string;
}

export interface AgentBotTurnMessageRecord extends TurnAnchorRecord {
  messageKind: "progress" | "final";
}

export interface GoalCardDeliveryRecord {
  localSessionId: string;
  contextKey: string;
  messageId: string;
  updatedAt: string;
}

export interface CardActionBinding {
  token: string;
  value: Record<string, string>;
}

export interface TurnRuntimeOriginRecord {
  turnId: string;
  localSessionId: string;
  agentName: string;
  remoteSessionId: string;
  createdAt: string;
}

export interface CompletedTurnSnapshotRecord {
  turnId: string;
  parentTurnId?: string;
  snapshot: unknown;
  updatedAt: string;
}

export interface ImportedCompletedTurnRecord {
  turnId: string;
  snapshot: unknown;
  updatedAt: string;
}

export interface ForkHistorySourceRecord {
  sourceLocalSessionId?: string;
  sourceRemoteSessionId?: string;
  sourceTurnId: string;
  sourceTurnPrompt?: string;
  sourceTurnStartedAt?: number;
  sourceTurnCompletedAt?: number;
  sourceTurnHistoryCount?: number;
  createdAt: string;
}

export interface QueuedPromptRecord {
  promptId: string;
  localSessionId: string;
  contextKey: string;
  text: string;
  displayPrompt?: string;
  localImagePaths?: string[];
  messageId?: string;
  replyMessageId?: string;
  createdAt: string;
}

export type TurnAttemptStatus =
  | "accepted"
  | "running"
  | "recovering"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TurnAttemptRecord {
  attemptId: string;
  localSessionId: string;
  contextKey: string;
  promptText: string;
  localImagePaths?: string[];
  messageId?: string;
  replyMessageId?: string;
  pendingTurnId?: string;
  turnId?: string;
  recoveredFromTurnId?: string;
  recoveryCount: number;
  retryCount: number;
  status: TurnAttemptStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedTurnSnapshotRecord {
  turnId: string;
  localSessionId: string;
  contextKey?: string;
  snapshot: unknown;
  updatedAt: string;
}

interface UserContextRow {
  context_key: string;
  default_agent: string;
  current_session_id: string | null;
  previous_session_id: string | null;
  bound_project_cwd: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatContextRow {
  context_key: string;
  chat_type: "p2p" | "group";
  require_mention: number;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  local_session_id: string;
  context_key: string;
  agent_name: string;
  cwd: string;
  acp_session_id: string | null;
  runtime_kind: "acp" | "codex" | null;
  remote_session_id: string | null;
  title: string | null;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  permission_mode: "auto" | "confirm" | null;
  last_turn_id: string | null;
  last_turn_status: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

interface MessageReactionRow {
  message_id: string;
  context_key: string;
  reaction_id: string;
  emoji_type: string;
  local_session_id: string | null;
  turn_id: string | null;
  status: MessageReactionStatus;
  created_at: string;
  updated_at: string;
}

interface QueuedPromptRow {
  prompt_id: string;
  local_session_id: string;
  context_key: string;
  prompt_text: string;
  display_prompt: string | null;
  local_image_paths_json: string;
  message_id: string | null;
  reply_message_id: string | null;
  created_at: string;
}

interface TurnAttemptRow {
  attempt_id: string;
  local_session_id: string;
  context_key: string;
  prompt_text: string;
  local_image_paths_json: string;
  message_id: string | null;
  reply_message_id: string | null;
  pending_turn_id: string | null;
  turn_id: string | null;
  recovered_from_turn_id: string | null;
  recovery_count: number;
  retry_count: number;
  status: TurnAttemptStatus;
  created_at: string;
  updated_at: string;
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new Database(sqlitePath);
    this.db.pragma("journal_mode = WAL");
    for (const migration of migrations) {
      this.db.exec(migration);
    }
    this.db.exec("UPDATE message_reactions SET status = 'pending' WHERE status = 'updating'");
    this.ensureUserContextColumns();
    this.ensureSessionColumns();
    this.ensureTurnSnapshotColumns();
    this.ensureChatContextColumns();
    this.ensureTurnAttemptColumns();
    this.ensureQueuedPromptColumns();
    this.initializeContextSessionMappings();
    this.db.exec("DROP INDEX IF EXISTS idx_sessions_remote_session_id_unique");
    this.reconcileDuplicateRemoteSessions();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent_remote_session_unique
      ON sessions(agent_name, remote_session_id)
      WHERE remote_session_id IS NOT NULL
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_contexts_activity
      ON chat_contexts(last_activity_at)
    `);
  }

  saveGoalCardDelivery(localSessionId: string, contextKey: string, messageId: string): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO goal_card_deliveries (local_session_id, context_key, message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(local_session_id, context_key) DO UPDATE SET
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `).run(localSessionId, contextKey, messageId, updatedAt);
  }

  getGoalCardDelivery(localSessionId: string, contextKey: string): GoalCardDeliveryRecord | undefined {
    const row = this.db.prepare(`
      SELECT local_session_id, context_key, message_id, updated_at
      FROM goal_card_deliveries
      WHERE local_session_id = ? AND context_key = ?
    `).get(localSessionId, contextKey) as {
      local_session_id: string;
      context_key: string;
      message_id: string;
      updated_at: string;
    } | undefined;
    return row ? goalCardDeliveryFromRow(row) : undefined;
  }

  listGoalCardDeliveries(localSessionId: string): GoalCardDeliveryRecord[] {
    const rows = this.db.prepare(`
      SELECT local_session_id, context_key, message_id, updated_at
      FROM goal_card_deliveries
      WHERE local_session_id = ?
      ORDER BY updated_at ASC
    `).all(localSessionId) as Array<{
      local_session_id: string;
      context_key: string;
      message_id: string;
      updated_at: string;
    }>;
    return rows.map(goalCardDeliveryFromRow);
  }

  upsertCardActionBindings(messageId: string, bindings: CardActionBinding[]): void {
    if (bindings.length === 0) return;
    const createdAt = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO card_action_bindings (message_id, token, value_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, token) DO UPDATE SET
        value_json = excluded.value_json,
        created_at = excluded.created_at
    `);
    this.db.transaction(() => {
      for (const binding of bindings) {
        upsert.run(messageId, binding.token, JSON.stringify(binding.value), createdAt);
      }
    })();
  }

  retainCardActionBindings(messageId: string, tokens: string[]): void {
    if (tokens.length === 0) {
      this.db.prepare("DELETE FROM card_action_bindings WHERE message_id = ?").run(messageId);
      return;
    }
    const placeholders = tokens.map(() => "?").join(", ");
    this.db.prepare(`
      DELETE FROM card_action_bindings
      WHERE message_id = ? AND token NOT IN (${placeholders})
    `).run(messageId, ...tokens);
  }

  getCardActionBinding(messageId: string, token: string): Record<string, unknown> | undefined {
    const row = this.db.prepare(`
      SELECT value_json
      FROM card_action_bindings
      WHERE message_id = ? AND token = ?
    `).get(messageId, token) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value_json) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.db.close();
  }

  getOrCreateUserContext(contextKey: string, defaultAgent: string): UserContextRecord {
    const existing = this.db
      .prepare("SELECT * FROM user_contexts WHERE context_key = ?")
      .get(contextKey) as UserContextRow | undefined;

    if (existing) {
      return mapUserContext(existing);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO user_contexts (context_key, default_agent, current_session_id, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?)
        `,
      )
      .run(contextKey, defaultAgent, now, now);

    return {
      contextKey,
      defaultAgent,
      createdAt: now,
      updatedAt: now,
    };
  }

  getUserContext(contextKey: string): UserContextRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM user_contexts WHERE context_key = ?")
      .get(contextKey) as UserContextRow | undefined;
    return row ? mapUserContext(row) : undefined;
  }

  listUserContexts(): UserContextRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM user_contexts ORDER BY created_at ASC")
      .all() as UserContextRow[];
    return rows.map(mapUserContext);
  }

  recordChatContext(contextKey: string, chatType: "p2p" | "group"): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO chat_contexts (context_key, chat_type, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(context_key) DO UPDATE SET
        chat_type = excluded.chat_type,
        updated_at = excluded.updated_at
    `).run(contextKey, chatType, now, now);
  }

  getChatContext(contextKey: string): ChatContextRecord | undefined {
    const row = this.db.prepare("SELECT * FROM chat_contexts WHERE context_key = ?")
      .get(contextKey) as ChatContextRow | undefined;
    return row ? mapChatContext(row) : undefined;
  }

  setChatRequiresMention(contextKey: string, requiresMention: boolean): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE chat_contexts
      SET require_mention = ?, updated_at = ?
      WHERE context_key = ? AND chat_type = 'group'
    `).run(requiresMention ? 1 : 0, now, contextKey);
  }

  chatRequiresMention(contextKey: string): boolean {
    const row = this.db.prepare(`
      SELECT require_mention
      FROM chat_contexts
      WHERE context_key = ? AND chat_type = 'group'
    `).get(contextKey) as { require_mention: number } | undefined;
    return row?.require_mention === 1;
  }

  listChatContexts(chatType?: "p2p" | "group"): ChatContextRecord[] {
    const rows = chatType
      ? this.db.prepare(`
          SELECT * FROM chat_contexts
          WHERE chat_type = ?
          ORDER BY updated_at DESC
        `).all(chatType) as ChatContextRow[]
      : this.db.prepare("SELECT * FROM chat_contexts ORDER BY updated_at DESC").all() as ChatContextRow[];
    return rows.map(mapChatContext);
  }

  markChatActive(contextKey: string, activeAt = new Date()): void {
    const timestamp = activeAt.toISOString();
    this.db.prepare(`
      UPDATE chat_contexts
      SET last_activity_at = ?, updated_at = ?
      WHERE context_key = ?
    `).run(timestamp, timestamp, contextKey);
  }

  listRecentlyActiveChatContexts(since: Date): ChatContextRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM chat_contexts
      WHERE last_activity_at >= ?
      ORDER BY last_activity_at DESC
    `).all(since.toISOString()) as ChatContextRow[];
    return rows.map(mapChatContext);
  }

  removeChatContext(contextKey: string): string[] {
    const threadPrefix = `${contextKey}:thread_id:`;
    const linked = this.db.prepare(`
      SELECT DISTINCT local_session_id
      FROM context_sessions
      WHERE context_key = ? OR instr(context_key, ?) = 1
    `).all(contextKey, threadPrefix) as Array<{ local_session_id: string }>;
    const remove = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM context_sessions
        WHERE context_key = ? OR instr(context_key, ?) = 1
      `).run(contextKey, threadPrefix);
      this.db.prepare(`
        DELETE FROM user_contexts
        WHERE context_key = ? OR instr(context_key, ?) = 1
      `).run(contextKey, threadPrefix);
      this.db.prepare(`
        DELETE FROM chat_contexts
        WHERE context_key = ? OR instr(context_key, ?) = 1
      `).run(contextKey, threadPrefix);
    });
    remove();
    return linked.map((row) => row.local_session_id);
  }

  enqueuePrompt(input: {
    promptId: string;
    localSessionId: string;
    contextKey: string;
    text: string;
    displayPrompt?: string;
    localImagePaths?: string[];
    messageId?: string;
    replyMessageId?: string;
  }): QueuedPromptRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO queued_prompts (
        prompt_id, local_session_id, context_key, prompt_text, display_prompt, local_image_paths_json,
        message_id, reply_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.promptId,
      input.localSessionId,
      input.contextKey,
      input.text,
      input.displayPrompt ?? null,
      JSON.stringify(input.localImagePaths ?? []),
      input.messageId ?? null,
      input.replyMessageId ?? null,
      createdAt,
    );
    return {
      ...input,
      localImagePaths: input.localImagePaths?.length ? [...input.localImagePaths] : undefined,
      createdAt,
    };
  }

  listQueuedPrompts(localSessionId: string): QueuedPromptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM queued_prompts
      WHERE local_session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(localSessionId) as QueuedPromptRow[];
    return rows.map(mapQueuedPrompt);
  }

  listQueuedPromptSessionIds(): string[] {
    const rows = this.db.prepare(`
      SELECT local_session_id, min(created_at) AS first_created_at, min(rowid) AS first_rowid
      FROM queued_prompts
      GROUP BY local_session_id
      ORDER BY first_created_at ASC, first_rowid ASC
    `).all() as Array<{ local_session_id: string }>;
    return rows.map((row) => row.local_session_id);
  }

  countQueuedPrompts(localSessionId: string): number {
    const row = this.db.prepare(`
      SELECT count(*) AS count FROM queued_prompts WHERE local_session_id = ?
    `).get(localSessionId) as { count: number };
    return row.count;
  }

  takeNextQueuedPrompt(localSessionId: string): QueuedPromptRecord | undefined {
    const take = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM queued_prompts
        WHERE local_session_id = ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `).get(localSessionId) as QueuedPromptRow | undefined;
      if (!row) return undefined;
      this.db.prepare("DELETE FROM queued_prompts WHERE prompt_id = ?").run(row.prompt_id);
      return mapQueuedPrompt(row);
    });
    return take();
  }

  cancelQueuedPrompt(promptId: string, localSessionId: string): QueuedPromptRecord | undefined {
    const cancel = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM queued_prompts WHERE prompt_id = ? AND local_session_id = ?
      `).get(promptId, localSessionId) as QueuedPromptRow | undefined;
      if (!row) return undefined;
      this.db.prepare("DELETE FROM queued_prompts WHERE prompt_id = ?").run(promptId);
      return mapQueuedPrompt(row);
    });
    return cancel();
  }

  createTurnAttempt(input: {
    attemptId: string;
    localSessionId: string;
    contextKey: string;
    promptText: string;
    localImagePaths?: string[];
    messageId?: string;
    replyMessageId?: string;
    pendingTurnId?: string;
    turnId?: string;
    recoveredFromTurnId?: string;
    recoveryCount?: number;
    retryCount?: number;
    status?: Extract<TurnAttemptStatus, "accepted" | "running" | "recovering">;
    createdAt?: string;
    updatedAt?: string;
  }): TurnAttemptRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    const status = input.status ?? (input.turnId ? "running" : "accepted");
    this.db.prepare(`
      INSERT INTO turn_attempts (
        attempt_id, local_session_id, context_key, prompt_text, local_image_paths_json,
        message_id, reply_message_id, pending_turn_id, turn_id, recovered_from_turn_id,
        recovery_count, retry_count, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.attemptId,
      input.localSessionId,
      input.contextKey,
      input.promptText,
      JSON.stringify(input.localImagePaths ?? []),
      input.messageId ?? null,
      input.replyMessageId ?? null,
      input.pendingTurnId ?? null,
      input.turnId ?? null,
      input.recoveredFromTurnId ?? null,
      input.recoveryCount ?? 0,
      input.retryCount ?? 0,
      status,
      createdAt,
      updatedAt,
    );
    return this.getTurnAttempt(input.attemptId)!;
  }

  getTurnAttempt(attemptId: string): TurnAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM turn_attempts WHERE attempt_id = ?")
      .get(attemptId) as TurnAttemptRow | undefined;
    return row ? mapTurnAttempt(row) : undefined;
  }

  findIncompleteTurnAttemptForSession(localSessionId: string): TurnAttemptRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM turn_attempts
      WHERE local_session_id = ?
        AND status IN ('accepted', 'running', 'recovering')
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1
    `).get(localSessionId) as TurnAttemptRow | undefined;
    return row ? mapTurnAttempt(row) : undefined;
  }

  listIncompleteTurnAttempts(): TurnAttemptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM turn_attempts
      WHERE status IN ('accepted', 'running', 'recovering')
      ORDER BY created_at ASC, rowid ASC
    `).all() as TurnAttemptRow[];
    return rows.map(mapTurnAttempt);
  }

  listCancellationRequestedTurnAttempts(): TurnAttemptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM turn_attempts
      WHERE status = 'cancelling'
      ORDER BY created_at ASC, rowid ASC
    `).all() as TurnAttemptRow[];
    return rows.map(mapTurnAttempt);
  }

  updateTurnAttempt(
    attemptId: string,
    patch: Partial<{
      messageId: string | null;
      replyMessageId: string | null;
      pendingTurnId: string | null;
      turnId: string | null;
      recoveredFromTurnId: string | null;
      recoveryCount: number;
      retryCount: number;
      status: TurnAttemptStatus;
    }>,
  ): void {
    const existing = this.getTurnAttempt(attemptId);
    if (!existing) return;
    const value = <T>(candidate: T | null | undefined, fallback: T | undefined): T | null =>
      candidate === undefined ? fallback ?? null : candidate;
    this.db.prepare(`
      UPDATE turn_attempts
      SET message_id = ?, reply_message_id = ?, pending_turn_id = ?, turn_id = ?,
          recovered_from_turn_id = ?, recovery_count = ?, retry_count = ?, status = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(
      value(patch.messageId, existing.messageId),
      value(patch.replyMessageId, existing.replyMessageId),
      value(patch.pendingTurnId, existing.pendingTurnId),
      value(patch.turnId, existing.turnId),
      value(patch.recoveredFromTurnId, existing.recoveredFromTurnId),
      patch.recoveryCount ?? existing.recoveryCount,
      patch.retryCount ?? existing.retryCount,
      patch.status ?? existing.status,
      new Date().toISOString(),
      attemptId,
    );
  }

  bindTurnAttempt(localSessionId: string, turnId: string): TurnAttemptRecord | undefined {
    const attempt = this.findIncompleteTurnAttemptForSession(localSessionId);
    if (!attempt || (attempt.turnId && attempt.turnId !== turnId)) return undefined;
    this.updateTurnAttempt(attempt.attemptId, { turnId, status: "running" });
    return this.getTurnAttempt(attempt.attemptId);
  }

  markTurnAttemptTerminal(
    turnId: string,
    status: Extract<TurnAttemptStatus, "completed" | "failed" | "cancelled">,
  ): void {
    this.db.prepare(`
      UPDATE turn_attempts
      SET status = ?, updated_at = ?
      WHERE turn_id = ?
    `).run(status, new Date().toISOString(), turnId);
  }

  findIncompleteTurnAttemptByTurnId(turnId: string): TurnAttemptRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM turn_attempts
      WHERE turn_id = ? AND status IN ('accepted', 'running', 'recovering')
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1
    `).get(turnId) as TurnAttemptRow | undefined;
    return row ? mapTurnAttempt(row) : undefined;
  }

  requestTurnAttemptCancellation(turnId: string): TurnAttemptRecord | undefined {
    const existing = this.findIncompleteTurnAttemptByTurnId(turnId);
    if (!existing) return undefined;
    this.updateTurnAttempt(existing.attemptId, { status: "cancelling" });
    return existing;
  }

  restoreTurnAttemptAfterCancellationFailure(attempt: TurnAttemptRecord): void {
    const current = this.getTurnAttempt(attempt.attemptId);
    if (current?.status !== "cancelling") return;
    this.updateTurnAttempt(attempt.attemptId, { status: attempt.status });
  }

  touchTurnAttempt(turnId: string, activityAt = new Date()): void {
    const timestamp = activityAt.toISOString();
    const throttleCutoff = new Date(activityAt.getTime() - 15_000).toISOString();
    this.db.prepare(`
      UPDATE turn_attempts
      SET updated_at = ?
      WHERE turn_id = ?
        AND status IN ('accepted', 'running', 'recovering')
        AND updated_at < ?
    `).run(timestamp, turnId, throttleCutoff);
  }

  prepareTurnAttemptRecovery(attemptId: string, recoveredFromTurnId?: string): TurnAttemptRecord | undefined {
    const existing = this.getTurnAttempt(attemptId);
    if (!existing) return undefined;
    this.updateTurnAttempt(attemptId, {
      pendingTurnId: null,
      turnId: null,
      recoveredFromTurnId: recoveredFromTurnId ?? existing.turnId ?? existing.recoveredFromTurnId ?? null,
      recoveryCount: existing.recoveryCount + 1,
      status: "recovering",
    });
    return this.getTurnAttempt(attemptId);
  }

  prepareTurnAttemptRetry(attemptId: string, failedTurnId: string): TurnAttemptRecord | undefined {
    const existing = this.getTurnAttempt(attemptId);
    if (!existing || existing.turnId !== failedTurnId || !isIncompleteTurnAttemptStatus(existing.status)) {
      return undefined;
    }
    this.updateTurnAttempt(attemptId, {
      pendingTurnId: null,
      turnId: null,
      recoveredFromTurnId: failedTurnId,
      retryCount: existing.retryCount + 1,
      status: "recovering",
    });
    return this.getTurnAttempt(attemptId);
  }

  prepareUnstartedTurnAttemptRetry(attemptId: string): TurnAttemptRecord | undefined {
    const existing = this.getTurnAttempt(attemptId);
    if (!existing || existing.turnId || !isIncompleteTurnAttemptStatus(existing.status)) return undefined;
    this.updateTurnAttempt(attemptId, {
      pendingTurnId: null,
      retryCount: existing.retryCount + 1,
      status: "recovering",
    });
    return this.getTurnAttempt(attemptId);
  }

  rebindPendingTurnMessages(localSessionId: string, sourceTurnId: string, targetTurnId: string): void {
    const now = new Date().toISOString();
    const rebind = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE message_reactions
        SET turn_id = ?, updated_at = ?
        WHERE local_session_id = ? AND turn_id = ? AND status = 'pending'
      `).run(targetTurnId, now, localSessionId, sourceTurnId);
      this.db.prepare(`
        UPDATE message_turn_bindings
        SET turn_id = ?, updated_at = ?
        WHERE local_session_id = ? AND turn_id = ?
      `).run(targetTurnId, now, localSessionId, sourceTurnId);
    });
    rebind();
  }

  nextForkTitle(sourceTitle?: string): string {
    const baseTitle = forkBaseTitle(sourceTitle);
    const allocate = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT last_sequence FROM fork_title_sequences WHERE base_title = ?")
        .get(baseTitle) as { last_sequence: number } | undefined;
      const nextSequence = (existing?.last_sequence ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO fork_title_sequences (base_title, last_sequence)
        VALUES (?, ?)
        ON CONFLICT(base_title) DO UPDATE SET last_sequence = excluded.last_sequence
      `).run(baseTitle, nextSequence);
      return nextSequence;
    });
    return formatForkTitle(baseTitle, allocate());
  }

  setDefaultAgent(contextKey: string, agentName: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE user_contexts SET default_agent = ?, updated_at = ? WHERE context_key = ?")
      .run(agentName, now, contextKey);
  }

  setBoundProjectCwd(contextKey: string, cwd?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE user_contexts SET bound_project_cwd = ?, updated_at = ? WHERE context_key = ?")
      .run(cwd ? path.resolve(cwd) : null, now, contextKey);
  }

  setCurrentSession(contextKey: string, localSessionId?: string): void {
    const now = new Date().toISOString();
    if (localSessionId && this.getSession(localSessionId)) {
      this.attachSessionToContext(contextKey, localSessionId);
    }
    this.db
      .prepare(`
        UPDATE user_contexts
        SET previous_session_id = CASE
              WHEN current_session_id IS NOT ? THEN current_session_id
              ELSE previous_session_id
            END,
            current_session_id = ?,
            updated_at = ?
        WHERE context_key = ?
      `)
      .run(localSessionId ?? null, localSessionId ?? null, now, contextKey);
  }

  createSession(input: {
    localSessionId: string;
    contextKey: string;
    agentName: string;
    cwd: string;
    status: SessionStatus;
  }): SessionRecord {
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      this.db.prepare(
        `
        INSERT INTO sessions (
          local_session_id,
          context_key,
          agent_name,
          cwd,
          acp_session_id,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
        `,
      ).run(
        input.localSessionId,
        input.contextKey,
        input.agentName,
        input.cwd,
        input.status,
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO context_sessions (context_key, local_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(input.contextKey, input.localSessionId, now, now);
    });
    create();

    return {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateSession(
    localSessionId: string,
    patch: Partial<Pick<SessionRecord, "acpSessionId" | "status">>,
  ): void {
    const existing = this.getSession(localSessionId);
    if (!existing) {
      return;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE sessions
        SET acp_session_id = ?, status = ?, updated_at = ?
        WHERE local_session_id = ?
        `,
      )
      .run(
        patch.acpSessionId ?? existing.acpSessionId ?? null,
        patch.status ?? existing.status,
        now,
        localSessionId,
      );
  }

  archiveSession(localSessionId: string): void {
    const now = new Date().toISOString();
    const archive = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE sessions
        SET status = 'closed', updated_at = ?
        WHERE local_session_id = ?
      `).run(now, localSessionId);
      this.db.prepare(`
        UPDATE user_contexts
        SET current_session_id = CASE WHEN current_session_id = ? THEN NULL ELSE current_session_id END,
            previous_session_id = CASE WHEN previous_session_id = ? THEN NULL ELSE previous_session_id END,
            updated_at = ?
        WHERE current_session_id = ? OR previous_session_id = ?
      `).run(localSessionId, localSessionId, now, localSessionId, localSessionId);
    });
    archive();
  }

  updateRuntimeSession(
    localSessionId: string,
    patch: Partial<
      Pick<
        SessionRecord,
        "runtimeKind" | "remoteSessionId" | "title" | "modelProvider" | "model" | "reasoningEffort" | "permissionMode" | "lastTurnId" | "lastTurnStatus"
      >
    >,
  ): void {
    const existing = this.getSession(localSessionId);
    if (!existing) {
      return;
    }

    this.db
      .prepare(
        `
        UPDATE sessions
        SET runtime_kind = ?, remote_session_id = ?, title = ?, model_provider = ?, model = ?, reasoning_effort = ?, permission_mode = ?,
            last_turn_id = ?, last_turn_status = ?, updated_at = ?
        WHERE local_session_id = ?
        `,
      )
      .run(
        patch.runtimeKind ?? existing.runtimeKind ?? null,
        patch.remoteSessionId ?? existing.remoteSessionId ?? existing.acpSessionId ?? null,
        patch.title ?? existing.title ?? null,
        patch.modelProvider ?? existing.modelProvider ?? null,
        patch.model ?? existing.model ?? null,
        patch.reasoningEffort ?? existing.reasoningEffort ?? null,
        patch.permissionMode ?? existing.permissionMode ?? null,
        patch.lastTurnId ?? existing.lastTurnId ?? null,
        patch.lastTurnStatus ?? existing.lastTurnStatus ?? null,
        new Date().toISOString(),
        localSessionId,
      );
  }

  saveTurnSnapshot(turnId: string, localSessionId: string, snapshot: unknown, contextKey?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO turn_snapshots (turn_id, local_session_id, context_key, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          local_session_id = excluded.local_session_id,
          context_key = coalesce(excluded.context_key, turn_snapshots.context_key),
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(turnId, localSessionId, contextKey ?? null, JSON.stringify(snapshot), now);
  }

  promotePendingTurn(
    pendingTurnId: string,
    turnId: string,
    localSessionId: string,
    snapshot: unknown,
    contextKey?: string,
  ): void {
    if (pendingTurnId === turnId) {
      this.saveTurnSnapshot(turnId, localSessionId, snapshot, contextKey);
      return;
    }
    this.db.transaction(() => {
      const pendingDelivery = this.getTurnDelivery(pendingTurnId);
      this.saveTurnSnapshot(turnId, localSessionId, snapshot, contextKey);
      if (pendingDelivery) {
        this.saveTurnDelivery(turnId, {
          progressMessageId: pendingDelivery.progressMessageId,
          lastCardHash: pendingDelivery.lastCardHash,
        });
      }
      this.db.prepare("DELETE FROM turn_deliveries WHERE turn_id = ?").run(pendingTurnId);
      this.db.prepare("DELETE FROM turn_snapshots WHERE turn_id = ?").run(pendingTurnId);
    })();
  }

  getTurnSnapshot(turnId: string): unknown {
    const row = this.db
      .prepare("SELECT snapshot_json FROM turn_snapshots WHERE turn_id = ?")
      .get(turnId) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) : undefined;
  }

  findLatestTurnSnapshotForSession(localSessionId: string): PersistedTurnSnapshotRecord | undefined {
    const row = this.db.prepare(`
      SELECT turn_id, local_session_id, context_key, snapshot_json, updated_at
      FROM turn_snapshots
      WHERE local_session_id = ?
      ORDER BY
        coalesce(json_extract(snapshot_json, '$.startedAt'), 0) DESC,
        updated_at DESC,
        rowid DESC
      LIMIT 1
    `).get(localSessionId) as {
      turn_id: string;
      local_session_id: string;
      context_key: string | null;
      snapshot_json: string;
      updated_at: string;
    } | undefined;
    return row
      ? {
          turnId: row.turn_id,
          localSessionId: row.local_session_id,
          contextKey: row.context_key ?? undefined,
          snapshot: JSON.parse(row.snapshot_json),
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  saveTurnRuntimeOrigin(
    turnId: string,
    localSessionId: string,
    agentName: string,
    remoteSessionId: string,
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO turn_runtime_origins (
        turn_id, local_session_id, agent_name, remote_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(turnId, localSessionId, agentName, remoteSessionId, new Date().toISOString());
  }

  getTurnRuntimeOrigin(turnId: string): TurnRuntimeOriginRecord | undefined {
    const row = this.db.prepare(`
      SELECT turn_id, local_session_id, agent_name, remote_session_id, created_at
      FROM turn_runtime_origins
      WHERE turn_id = ?
    `).get(turnId) as {
      turn_id: string;
      local_session_id: string;
      agent_name: string;
      remote_session_id: string;
      created_at: string;
    } | undefined;
    return row
      ? {
          turnId: row.turn_id,
          localSessionId: row.local_session_id,
          agentName: row.agent_name,
          remoteSessionId: row.remote_session_id,
          createdAt: row.created_at,
        }
      : undefined;
  }

  saveTurnParent(turnId: string, localSessionId: string, parentTurnId?: string): void {
    this.db.prepare(`
      INSERT INTO turn_parent_links (
        turn_id, local_session_id, parent_turn_id, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        parent_turn_id = excluded.parent_turn_id
      WHERE turn_parent_links.parent_turn_id IS NULL
        AND excluded.parent_turn_id IS NOT NULL
    `).run(turnId, localSessionId, parentTurnId ?? null, new Date().toISOString());
  }

  importCompletedTurnHistory(input: {
    localSessionId: string;
    contextKey: string;
    agentName: string;
    remoteSessionId: string;
    turns: ImportedCompletedTurnRecord[];
  }): void {
    const importHistory = this.db.transaction(() => {
      let parentTurnId: string | undefined;
      for (const turn of input.turns) {
        this.db.prepare(`
          INSERT OR IGNORE INTO turn_snapshots (
            turn_id, local_session_id, context_key, snapshot_json, updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          turn.turnId,
          input.localSessionId,
          input.contextKey,
          JSON.stringify(turn.snapshot),
          turn.updatedAt,
        );
        this.db.prepare(`
          INSERT OR IGNORE INTO turn_runtime_origins (
            turn_id, local_session_id, agent_name, remote_session_id, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          turn.turnId,
          input.localSessionId,
          input.agentName,
          input.remoteSessionId,
          turn.updatedAt,
        );
        this.saveTurnParent(turn.turnId, input.localSessionId, parentTurnId);
        parentTurnId = turn.turnId;
      }
    });
    importHistory();
  }

  getTurnParent(turnId: string, localSessionId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT parent_turn_id
      FROM turn_parent_links
      WHERE turn_id = ? AND local_session_id = ?
    `).get(turnId, localSessionId) as { parent_turn_id: string | null } | undefined;
    return row?.parent_turn_id ?? undefined;
  }

  findLatestCompletedTurnId(localSessionId: string, contextKey: string): string | undefined {
    const row = this.db
      .prepare(`
        SELECT turn_id
        FROM turn_snapshots
        WHERE local_session_id = ?
          AND context_key = ?
          AND json_extract(snapshot_json, '$.status') = 'completed'
        ORDER BY
          coalesce(
            json_extract(snapshot_json, '$.completedAt'),
            json_extract(snapshot_json, '$.startedAt'),
            0
          ) DESC,
          updated_at DESC
        LIMIT 1
      `)
      .get(localSessionId, contextKey) as { turn_id: string } | undefined;
    return row?.turn_id;
  }

  countCompletedTurnSnapshots(localSessionId: string, contextKey: string): number {
    const row = this.db.prepare(`
      SELECT count(*) AS count
      FROM turn_snapshots
      WHERE local_session_id = ?
        AND context_key = ?
        AND json_extract(snapshot_json, '$.status') = 'completed'
    `).get(localSessionId, contextKey) as { count: number };
    return row.count;
  }

  listCompletedTurnSnapshots(
    localSessionId: string,
    contextKey: string,
    limit: number,
    offset = 0,
  ): CompletedTurnSnapshotRecord[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const normalizedOffset = Math.max(0, Math.trunc(offset));
    const rows = this.db.prepare(`
      SELECT turn_id, snapshot_json, updated_at
      FROM turn_snapshots
      WHERE local_session_id = ?
        AND context_key = ?
        AND json_extract(snapshot_json, '$.status') = 'completed'
      ORDER BY
        coalesce(
          json_extract(snapshot_json, '$.completedAt'),
          json_extract(snapshot_json, '$.startedAt'),
          0
        ) DESC,
        updated_at DESC
      LIMIT ? OFFSET ?
    `).all(localSessionId, contextKey, normalizedLimit, normalizedOffset) as Array<{
      turn_id: string;
      snapshot_json: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      turnId: row.turn_id,
      snapshot: JSON.parse(row.snapshot_json),
      updatedAt: row.updated_at,
    }));
  }

  listCompletedTurnGraph(
    localSessionId: string,
    contextKey: string,
  ): CompletedTurnSnapshotRecord[] {
    this.backfillTurnParents(localSessionId);
    const rows = this.db.prepare(`
      SELECT ts.turn_id, tpl.parent_turn_id, ts.snapshot_json, ts.updated_at
      FROM turn_snapshots ts
      LEFT JOIN turn_parent_links tpl ON tpl.turn_id = ts.turn_id
      WHERE ts.local_session_id = ?
        AND ts.context_key = ?
        AND json_extract(ts.snapshot_json, '$.status') = 'completed'
      ORDER BY
        coalesce(
          json_extract(ts.snapshot_json, '$.completedAt'),
          json_extract(ts.snapshot_json, '$.startedAt'),
          0
        ) DESC,
        ts.updated_at DESC
    `).all(localSessionId, contextKey) as Array<{
      turn_id: string;
      parent_turn_id: string | null;
      snapshot_json: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      turnId: row.turn_id,
      parentTurnId: row.parent_turn_id ?? undefined,
      snapshot: JSON.parse(row.snapshot_json),
      updatedAt: row.updated_at,
    }));
  }

  hasTaskHistoryTurn(localSessionId: string, turnId: string): boolean {
    const readParent = this.db.prepare(`
      SELECT ts.local_session_id, tpl.parent_turn_id
      FROM turn_snapshots ts
      LEFT JOIN turn_parent_links tpl ON tpl.turn_id = ts.turn_id
      WHERE ts.turn_id = ?
        AND json_extract(ts.snapshot_json, '$.status') = 'completed'
    `);
    type ParentRow = { local_session_id: string; parent_turn_id: string | null };
    const target = readParent.get(turnId) as ParentRow | undefined;
    if (!target) return false;
    if (target.local_session_id === localSessionId) return true;

    const backfilledSessions = new Set<string>();
    let ancestorTurnId = this.findForkSourceTurnId(localSessionId);
    if (!ancestorTurnId) {
      // Reset-only legacy tasks may have partially saved cross-session links.
      this.backfillTurnParents(localSessionId);
      backfilledSessions.add(localSessionId);
      ancestorTurnId = this.findCrossSessionParentTurnId(localSessionId);
    }
    const visited = new Set<string>();
    while (ancestorTurnId && !visited.has(ancestorTurnId)) {
      if (ancestorTurnId === turnId) return true;
      visited.add(ancestorTurnId);
      const ancestor = readParent.get(ancestorTurnId) as ParentRow | undefined;
      if (!ancestor) return false;
      let parentTurnId = ancestor.parent_turn_id;
      // Older snapshots may lack parent links. Repair each owner at most once,
      // without loading full snapshots or rebuilding already linked ancestry.
      if (!parentTurnId && !backfilledSessions.has(ancestor.local_session_id)) {
        this.backfillTurnParents(ancestor.local_session_id);
        backfilledSessions.add(ancestor.local_session_id);
        parentTurnId = (readParent.get(ancestorTurnId) as ParentRow | undefined)?.parent_turn_id ?? null;
      }
      ancestorTurnId = parentTurnId ?? undefined;
    }
    return false;
  }

  listTaskTurnGraph(localSessionId: string): CompletedTurnSnapshotRecord[] {
    this.backfillTurnParents(localSessionId);
    const records = new Map(
      this.listCompletedTurnGraphRows(localSessionId).map((record) => [record.turnId, record]),
    );
    let ancestorTurnId = this.findForkSourceTurnId(localSessionId)
      ?? this.findCrossSessionParentTurnId(localSessionId);
    const visited = new Set<string>();

    while (ancestorTurnId && !visited.has(ancestorTurnId)) {
      visited.add(ancestorTurnId);
      const ancestor = this.getCompletedTurnGraphRecord(ancestorTurnId);
      if (!ancestor) break;
      records.set(ancestor.turnId, ancestor);
      ancestorTurnId = ancestor.parentTurnId;
    }

    return [...records.values()].sort(compareCompletedTurnSnapshots);
  }

  getForkHistorySource(localSessionId: string): ForkHistorySourceRecord | undefined {
    const row = this.db.prepare(`
      SELECT payload_json, created_at
      FROM audit_events
      WHERE event_type IN ('session_forked', 'thread_forked')
        AND json_extract(payload_json, '$.forkedLocalSessionId') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(localSessionId) as { payload_json: string; created_at: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const sourceTurnId = stringValue(payload.sourceTurnId);
    if (!sourceTurnId) return undefined;
    return {
      sourceLocalSessionId: stringValue(payload.sourceLocalSessionId),
      sourceRemoteSessionId: stringValue(payload.sourceRemoteSessionId),
      sourceTurnId,
      sourceTurnPrompt: stringValue(payload.sourceTurnPrompt),
      sourceTurnStartedAt: numberValue(payload.sourceTurnStartedAt),
      sourceTurnCompletedAt: numberValue(payload.sourceTurnCompletedAt),
      sourceTurnHistoryCount: numberValue(payload.sourceTurnHistoryCount),
      createdAt: row.created_at,
    };
  }

  hasImportedForkTurnHistory(localSessionId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM audit_events
      WHERE event_type = 'fork_turn_history_imported'
        AND json_extract(payload_json, '$.forkedLocalSessionId') = ?
      LIMIT 1
    `).get(localSessionId));
  }

  private listCompletedTurnGraphRows(localSessionId: string): CompletedTurnSnapshotRecord[] {
    const rows = this.db.prepare(`
      SELECT ts.turn_id, tpl.parent_turn_id, ts.snapshot_json, ts.updated_at
      FROM turn_snapshots ts
      LEFT JOIN turn_parent_links tpl ON tpl.turn_id = ts.turn_id
      WHERE ts.local_session_id = ?
        AND json_extract(ts.snapshot_json, '$.status') = 'completed'
    `).all(localSessionId) as Array<{
      turn_id: string;
      parent_turn_id: string | null;
      snapshot_json: string;
      updated_at: string;
    }>;
    return rows.map(mapCompletedTurnSnapshot);
  }

  private getCompletedTurnGraphRecord(turnId: string): CompletedTurnSnapshotRecord | undefined {
    const owner = this.db.prepare(`
      SELECT local_session_id
      FROM turn_snapshots
      WHERE turn_id = ?
        AND json_extract(snapshot_json, '$.status') = 'completed'
    `).get(turnId) as { local_session_id: string } | undefined;
    if (!owner) return undefined;
    this.backfillTurnParents(owner.local_session_id);
    const row = this.db.prepare(`
      SELECT ts.turn_id, tpl.parent_turn_id, ts.snapshot_json, ts.updated_at
      FROM turn_snapshots ts
      LEFT JOIN turn_parent_links tpl ON tpl.turn_id = ts.turn_id
      WHERE ts.turn_id = ?
        AND json_extract(ts.snapshot_json, '$.status') = 'completed'
    `).get(turnId) as {
      turn_id: string;
      parent_turn_id: string | null;
      snapshot_json: string;
      updated_at: string;
    } | undefined;
    return row ? mapCompletedTurnSnapshot(row) : undefined;
  }

  private findForkSourceTurnId(localSessionId: string): string | undefined {
    return this.getForkHistorySource(localSessionId)?.sourceTurnId;
  }

  private findCrossSessionParentTurnId(localSessionId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT links.parent_turn_id
      FROM turn_parent_links links
      JOIN turn_snapshots parent ON parent.turn_id = links.parent_turn_id
      WHERE links.local_session_id = ?
        AND parent.local_session_id <> ?
      ORDER BY links.created_at ASC
      LIMIT 1
    `).get(localSessionId, localSessionId) as { parent_turn_id: string } | undefined;
    return row?.parent_turn_id;
  }

  private backfillTurnParents(localSessionId: string): void {
    const turns = this.db.prepare(`
      SELECT
        turn_id,
        coalesce(
          json_extract(snapshot_json, '$.startedAt'),
          json_extract(snapshot_json, '$.completedAt'),
          cast(strftime('%s', updated_at) AS INTEGER) * 1000,
          0
        ) AS started_at
      FROM turn_snapshots
      WHERE local_session_id = ?
        AND json_extract(snapshot_json, '$.status') = 'completed'
      ORDER BY started_at ASC, updated_at ASC
    `).all(localSessionId) as Array<{ turn_id: string; started_at: number }>;
    if (turns.length === 0) return;

    const resets = (this.db.prepare(`
      SELECT payload_json, created_at
      FROM audit_events
      WHERE event_type = 'session_reset_to_turn'
        AND json_extract(payload_json, '$.localSessionId') = ?
      ORDER BY created_at ASC, id ASC
    `).all(localSessionId) as Array<{ payload_json: string; created_at: string }>).flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as { resetTurnId?: unknown };
        const resetTurnId = typeof payload.resetTurnId === "string" ? payload.resetTurnId : undefined;
        const at = Date.parse(row.created_at);
        return resetTurnId && Number.isFinite(at) ? [{ resetTurnId, at }] : [];
      } catch {
        return [];
      }
    });

    let headTurnId: string | undefined;
    let resetIndex = 0;
    const upsert = this.db.prepare(`
      INSERT INTO turn_parent_links (
        turn_id, local_session_id, parent_turn_id, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        parent_turn_id = excluded.parent_turn_id
      WHERE turn_parent_links.parent_turn_id IS NULL
        AND excluded.parent_turn_id IS NOT NULL
    `);
    const backfill = this.db.transaction(() => {
      for (const turn of turns) {
        while (resetIndex < resets.length && resets[resetIndex]!.at <= turn.started_at) {
          headTurnId = resets[resetIndex]!.resetTurnId;
          resetIndex += 1;
        }
        upsert.run(turn.turn_id, localSessionId, headTurnId ?? null, new Date().toISOString());
        headTurnId = turn.turn_id;
      }
    });
    backfill();
  }

  saveTurnDelivery(
    turnId: string,
    patch: { progressMessageId?: string; lastCardHash?: string },
  ): void {
    const existing = this.getTurnDelivery(turnId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO turn_deliveries (
          turn_id, progress_message_id, final_message_ids_json, final_delivered_at, last_card_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          progress_message_id = excluded.progress_message_id,
          last_card_hash = excluded.last_card_hash,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        turnId,
        patch.progressMessageId ?? existing?.progressMessageId ?? null,
        JSON.stringify(existing?.finalMessageIds ?? []),
        existing?.finalDeliveredAt ?? null,
        patch.lastCardHash ?? existing?.lastCardHash ?? null,
        now,
      );
  }

  markFinalDelivered(turnId: string, messageIds: string[]): void {
    const now = new Date().toISOString();
    const existing = this.getTurnDelivery(turnId);
    this.db
      .prepare(
        `
        INSERT INTO turn_deliveries (
          turn_id, progress_message_id, final_message_ids_json, final_delivered_at, last_card_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          final_message_ids_json = excluded.final_message_ids_json,
          final_delivered_at = excluded.final_delivered_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        turnId,
        existing?.progressMessageId ?? null,
        JSON.stringify(messageIds),
        now,
        existing?.lastCardHash ?? null,
        now,
      );
  }

  saveFinalDeliveryProgress(turnId: string, messageIds: string[]): void {
    const now = new Date().toISOString();
    const existing = this.getTurnDelivery(turnId);
    this.db
      .prepare(
        `
        INSERT INTO turn_deliveries (
          turn_id, progress_message_id, final_message_ids_json, final_delivered_at, last_card_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          final_message_ids_json = excluded.final_message_ids_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        turnId,
        existing?.progressMessageId ?? null,
        JSON.stringify(messageIds),
        existing?.finalDeliveredAt ?? null,
        existing?.lastCardHash ?? null,
        now,
      );
  }

  getTurnDelivery(turnId: string):
    | {
        progressMessageId?: string;
        finalMessageIds: string[];
        finalDelivered: boolean;
        finalDeliveredAt?: string;
        lastCardHash?: string;
      }
    | undefined {
    const row = this.db
      .prepare("SELECT * FROM turn_deliveries WHERE turn_id = ?")
      .get(turnId) as
      | {
          progress_message_id: string | null;
          final_message_ids_json: string;
          final_delivered_at: string | null;
          last_card_hash: string | null;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      progressMessageId: row.progress_message_id ?? undefined,
      finalMessageIds: JSON.parse(row.final_message_ids_json) as string[],
      finalDelivered: Boolean(row.final_delivered_at),
      finalDeliveredAt: row.final_delivered_at ?? undefined,
      lastCardHash: row.last_card_hash ?? undefined,
    };
  }

  getSession(localSessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE local_session_id = ?")
      .get(localSessionId) as SessionRow | undefined;

    return row ? mapSession(row) : undefined;
  }

  getSessionForContext(localSessionId: string, contextKey: string): SessionRecord | undefined {
    const linked = this.db.prepare(`
      SELECT 1
      FROM context_sessions
      WHERE context_key = ? AND local_session_id = ?
    `).get(contextKey, localSessionId);
    if (!linked) return undefined;
    const session = this.getSession(localSessionId);
    return session ? { ...session, contextKey } : undefined;
  }

  attachSessionToContext(contextKey: string, localSessionId: string): void {
    if (!this.getSession(localSessionId)) throw new Error(`找不到任务：${localSessionId}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO context_sessions (context_key, local_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(context_key, local_session_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(contextKey, localSessionId, now, now);
  }

  listSessions(contextKey: string): SessionRecord[] {
    const rows = this.db
      .prepare(`
        SELECT sessions.*
        FROM context_sessions
        JOIN sessions ON sessions.local_session_id = context_sessions.local_session_id
        WHERE context_sessions.context_key = ?
        ORDER BY context_sessions.created_at DESC
      `)
      .all(contextKey) as SessionRow[];

    return rows.map((row) => ({ ...mapSession(row), contextKey }));
  }

  listSessionsForChat(contextKey: string): SessionRecord[] {
    const threadPrefix = `${contextKey}:thread_id:`;
    const rows = this.db.prepare(`
      SELECT DISTINCT sessions.*
      FROM context_sessions
      JOIN sessions ON sessions.local_session_id = context_sessions.local_session_id
      WHERE context_sessions.context_key = ? OR instr(context_sessions.context_key, ?) = 1
      ORDER BY sessions.updated_at DESC
    `).all(contextKey, threadPrefix) as SessionRow[];
    return rows.map(mapSession);
  }

  listAllSessions(): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC")
      .all() as SessionRow[];
    return rows.map(mapSession);
  }

  listUndeliveredCompletedTurns(): TurnAnchorRecord[] {
    const rows = this.db.prepare(`
      SELECT snapshots.turn_id, snapshots.local_session_id, snapshots.context_key
      FROM turn_snapshots AS snapshots
      LEFT JOIN turn_deliveries AS deliveries ON deliveries.turn_id = snapshots.turn_id
      WHERE json_extract(snapshots.snapshot_json, '$.status') = 'completed'
        AND length(coalesce(json_extract(snapshots.snapshot_json, '$.finalResponse'), '')) > 0
        AND deliveries.final_delivered_at IS NULL
      ORDER BY snapshots.updated_at ASC
    `).all() as Array<{
      turn_id: string;
      local_session_id: string;
      context_key: string | null;
    }>;
    return rows.map((row) => ({
      turnId: row.turn_id,
      localSessionId: row.local_session_id,
      contextKey: row.context_key ?? undefined,
    }));
  }

  findMessageIdForTurn(turnId: string): string | undefined {
    const binding = this.db.prepare(`
      SELECT message_id
      FROM message_turn_bindings
      WHERE turn_id = ?
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1
    `).get(turnId) as { message_id: string } | undefined;
    if (binding) return binding.message_id;
    const reaction = this.db.prepare(`
      SELECT message_id
      FROM message_reactions
      WHERE turn_id = ?
      ORDER BY updated_at DESC, rowid DESC
      LIMIT 1
    `).get(turnId) as { message_id: string } | undefined;
    return reaction?.message_id;
  }

  findLatestMessageIdForSession(localSessionId: string, contextKey?: string): string | undefined {
    const row = this.db.prepare(`
      SELECT message_id
      FROM message_reactions
      WHERE local_session_id = ?
        AND (? IS NULL OR context_key = ?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(localSessionId, contextKey ?? null, contextKey ?? null) as { message_id: string } | undefined;
    return row?.message_id;
  }

  findLatestMessageIdForContext(contextKey: string): string | undefined {
    const row = this.db.prepare(`
      SELECT json_extract(payload_json, '$.messageId') AS message_id
      FROM audit_events
      WHERE context_key = ?
        AND event_type = 'incoming_message'
        AND json_type(payload_json, '$.messageId') = 'text'
      ORDER BY id DESC
      LIMIT 1
    `).get(contextKey) as { message_id: string } | undefined;
    return row?.message_id;
  }

  getServerActivityState(): {
    runningSessions: number;
    pendingFinalDeliveries: number;
    latestInboundAt?: string;
  } {
    const running = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM sessions
        WHERE status = 'running'
           OR EXISTS (
             SELECT 1 FROM queued_prompts WHERE queued_prompts.local_session_id = sessions.local_session_id
           )
      `)
      .get() as { count: number };
    const pending = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM sessions x
      JOIN turn_snapshots s ON s.turn_id = x.last_turn_id
      LEFT JOIN turn_deliveries d ON d.turn_id = s.turn_id
      WHERE json_extract(s.snapshot_json, '$.status') = 'completed'
        AND length(coalesce(json_extract(s.snapshot_json, '$.finalResponse'), '')) > 0
        AND d.final_delivered_at IS NULL
    `).get() as { count: number };
    const inbound = this.db
      .prepare("SELECT max(created_at) AS latest FROM inbound_event_receipts")
      .get() as { latest: string | null };
    return {
      runningSessions: running.count,
      pendingFinalDeliveries: pending.count,
      latestInboundAt: inbound.latest ?? undefined,
    };
  }

  findSessionByRemoteSessionId(
    remoteSessionId: string,
    contextKey?: string,
    agentName?: string,
  ): SessionRecord | undefined {
    const row = contextKey
      ? this.db
          .prepare(`
            SELECT sessions.*
            FROM sessions
            JOIN context_sessions ON context_sessions.local_session_id = sessions.local_session_id
            WHERE sessions.remote_session_id = ?
              AND context_sessions.context_key = ?
              AND (? IS NULL OR sessions.agent_name = ?)
              AND sessions.status != 'closed'
            LIMIT 1
          `)
          .get(remoteSessionId, contextKey, agentName ?? null, agentName ?? null) as SessionRow | undefined
      : this.db
          .prepare(`
            SELECT * FROM sessions
            WHERE remote_session_id = ?
              AND (? IS NULL OR agent_name = ?)
              AND status != 'closed'
            ORDER BY created_at ASC LIMIT 1
          `)
          .get(remoteSessionId, agentName ?? null, agentName ?? null) as SessionRow | undefined;
    return row ? { ...mapSession(row), ...(contextKey ? { contextKey } : {}) } : undefined;
  }

  getTurnContextKey(turnId: string): string | undefined {
    const row = this.db.prepare("SELECT context_key FROM turn_snapshots WHERE turn_id = ?")
      .get(turnId) as { context_key: string | null } | undefined;
    return row?.context_key ?? undefined;
  }

  audit(contextKey: string, eventType: string, payload: unknown): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_events (context_key, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
        `,
      )
      .run(contextKey, eventType, JSON.stringify(payload), new Date().toISOString());
  }

  hasInjectedTopicRoot(localSessionId: string, rootMessageId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM audit_events
      WHERE event_type = 'topic_root_injected'
        AND json_extract(payload_json, '$.localSessionId') = ?
        AND json_extract(payload_json, '$.rootMessageId') = ?
      LIMIT 1
    `).get(localSessionId, rootMessageId));
  }

  claimInboundEvent(eventId: string, eventKind: "message" | "card_action"): boolean {
    const result = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO inbound_event_receipts (event_id, event_kind, created_at)
        VALUES (?, ?, ?)
        `,
      )
      .run(eventId, eventKind, new Date().toISOString());
    return result.changes === 1;
  }

  saveMessageReaction(messageId: string, contextKey: string, reactionId: string, emojiType: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO message_reactions (
        message_id, context_key, reaction_id, emoji_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        context_key = excluded.context_key,
        reaction_id = excluded.reaction_id,
        emoji_type = excluded.emoji_type,
        status = 'pending',
        updated_at = excluded.updated_at
    `).run(messageId, contextKey, reactionId, emojiType, now, now);
  }

  bindMessageReaction(messageId: string, localSessionId: string, turnId: string): void {
    this.db.prepare(`
      UPDATE message_reactions
      SET local_session_id = ?, turn_id = ?, updated_at = ?
      WHERE message_id = ? AND status = 'pending'
    `).run(localSessionId, turnId, new Date().toISOString(), messageId);
  }

  bindMessageToTurn(messageId: string, localSessionId: string, turnId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO message_turn_bindings (message_id, local_session_id, turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        local_session_id = excluded.local_session_id,
        turn_id = excluded.turn_id,
        updated_at = excluded.updated_at
    `).run(messageId, localSessionId, turnId, now, now);
  }

  claimMessageReactionsForTurn(turnId: string): MessageReactionRecord[] {
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM message_reactions WHERE turn_id = ? AND status = 'pending' ORDER BY created_at ASC
      `).all(turnId) as MessageReactionRow[];
      if (rows.length > 0) {
        this.db.prepare(`
          UPDATE message_reactions SET status = 'updating', updated_at = ?
          WHERE turn_id = ? AND status = 'pending'
        `).run(new Date().toISOString(), turnId);
      }
      return rows.map((row) => ({ ...mapMessageReaction(row), status: "updating" as const }));
    });
    return claim();
  }

  claimMessageReaction(messageId: string): MessageReactionRecord | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM message_reactions WHERE message_id = ? AND status = 'pending'
      `).get(messageId) as MessageReactionRow | undefined;
      if (!row) return undefined;
      this.db.prepare(`
        UPDATE message_reactions SET status = 'updating', updated_at = ? WHERE message_id = ? AND status = 'pending'
      `).run(new Date().toISOString(), messageId);
      return { ...mapMessageReaction(row), status: "updating" as const };
    });
    return claim();
  }

  listPendingMessageReactions(): MessageReactionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM message_reactions WHERE status = 'pending' AND turn_id IS NOT NULL ORDER BY created_at ASC
    `).all() as MessageReactionRow[];
    return rows.map(mapMessageReaction);
  }

  finishMessageReaction(
    messageId: string,
    reactionId: string,
    emojiType: string,
    status: Exclude<MessageReactionStatus, "pending" | "updating">,
  ): void {
    this.db.prepare(`
      UPDATE message_reactions
      SET reaction_id = ?, emoji_type = ?, status = ?, updated_at = ?
      WHERE message_id = ?
    `).run(reactionId, emojiType, status, new Date().toISOString(), messageId);
  }

  releaseMessageReaction(messageId: string): void {
    this.db.prepare(`
      UPDATE message_reactions SET status = 'pending', updated_at = ?
      WHERE message_id = ? AND status = 'updating'
    `).run(new Date().toISOString(), messageId);
  }

  getMessageReaction(messageId: string): MessageReactionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM message_reactions WHERE message_id = ?")
      .get(messageId) as MessageReactionRow | undefined;
    return row ? mapMessageReaction(row) : undefined;
  }

  findTurnAnchorByMessageId(messageId: string): TurnAnchorRecord | undefined {
    const binding = this.db.prepare(`
      SELECT turn_id, local_session_id
      FROM message_turn_bindings
      WHERE message_id = ?
      LIMIT 1
    `).get(messageId) as { turn_id: string; local_session_id: string } | undefined;
    if (binding) {
      return {
        turnId: binding.turn_id,
        localSessionId: binding.local_session_id,
        contextKey: this.getTurnContextKey(binding.turn_id),
      };
    }

    const reaction = this.db.prepare(`
      SELECT turn_id, local_session_id
      FROM message_reactions
      WHERE message_id = ? AND turn_id IS NOT NULL AND local_session_id IS NOT NULL
      LIMIT 1
    `).get(messageId) as { turn_id: string; local_session_id: string } | undefined;
    if (reaction) {
      const context = this.db.prepare("SELECT context_key FROM message_reactions WHERE message_id = ?")
        .get(messageId) as { context_key: string } | undefined;
      return {
        turnId: reaction.turn_id,
        localSessionId: reaction.local_session_id,
        contextKey: context?.context_key ?? this.getTurnContextKey(reaction.turn_id),
      };
    }

    const delivery = this.db.prepare(`
      SELECT deliveries.turn_id, snapshots.local_session_id
      FROM turn_deliveries AS deliveries
      JOIN turn_snapshots AS snapshots ON snapshots.turn_id = deliveries.turn_id
      WHERE deliveries.progress_message_id = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(deliveries.final_message_ids_json)
           WHERE json_each.value = ?
         )
      ORDER BY deliveries.updated_at DESC
      LIMIT 1
    `).get(messageId, messageId) as { turn_id: string; local_session_id: string } | undefined;
    return delivery
      ? {
          turnId: delivery.turn_id,
          localSessionId: delivery.local_session_id,
          contextKey: this.getTurnContextKey(delivery.turn_id),
        }
      : undefined;
  }

  findAgentBotTurnMessageById(messageId: string): AgentBotTurnMessageRecord | undefined {
    const row = this.db.prepare(`
      SELECT deliveries.turn_id, snapshots.local_session_id,
        CASE WHEN deliveries.progress_message_id = ? THEN 'progress' ELSE 'final' END AS message_kind
      FROM turn_deliveries AS deliveries
      JOIN turn_snapshots AS snapshots ON snapshots.turn_id = deliveries.turn_id
      WHERE deliveries.progress_message_id = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(deliveries.final_message_ids_json)
           WHERE json_each.value = ?
         )
      ORDER BY deliveries.updated_at DESC
      LIMIT 1
    `).get(messageId, messageId, messageId) as {
      turn_id: string;
      local_session_id: string;
      message_kind: "progress" | "final";
    } | undefined;
    return row
      ? {
          turnId: row.turn_id,
          localSessionId: row.local_session_id,
          contextKey: this.getTurnContextKey(row.turn_id),
          messageKind: row.message_kind,
        }
      : undefined;
  }

  private initializeContextSessionMappings(): void {
    this.db.exec(`
      INSERT OR IGNORE INTO context_sessions (context_key, local_session_id, created_at, updated_at)
      SELECT context_key, local_session_id, created_at, updated_at FROM sessions;

      UPDATE turn_snapshots
      SET context_key = (
        SELECT sessions.context_key
        FROM sessions
        WHERE sessions.local_session_id = turn_snapshots.local_session_id
      )
      WHERE context_key IS NULL;
    `);
  }

  private reconcileDuplicateRemoteSessions(): void {
    const duplicateIds = this.db.prepare(`
      SELECT agent_name, remote_session_id
      FROM sessions
      WHERE remote_session_id IS NOT NULL
      GROUP BY agent_name, remote_session_id
      HAVING count(*) > 1
    `).all() as Array<{ agent_name: string; remote_session_id: string }>;
    if (duplicateIds.length === 0) return;

    const reconcile = this.db.transaction(() => {
      for (const { agent_name: agentName, remote_session_id: remoteSessionId } of duplicateIds) {
        const rows = this.db.prepare(`
          SELECT * FROM sessions
          WHERE agent_name = ? AND remote_session_id = ?
          ORDER BY created_at ASC
        `).all(agentName, remoteSessionId) as SessionRow[];
        const canonical = rows[0];
        if (!canonical) continue;
        const latest = [...rows].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? canonical;

        for (const duplicate of rows.slice(1)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO context_sessions (context_key, local_session_id, created_at, updated_at)
            SELECT context_key, ?, created_at, updated_at
            FROM context_sessions
            WHERE local_session_id = ?
          `).run(canonical.local_session_id, duplicate.local_session_id);
          this.db.prepare(`
            UPDATE user_contexts
            SET current_session_id = CASE WHEN current_session_id = ? THEN ? ELSE current_session_id END,
                previous_session_id = CASE WHEN previous_session_id = ? THEN ? ELSE previous_session_id END
          `).run(
            duplicate.local_session_id,
            canonical.local_session_id,
            duplicate.local_session_id,
            canonical.local_session_id,
          );
          this.db.prepare("UPDATE turn_snapshots SET local_session_id = ? WHERE local_session_id = ?")
            .run(canonical.local_session_id, duplicate.local_session_id);
          this.db.prepare("UPDATE message_reactions SET local_session_id = ? WHERE local_session_id = ?")
            .run(canonical.local_session_id, duplicate.local_session_id);
          this.db.prepare("UPDATE message_turn_bindings SET local_session_id = ? WHERE local_session_id = ?")
            .run(canonical.local_session_id, duplicate.local_session_id);
          this.db.prepare("UPDATE queued_prompts SET local_session_id = ? WHERE local_session_id = ?")
            .run(canonical.local_session_id, duplicate.local_session_id);
          this.db.prepare("DELETE FROM context_sessions WHERE local_session_id = ?")
            .run(duplicate.local_session_id);
          this.db.prepare("DELETE FROM sessions WHERE local_session_id = ?")
            .run(duplicate.local_session_id);
        }

        this.db.prepare(`
          UPDATE sessions
          SET agent_name = ?, cwd = ?, acp_session_id = ?, runtime_kind = ?, title = ?, model_provider = ?, model = ?,
              reasoning_effort = ?, permission_mode = ?, last_turn_id = ?, last_turn_status = ?,
              status = ?, updated_at = ?
          WHERE local_session_id = ?
        `).run(
          latest.agent_name,
          latest.cwd,
          latest.acp_session_id,
          latest.runtime_kind,
          latest.title,
          latest.model_provider,
          latest.model,
          latest.reasoning_effort,
          latest.permission_mode,
          latest.last_turn_id,
          latest.last_turn_status,
          latest.status,
          latest.updated_at,
          canonical.local_session_id,
        );

        this.db.prepare(`
          UPDATE turn_snapshots
          SET snapshot_json = json_set(snapshot_json, '$.sessionId', ?)
          WHERE local_session_id = ? AND json_valid(snapshot_json)
        `).run(canonical.local_session_id, canonical.local_session_id);
      }
    });
    reconcile();
  }

  private ensureSessionColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(sessions)") as Array<{ name: string }>).map((column) => column.name),
    );
    const columns: Array<[string, string]> = [
      ["runtime_kind", "TEXT"],
      ["remote_session_id", "TEXT"],
      ["title", "TEXT"],
      ["model_provider", "TEXT"],
      ["model", "TEXT"],
      ["reasoning_effort", "TEXT"],
      ["permission_mode", "TEXT"],
      ["last_turn_id", "TEXT"],
      ["last_turn_status", "TEXT"],
    ];
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private ensureUserContextColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(user_contexts)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("previous_session_id")) {
      this.db.exec("ALTER TABLE user_contexts ADD COLUMN previous_session_id TEXT");
    }
    if (!existing.has("bound_project_cwd")) {
      this.db.exec("ALTER TABLE user_contexts ADD COLUMN bound_project_cwd TEXT");
    }
  }

  private ensureTurnSnapshotColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(turn_snapshots)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("context_key")) {
      this.db.exec("ALTER TABLE turn_snapshots ADD COLUMN context_key TEXT");
    }
  }

  private ensureChatContextColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(chat_contexts)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("last_activity_at")) {
      this.db.exec("ALTER TABLE chat_contexts ADD COLUMN last_activity_at TEXT");
    }
    if (!existing.has("require_mention")) {
      this.db.exec("ALTER TABLE chat_contexts ADD COLUMN require_mention INTEGER NOT NULL DEFAULT 0");
    }
  }

  private ensureTurnAttemptColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(turn_attempts)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("retry_count")) {
      this.db.exec("ALTER TABLE turn_attempts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  private ensureQueuedPromptColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(queued_prompts)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("display_prompt")) {
      this.db.exec("ALTER TABLE queued_prompts ADD COLUMN display_prompt TEXT");
    }
  }
}

const MAX_TASK_TITLE_LENGTH = 120;
const FORK_TITLE_SUFFIX = /\s*（分支\s+(\d+)）$/u;

function forkBaseTitle(sourceTitle?: string): string {
  let title = sourceTitle?.replace(/\s+/g, " ").trim() || "未命名任务";
  while (FORK_TITLE_SUFFIX.test(title)) title = title.replace(FORK_TITLE_SUFFIX, "").trim();
  return title || "未命名任务";
}

function formatForkTitle(baseTitle: string, sequence: number): string {
  const suffix = `（分支 ${sequence}）`;
  const available = Math.max(1, MAX_TASK_TITLE_LENGTH - suffix.length);
  const truncatedBase = baseTitle.length <= available ? baseTitle : baseTitle.slice(0, available).trimEnd();
  return `${truncatedBase}${suffix}`;
}

function mapUserContext(row: UserContextRow): UserContextRecord {
  return {
    contextKey: row.context_key,
    defaultAgent: row.default_agent,
    currentSessionId: row.current_session_id ?? undefined,
    previousSessionId: row.previous_session_id ?? undefined,
    boundProjectCwd: row.bound_project_cwd ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChatContext(row: ChatContextRow): ChatContextRecord {
  return {
    contextKey: row.context_key,
    chatType: row.chat_type,
    requiresMention: row.require_mention === 1,
    lastActivityAt: row.last_activity_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    localSessionId: row.local_session_id,
    contextKey: row.context_key,
    agentName: row.agent_name,
    cwd: row.cwd,
    acpSessionId: row.acp_session_id ?? undefined,
    runtimeKind: row.runtime_kind ?? (row.acp_session_id ? "acp" : undefined),
    remoteSessionId: row.remote_session_id ?? row.acp_session_id ?? undefined,
    title: row.title ?? undefined,
    modelProvider: row.model_provider ?? undefined,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    lastTurnId: row.last_turn_id ?? undefined,
    lastTurnStatus: row.last_turn_status ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessageReaction(row: MessageReactionRow): MessageReactionRecord {
  return {
    messageId: row.message_id,
    contextKey: row.context_key,
    reactionId: row.reaction_id,
    emojiType: row.emoji_type,
    localSessionId: row.local_session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function goalCardDeliveryFromRow(row: {
  local_session_id: string;
  context_key: string;
  message_id: string;
  updated_at: string;
}): GoalCardDeliveryRecord {
  return {
    localSessionId: row.local_session_id,
    contextKey: row.context_key,
    messageId: row.message_id,
    updatedAt: row.updated_at,
  };
}

function mapQueuedPrompt(row: QueuedPromptRow): QueuedPromptRecord {
  const parsedPaths = JSON.parse(row.local_image_paths_json) as unknown;
  const localImagePaths = Array.isArray(parsedPaths)
    ? parsedPaths.filter((value): value is string => typeof value === "string")
    : [];
  return {
    promptId: row.prompt_id,
    localSessionId: row.local_session_id,
    contextKey: row.context_key,
    text: row.prompt_text,
    displayPrompt: row.display_prompt ?? undefined,
    localImagePaths: localImagePaths.length > 0 ? localImagePaths : undefined,
    messageId: row.message_id ?? undefined,
    replyMessageId: row.reply_message_id ?? undefined,
    createdAt: row.created_at,
  };
}

function mapTurnAttempt(row: TurnAttemptRow): TurnAttemptRecord {
  const parsedPaths = JSON.parse(row.local_image_paths_json) as unknown;
  const localImagePaths = Array.isArray(parsedPaths)
    ? parsedPaths.filter((value): value is string => typeof value === "string")
    : [];
  return {
    attemptId: row.attempt_id,
    localSessionId: row.local_session_id,
    contextKey: row.context_key,
    promptText: row.prompt_text,
    localImagePaths: localImagePaths.length > 0 ? localImagePaths : undefined,
    messageId: row.message_id ?? undefined,
    replyMessageId: row.reply_message_id ?? undefined,
    pendingTurnId: row.pending_turn_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    recoveredFromTurnId: row.recovered_from_turn_id ?? undefined,
    recoveryCount: row.recovery_count,
    retryCount: row.retry_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCompletedTurnSnapshot(row: {
  turn_id: string;
  parent_turn_id: string | null;
  snapshot_json: string;
  updated_at: string;
}): CompletedTurnSnapshotRecord {
  return {
    turnId: row.turn_id,
    parentTurnId: row.parent_turn_id ?? undefined,
    snapshot: JSON.parse(row.snapshot_json),
    updatedAt: row.updated_at,
  };
}

function compareCompletedTurnSnapshots(
  left: CompletedTurnSnapshotRecord,
  right: CompletedTurnSnapshotRecord,
): number {
  const timeDifference = completedTurnTimestamp(right) - completedTurnTimestamp(left);
  return timeDifference || right.updatedAt.localeCompare(left.updatedAt);
}

function completedTurnTimestamp(record: CompletedTurnSnapshotRecord): number {
  const snapshot = record.snapshot && typeof record.snapshot === "object"
    ? record.snapshot as { completedAt?: unknown; startedAt?: unknown }
    : undefined;
  const timestamp = typeof snapshot?.completedAt === "number"
    ? snapshot.completedAt
    : typeof snapshot?.startedAt === "number"
      ? snapshot.startedAt
      : Date.parse(record.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isIncompleteTurnAttemptStatus(status: TurnAttemptStatus): boolean {
  return status === "accepted" || status === "running" || status === "recovering";
}
