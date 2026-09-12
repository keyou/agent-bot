import type { AgentEvent } from "../runtime/types.js";
import {
  appendSteerMessage as appendSteerMessageToState,
  createTurnViewState,
  reduceTurnEvent,
} from "../presentation/TurnStateReducer.js";
import { splitMarkdown } from "../presentation/splitMarkdown.js";
import type { TurnViewState } from "../presentation/turnViewTypes.js";
import { CardRenderer } from "./CardRenderer.js";
import { CardUpdateScheduler } from "./CardUpdateScheduler.js";
import { normalizeFeishuMarkdown, type LocalFileUrlResolver } from "./FeishuMarkdown.js";
import type { FeishuOutbound, MessageReplyTarget } from "./types.js";
import {
  FINAL_RESPONSE_BRANDING_BLOCK,
} from "./FinalResponseBranding.js";
import { createId } from "../utils/id.js";
import { createHash } from "node:crypto";

const THINKING_CARD_RUNNING_REACTION = "OnIt";
const THINKING_CARD_FAILED_REACTION = "ERROR";
const THINKING_CARD_CANCELLED_REACTION = "CrossMark";

interface TurnDeliveryRecord {
  progressMessageId?: string;
  finalDelivered: boolean;
  finalMessageIds: string[];
}

export interface TurnPresentationStore {
  saveTurnSnapshot(turnId: string, localSessionId: string, snapshot: unknown, contextKey?: string): void;
  promotePendingTurn(
    pendingTurnId: string,
    turnId: string,
    localSessionId: string,
    snapshot: unknown,
    contextKey?: string,
  ): void;
  getTurnSnapshot(turnId: string): unknown;
  getTurnContextKey?(turnId: string): string | undefined;
  saveTurnDelivery(turnId: string, patch: { progressMessageId?: string; lastCardHash?: string }): void;
  saveFinalDeliveryProgress(turnId: string, messageIds: string[]): void;
  markFinalDelivered(turnId: string, messageIds: string[]): void;
  getTurnDelivery(turnId: string): TurnDeliveryRecord | undefined;
}

export interface FeishuTurnPresenterOptions {
  normalIntervalMs?: number;
  criticalGapMs?: number;
  elapsedUpdateIntervalMs?: number;
  finalChunkLength?: number;
  onError?: (error: unknown) => void;
  finalRetryBackoffMs?: number[];
  localFileUrl?: LocalFileUrlResolver;
  turnPreviewUrl?: (turnId: string) => string | undefined;
}

const MAX_FINAL_TABLES_PER_CARD = 5;
const DEFAULT_ELAPSED_UPDATE_INTERVAL_MS = 3_000;
const FINAL_RESPONSE_BRANDING_THRESHOLD = 600;

interface TurnEntry {
  contextKey: string;
  state: TurnViewState;
  historySnapshot?: TurnViewState;
  initializing: Promise<void>;
  messageId?: string;
  reactionId?: string;
  reactionEmoji?: string;
  scheduler?: CardUpdateScheduler<TurnViewState>;
  elapsedTimer?: ReturnType<typeof setInterval>;
  finalizing?: Promise<void>;
  lastFinalizedStatus?: TurnViewState["status"];
}

export class FeishuTurnPresenter {
  private readonly sessionContexts = new Map<string, string>();
  private readonly sessionTitles = new Map<string, string>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly sessionAgentLabels = new Map<string, string>();
  private readonly sessionModels = new Map<string, string>();
  private readonly entries = new Map<string, TurnEntry>();
  private readonly pendingEntries = new Map<string, TurnEntry>();
  private readonly renderer: CardRenderer;

  constructor(
    private readonly outbound: FeishuOutbound,
    private readonly store: TurnPresentationStore,
    renderer?: CardRenderer,
    private readonly options: FeishuTurnPresenterOptions = {},
  ) {
    this.renderer = renderer ?? new CardRenderer();
  }

  registerSession(
    sessionId: string,
    contextKey: string,
    taskTitle?: string,
    projectCwd?: string,
    agentLabel?: string,
    model?: string,
  ): void {
    this.sessionContexts.set(sessionId, contextKey);
    if (taskTitle) this.sessionTitles.set(sessionId, taskTitle);
    if (projectCwd) this.sessionCwds.set(sessionId, projectCwd);
    if (agentLabel) this.sessionAgentLabels.set(sessionId, agentLabel);
    if (model) {
      this.updateSessionModel(sessionId, model);
    }
  }

  updateSessionModel(sessionId: string, model?: string): void {
    if (!model) return;
    this.sessionModels.set(sessionId, model);
    const pending = this.pendingEntries.get(sessionId);
    if (!pending || pending.state.model === model) return;
    pending.state = { ...pending.state, model };
    this.store.saveTurnSnapshot(pending.state.turnId, sessionId, pending.state, pending.contextKey);
    if (!pending.historySnapshot) pending.scheduler?.update(pending.state, "critical");
  }

  updateSessionTitle(sessionId: string, taskTitle: string): void {
    this.sessionTitles.set(sessionId, taskTitle);
    for (const entry of this.entries.values()) {
      if (entry.state.sessionId !== sessionId || entry.state.taskTitle === taskTitle) continue;
      entry.state = { ...entry.state, taskTitle };
      this.store.saveTurnSnapshot(entry.state.turnId, sessionId, entry.state, entry.contextKey);
      if (!entry.historySnapshot) entry.scheduler?.update(entry.state, "critical");
    }
  }

  unregisterSession(sessionId: string): void {
    this.sessionContexts.delete(sessionId);
    this.sessionTitles.delete(sessionId);
    this.sessionCwds.delete(sessionId);
    this.sessionAgentLabels.delete(sessionId);
    this.sessionModels.delete(sessionId);
  }

  async startPendingTurn(
    sessionId: string,
    contextKey: string,
    taskTitle?: string,
    replyTarget?: MessageReplyTarget,
    prompt?: string,
  ): Promise<string | undefined> {
    const existing = this.pendingEntries.get(sessionId);
    if (existing) {
      await existing.initializing;
      if (prompt && existing.state.prompt !== prompt) {
        existing.state = { ...existing.state, prompt };
        this.store.saveTurnSnapshot(existing.state.turnId, sessionId, existing.state, existing.contextKey);
        if (!existing.historySnapshot) existing.scheduler?.update(existing.state, "critical");
      }
      return existing.state.turnId;
    }
    this.sessionContexts.set(sessionId, contextKey);
    if (taskTitle) this.sessionTitles.set(sessionId, taskTitle);
    const state = createTurnViewState(
      sessionId,
      createId("pending"),
      Date.now(),
      taskTitle ?? this.sessionTitles.get(sessionId),
      replyTarget,
      this.sessionCwds.get(sessionId),
      prompt,
      this.sessionAgentLabels.get(sessionId),
      this.sessionModels.get(sessionId),
    );
    const entry = { contextKey, state, initializing: Promise.resolve() } as TurnEntry;
    this.entries.set(state.turnId, entry);
    this.pendingEntries.set(sessionId, entry);
    this.store.saveTurnSnapshot(state.turnId, sessionId, state, contextKey);
    entry.initializing = this.initializeEntry(entry);
    try {
      await entry.initializing;
      return state.turnId;
    } catch (error) {
      this.stopElapsedUpdates(entry);
      if (this.pendingEntries.get(sessionId) === entry) this.pendingEntries.delete(sessionId);
      this.entries.delete(state.turnId);
      throw error;
    }
  }

  async failPendingTurn(
    sessionId: string,
    message: string,
    replacementCard?: Record<string, unknown>,
  ): Promise<boolean> {
    const entry = this.pendingEntries.get(sessionId);
    if (!entry) return false;
    this.pendingEntries.delete(sessionId);
    this.stopElapsedUpdates(entry);
    const completedAt = Date.now();
    entry.state = {
      ...entry.state,
      status: "failed",
      error: message,
      completedAt,
      durationMs: Math.max(0, completedAt - entry.state.startedAt),
    };
    this.store.saveTurnSnapshot(entry.state.turnId, sessionId, entry.state, entry.contextKey);
    await entry.initializing;
    try {
      await entry.scheduler?.flush(entry.state);
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
    if (replacementCard && entry.messageId) {
      try {
        await this.outbound.updateInteractiveCard(entry.messageId, replacementCard);
      } catch (error) {
        this.options.onError?.(error);
        return false;
      }
    }
    await this.syncThinkingCardReaction(entry);
    return Boolean(replacementCard && entry.messageId);
  }

  async interruptTurnForRecovery(
    sessionId: string,
    contextKey: string,
    turnId: string,
    message: string,
  ): Promise<void> {
    const snapshot = this.store.getTurnSnapshot(turnId);
    if (!isTurnViewState(snapshot) || snapshot.sessionId !== sessionId || isTerminalViewStatus(snapshot.status)) return;
    const completedAt = Date.now();
    const state: TurnViewState = {
      ...snapshot,
      status: "cancelled",
      progressText: message,
      activeTool: undefined,
      approval: undefined,
      completedAt,
      durationMs: Math.max(0, completedAt - snapshot.startedAt),
    };
    this.store.saveTurnSnapshot(turnId, sessionId, state, contextKey);
    const entry = this.entries.get(turnId);
    if (entry) {
      entry.state = state;
      this.stopElapsedUpdates(entry);
      this.entries.delete(turnId);
      if (this.pendingEntries.get(sessionId) === entry) this.pendingEntries.delete(sessionId);
    }
    const delivery = this.store.getTurnDelivery(turnId);
    if (delivery?.progressMessageId) {
      await this.outbound.updateInteractiveCard(delivery.progressMessageId, this.renderTurn(state));
    }
  }

  async appendSteerMessage(
    sessionId: string,
    turnId: string,
    text: string,
    messageId?: string,
  ): Promise<void> {
    const activityId = `steer:${messageId ?? createId("message")}`;
    let entry = this.entries.get(turnId);
    if (!entry) {
      const saved = this.store.getTurnSnapshot(turnId);
      const contextKey = this.store.getTurnContextKey?.(turnId) ?? this.sessionContexts.get(sessionId);
      if (!contextKey) return;
      const initial = isTurnViewState(saved) && saved.sessionId === sessionId
        ? saved
        : {
            ...createTurnViewState(
              sessionId,
              turnId,
              Date.now(),
              this.sessionTitles.get(sessionId),
              undefined,
              this.sessionCwds.get(sessionId),
              undefined,
              this.sessionAgentLabels.get(sessionId),
              this.sessionModels.get(sessionId),
            ),
            status: "running" as const,
          };
      const state = appendSteerMessageToState(initial, activityId, text);
      entry = { contextKey, state, initializing: Promise.resolve() } as TurnEntry;
      this.entries.set(turnId, entry);
      this.store.saveTurnSnapshot(turnId, sessionId, state, contextKey);
      entry.initializing = this.initializeEntry(entry);
      await entry.initializing;
      return;
    }

    await entry.initializing;
    entry.state = appendSteerMessageToState(entry.state, activityId, text);
    this.store.saveTurnSnapshot(turnId, sessionId, entry.state, entry.contextKey);
    if (!entry.historySnapshot) entry.scheduler?.update(entry.state, "critical");
  }

  async onEvent(event: AgentEvent): Promise<void> {
    let existing = this.entries.get(event.turnId);
    let eventApplied = false;
    if (!existing && event.type === "turn_started") {
      const pending = this.pendingEntries.get(event.sessionId);
      if (pending) {
        const pendingTurnId = pending.state.turnId;
        const state = reduceTurnEvent(
          createTurnViewState(
            event.sessionId,
            event.turnId,
            event.startedAt,
            pending.state.taskTitle,
            pending.state.replyTarget,
            pending.state.projectCwd,
            pending.state.prompt,
            pending.state.agentLabel,
            pending.state.model,
          ),
          event,
        );
        this.store.promotePendingTurn(
          pendingTurnId,
          event.turnId,
          event.sessionId,
          state,
          pending.contextKey,
        );
        this.pendingEntries.delete(event.sessionId);
        this.entries.delete(pendingTurnId);
        pending.state = state;
        this.entries.set(event.turnId, pending);
        existing = pending;
        eventApplied = true;
      }
    }
    const entry = existing ?? this.createEntry(event);
    if (!entry) return;

    if (existing && !eventApplied) {
      entry.state = reduceTurnEvent(entry.state, event);
      this.store.saveTurnSnapshot(event.turnId, event.sessionId, entry.state, entry.contextKey);
    }

    await entry.initializing;
    if (!entry.scheduler) return;

    if (isTerminalEvent(event)) {
      this.stopElapsedUpdates(entry);
      if (entry.finalizing) await entry.finalizing;
      const terminalState = entry.state;
      if (entry.lastFinalizedStatus === terminalState.status) return;
      const finalizing = this.finalize(entry, terminalState);
      entry.finalizing = finalizing;
      try {
        await finalizing;
        entry.lastFinalizedStatus = terminalState.status;
      } finally {
        if (entry.finalizing === finalizing) entry.finalizing = undefined;
      }
      return;
    }

    if (!entry.historySnapshot) entry.scheduler.update(entry.state, eventPriority(event));
  }

  async showDetails(contextKey: string, turnId: string): Promise<void> {
    const snapshot = this.store.getTurnSnapshot(turnId);
    if (!isTurnViewState(snapshot)) {
      await this.outbound.sendText(contextKey, "未找到这次执行的详情。可能已被清理。");
      return;
    }
    await this.outbound.sendInteractiveCard(contextKey, this.renderTurnDetails(snapshot));
  }

  async showActivityPage(
    contextKey: string,
    turnId: string,
    page: number | "latest",
    messageId?: string,
  ): Promise<void> {
    const entry = this.entries.get(turnId);
    if (entry) await entry.initializing;
    const ownsProgressCard = entry
      && entry.contextKey === contextKey
      && (!messageId || !entry.messageId || messageId === entry.messageId);

    if (ownsProgressCard) {
      const targetMessageId = messageId ?? entry.messageId;
      if (page === "latest") {
        entry.historySnapshot = undefined;
        if (entry.scheduler) {
          entry.scheduler.invalidateRenderedCard();
          await entry.scheduler.flush(entry.state);
        } else if (targetMessageId) {
          await this.outbound.updateInteractiveCard(targetMessageId, this.renderTurn(entry.state));
        } else {
          await this.outbound.sendInteractiveCard(contextKey, this.renderTurn(entry.state));
        }
        return;
      }

      if (!entry.historySnapshot) {
        entry.historySnapshot = entry.state;
        await entry.scheduler?.flush();
      }
      const card = this.renderActivityHistory(entry.historySnapshot, page);
      if (targetMessageId) await this.outbound.updateInteractiveCard(targetMessageId, card);
      else await this.outbound.sendInteractiveCard(contextKey, card);
      return;
    }

    const snapshot = this.store.getTurnSnapshot(turnId);
    if (!isTurnViewState(snapshot)) throw new Error("未找到这次执行的活动历史。");
    const card = page === "latest"
      ? this.renderTurn(snapshot)
      : this.renderActivityHistory(snapshot, page);
    if (messageId) await this.outbound.updateInteractiveCard(messageId, card);
    else await this.outbound.sendInteractiveCard(contextKey, card);
  }

  async resumeDelivery(_sessionId: string, contextKey: string, turnId: string): Promise<void> {
    const delivery = this.store.getTurnDelivery(turnId);
    if (delivery?.finalDelivered) return;
    const snapshot = this.store.getTurnSnapshot(turnId);
    if (!isTurnViewState(snapshot) || snapshot.status !== "completed" || !snapshot.finalResponse) return;
    await this.deliverFinal(contextKey, snapshot);
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.initializing;
        if (!entry.historySnapshot) await entry.scheduler?.flush();
      }),
    );
  }

  private createEntry(event: AgentEvent): TurnEntry | undefined {
    const saved = this.store.getTurnSnapshot(event.turnId);
    const contextKey = this.store.getTurnContextKey?.(event.turnId) ?? this.sessionContexts.get(event.sessionId);
    if (!contextKey) return undefined;
    const startedAt = event.type === "turn_started" ? event.startedAt : Date.now();
    const initial = isTurnViewState(saved) && saved.sessionId === event.sessionId
      ? saved
      : createTurnViewState(
          event.sessionId,
          event.turnId,
          startedAt,
          this.sessionTitles.get(event.sessionId),
          undefined,
          this.sessionCwds.get(event.sessionId),
          undefined,
          this.sessionAgentLabels.get(event.sessionId),
          this.sessionModels.get(event.sessionId),
        );
    const state = reduceTurnEvent(
      initial,
      event,
    );
    const entry = { contextKey, state, initializing: Promise.resolve() } as TurnEntry;
    this.entries.set(event.turnId, entry);
    this.store.saveTurnSnapshot(event.turnId, event.sessionId, state, contextKey);
    entry.initializing = this.initializeEntry(entry);
    return entry;
  }

  private async initializeEntry(entry: TurnEntry): Promise<void> {
    const sentState = entry.state;
    const card = this.renderTurn(sentState);
    const delivery = this.store.getTurnDelivery(sentState.turnId);
    const persistedMessageId = delivery?.progressMessageId;
    if (delivery?.finalDelivered && !persistedMessageId) return;
    let messageId = persistedMessageId;
    if (messageId) {
      await this.outbound.updateInteractiveCard(messageId, card);
    } else {
      messageId = sentState.replyTarget && this.outbound.replyInteractiveCard
        ? await this.outbound.replyInteractiveCard(
            entry.contextKey,
            sentState.replyTarget,
            card,
            progressMessageKey(sentState.turnId),
          )
        : await this.outbound.sendInteractiveCard(entry.contextKey, card);
    }
    entry.messageId = messageId;
    if (!messageId) return;
    this.store.saveTurnDelivery(entry.state.turnId, { progressMessageId: messageId });
    entry.scheduler = new CardUpdateScheduler<TurnViewState>({
      render: (state) => this.renderTurn(state),
      write: (card) => this.outbound.updateInteractiveCard(messageId, card),
      normalIntervalMs: this.options.normalIntervalMs,
      criticalGapMs: this.options.criticalGapMs,
      onError: this.options.onError,
    });
    entry.scheduler.seed(sentState);
    this.startElapsedUpdates(entry);
    if (entry.state !== sentState) entry.scheduler.update(entry.state, "critical");
    await this.syncThinkingCardReaction(entry);
  }

  private renderTurn(state: TurnViewState): Record<string, unknown> {
    return this.renderer.renderTurn(
      normalizeTurnCardMarkdown(state, this.options.localFileUrl),
      this.turnPreviewUrl(state),
    );
  }

  private renderTurnDetails(state: TurnViewState): Record<string, unknown> {
    return this.renderer.renderTurnDetails(
      normalizeTurnCardMarkdown(state, this.options.localFileUrl),
      this.turnPreviewUrl(state),
    );
  }

  private renderActivityHistory(state: TurnViewState, page: number): Record<string, unknown> {
    return this.renderer.renderActivityHistory(
      normalizeTurnCardMarkdown(state, this.options.localFileUrl),
      page,
    );
  }

  private turnPreviewUrl(state: TurnViewState): string | undefined {
    return state.turnId.startsWith("pending_")
      ? undefined
      : this.options.turnPreviewUrl?.(state.turnId);
  }

  private startElapsedUpdates(entry: TurnEntry): void {
    if (entry.elapsedTimer || isTerminalViewStatus(entry.state.status)) return;
    const intervalMs = Math.max(1, this.options.elapsedUpdateIntervalMs ?? DEFAULT_ELAPSED_UPDATE_INTERVAL_MS);
    entry.elapsedTimer = setInterval(() => {
      if (isTerminalViewStatus(entry.state.status)) {
        this.stopElapsedUpdates(entry);
        return;
      }
      if (!entry.historySnapshot) entry.scheduler?.update(entry.state);
    }, intervalMs);
    entry.elapsedTimer.unref?.();
  }

  private stopElapsedUpdates(entry: TurnEntry): void {
    if (!entry.elapsedTimer) return;
    clearInterval(entry.elapsedTimer);
    entry.elapsedTimer = undefined;
  }

  private async finalize(entry: TurnEntry, state: TurnViewState): Promise<void> {
    let terminalCardError: unknown;
    if (!entry.historySnapshot) {
      try {
        await entry.scheduler?.flush(state);
      } catch (error) {
        this.options.onError?.(error);
        terminalCardError = error;
      }
    }
    if (state.status === "completed" && state.finalResponse) {
      await this.deliverFinal(entry.contextKey, state);
    }
    if (terminalCardError) throw terminalCardError;
    await this.syncThinkingCardReaction(entry);
  }

  private async syncThinkingCardReaction(entry: TurnEntry): Promise<void> {
    const messageId = entry.messageId;
    if (!messageId) return;
    const desiredEmoji = thinkingCardReactionForStatus(entry.state.status);
    if (desiredEmoji === entry.reactionEmoji) return;

    if (!desiredEmoji) {
      if (!entry.reactionId || !this.outbound.deleteReaction) return;
      try {
        await this.outbound.deleteReaction(messageId, entry.reactionId);
        entry.reactionId = undefined;
        entry.reactionEmoji = undefined;
      } catch (error) {
        this.options.onError?.(error);
      }
      return;
    }

    if (!this.outbound.addReaction) return;
    try {
      const replacementId = await this.outbound.addReaction(messageId, desiredEmoji);
      if (!replacementId) return;
      const previousId = entry.reactionId;
      entry.reactionId = replacementId;
      entry.reactionEmoji = desiredEmoji;
      if (previousId && this.outbound.deleteReaction) {
        try {
          await this.outbound.deleteReaction(messageId, previousId);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async deliverFinal(contextKey: string, state: TurnViewState): Promise<void> {
    const delivery = this.store.getTurnDelivery(state.turnId);
    if (delivery?.finalDelivered || !state.finalResponse) return;
    const finalChunkLength = this.options.finalChunkLength ?? 4_000;
    const chunks = brandedFinalChunks(
      normalizeFeishuMarkdown(state.finalResponse, state.projectCwd, this.options.localFileUrl),
      finalChunkLength,
    );
    const messageIds = [...(delivery?.finalMessageIds ?? [])];
    for (let index = messageIds.length; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      const messageId = await this.sendFinalChunk(
        contextKey,
        state.replyTarget,
        chunk,
        finalMessageKey(state.turnId, index),
      );
      messageIds.push(messageId ?? `delivered-chunk-${index}`);
      this.store.saveFinalDeliveryProgress(state.turnId, messageIds);
    }
    this.store.markFinalDelivered(state.turnId, messageIds);
  }

  private async sendFinalChunk(
    contextKey: string,
    replyTarget: MessageReplyTarget | undefined,
    chunk: string,
    idempotencyKey: string,
  ): Promise<string | undefined> {
    const backoffs = this.options.finalRetryBackoffMs ?? [2_000, 4_000, 8_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (replyTarget && this.outbound.replyMarkdown) {
          return await this.outbound.replyMarkdown(contextKey, replyTarget, chunk, idempotencyKey);
        }
        return await this.outbound.sendMarkdown(contextKey, chunk, idempotencyKey);
      } catch (error) {
        if (!isRetryableError(error) || attempt >= backoffs.length) throw error;
        await delay(backoffs[attempt] ?? 8_000);
      }
    }
  }
}

function normalizeTurnCardMarkdown(
  state: TurnViewState,
  localFileUrl: LocalFileUrlResolver | undefined,
): TurnViewState {
  if (!localFileUrl) return state;
  const normalize = (value: string): string => normalizeFeishuMarkdown(value, state.projectCwd, localFileUrl);
  return {
    ...state,
    assistantText: normalize(state.assistantText),
    ...(state.progressText !== undefined ? { progressText: normalize(state.progressText) } : {}),
    plan: state.plan.map((step) => ({ ...step, text: normalize(step.text) })),
    activities: state.activities.map((activity) => activity.kind === "tool"
      ? activity
      : { ...activity, text: normalize(activity.text) }),
  };
}

function brandedFinalChunks(response: string, maxLength: number): string[] {
  const chunks = splitMarkdown(response, maxLength, MAX_FINAL_TABLES_PER_CARD);
  if (chunks.length <= 1 && response.length <= FINAL_RESPONSE_BRANDING_THRESHOLD) return chunks;

  const last = chunks.pop();
  if (last === undefined) return chunks;
  const reservedLength = FINAL_RESPONSE_BRANDING_BLOCK.length + 2;
  const brandedContentLimit = maxLength - reservedLength;
  if (brandedContentLimit < 32) return [...chunks, last, FINAL_RESPONSE_BRANDING_BLOCK];

  const lastParts = splitMarkdown(last, brandedContentLimit, MAX_FINAL_TABLES_PER_CARD);
  const lastContent = lastParts.pop();
  if (lastContent === undefined || lastContent.length > brandedContentLimit) {
    return [...chunks, ...lastParts, lastContent ?? last, FINAL_RESPONSE_BRANDING_BLOCK];
  }
  const separator = lastContent.endsWith("\n\n") ? "" : lastContent.endsWith("\n") ? "\n" : "\n\n";
  return [...chunks, ...lastParts, `${lastContent}${separator}${FINAL_RESPONSE_BRANDING_BLOCK}`];
}

function eventPriority(event: AgentEvent): "normal" | "critical" {
  if (
    event.type === "turn_started"
    || event.type === "approval_requested"
    || event.type === "approval_resolved"
    || event.type === "tool_started"
    || event.type === "context_compaction"
  ) {
    return "critical";
  }
  return "normal";
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed";
}

function isTerminalViewStatus(status: TurnViewState["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function thinkingCardReactionForStatus(status: TurnViewState["status"]): string | undefined {
  if (status === "completed") return undefined;
  if (status === "failed") return THINKING_CARD_FAILED_REACTION;
  if (status === "cancelled") return THINKING_CARD_CANCELLED_REACTION;
  return THINKING_CARD_RUNNING_REACTION;
}

function isTurnViewState(value: unknown): value is TurnViewState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<TurnViewState>;
  return (
    typeof state.sessionId === "string" &&
    typeof state.turnId === "string" &&
    typeof state.status === "string" &&
    typeof state.startedAt === "number" &&
    Array.isArray(state.plan) &&
    Array.isArray(state.completedTools) &&
    Array.isArray(state.failedTools) &&
    Array.isArray(state.fileSummary)
  );
}

function isRetryableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("isRetryable" in error && error.isRetryable === true) || ("isRateLimit" in error && error.isRateLimit === true))
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function finalMessageKey(turnId: string, index: number): string {
  const digest = createHash("sha256").update(`${turnId}:${index}`).digest("hex").slice(0, 32);
  return `codex-final-${digest}`;
}

function progressMessageKey(turnId: string): string {
  const digest = createHash("sha256").update(`progress:${turnId}`).digest("hex").slice(0, 32);
  return `codex-progress-${digest}`;
}
