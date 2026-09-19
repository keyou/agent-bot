import type { Logger } from "pino";
import { CardRenderer } from "../feishu/CardRenderer.js";
import { isThreadContextKey } from "../feishu/contextKey.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { StateStore } from "../state/StateStore.js";
import type { RestartNotificationTarget, SafeRestartStatus } from "./SafeRestartScheduler.js";

const DEFAULT_INITIAL_CARD_DELAY_MS = 3_000;

export interface SafeRestartNotifierOptions {
  initialCardDelayMs?: number;
}

export class SafeRestartNotifier {
  private readonly messageIds = new Map<string, string>();
  private readonly cardHashes = new Map<string, string>();
  private readonly notificationTargets = new Map<string, RestartNotificationTarget>();
  private activeScheduleId?: number;
  private terminalScheduleId?: number;
  private lastStatus?: SafeRestartStatus;
  private pendingInitialStatus?: SafeRestartStatus;
  private initialCardTimer?: NodeJS.Timeout;
  private queue = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly outbound: FeishuOutbound,
    private readonly renderer: CardRenderer,
    private readonly logger: Pick<Logger, "warn">,
    private readonly options: SafeRestartNotifierOptions = {},
  ) {}

  update(status: SafeRestartStatus): Promise<void> {
    if (this.terminalScheduleId !== undefined && status.scheduleId <= this.terminalScheduleId) {
      if (status.phase !== "cancelled") return Promise.resolve();
    }
    if (this.activeScheduleId !== undefined && status.scheduleId < this.activeScheduleId) {
      return Promise.resolve();
    }
    if (status.phase === "cancelled") {
      this.terminalScheduleId = Math.max(this.terminalScheduleId ?? 0, status.scheduleId);
    }
    if (this.activeScheduleId !== status.scheduleId) {
      const previousStatus = this.lastStatus ?? this.pendingInitialStatus;
      const previousMessageIds = [...this.messageIds];
      const previousTargets = new Map(this.notificationTargets);
      if (
        previousStatus
        && previousStatus.phase !== "cancelled"
        && previousStatus.phase !== "restarting"
        && previousMessageIds.length > 0
      ) {
        this.enqueueSupersededCards(previousStatus, previousMessageIds, previousTargets);
      }
      this.activeScheduleId = status.scheduleId;
      this.messageIds.clear();
      this.cardHashes.clear();
      this.notificationTargets.clear();
      this.clearInitialCardTimer();
      this.pendingInitialStatus = status;
      this.lastStatus = status;
      this.collectNotificationTargets(status);
      const delayMs = status.phase === "cancelled"
        ? 0
        : this.options.initialCardDelayMs ?? DEFAULT_INITIAL_CARD_DELAY_MS;
      if (delayMs <= 0) return this.publishPendingInitialStatus();
      this.initialCardTimer = setTimeout(() => {
        this.initialCardTimer = undefined;
        void this.publishPendingInitialStatus().catch((error: unknown) => {
          this.logger.warn({ error }, "Failed to publish delayed safe restart status.");
        });
      }, delayMs);
      return Promise.resolve();
    }
    this.lastStatus = status;
    this.collectNotificationTargets(status);
    if (this.pendingInitialStatus) {
      this.pendingInitialStatus = status;
      return Promise.resolve();
    }
    return this.enqueue(status);
  }

  async flush(): Promise<void> {
    await this.publishPendingInitialStatus();
    await this.queue;
  }

  getNotificationTargets(): RestartNotificationTarget[] {
    return [...this.notificationTargets.values()].map((target) => ({ ...target }));
  }

  private publishPendingInitialStatus(): Promise<void> {
    this.clearInitialCardTimer();
    const status = this.pendingInitialStatus;
    this.pendingInitialStatus = undefined;
    return status ? this.enqueue(status) : this.queue;
  }

  private enqueue(status: SafeRestartStatus): Promise<void> {
    const queued = this.queue.catch(() => undefined).then(async () => {
      if (this.activeScheduleId !== status.scheduleId) return;
      await this.publish(status);
    });
    this.queue = queued;
    return queued;
  }

  private clearInitialCardTimer(): void {
    if (this.initialCardTimer) clearTimeout(this.initialCardTimer);
    this.initialCardTimer = undefined;
  }

  private async publish(status: SafeRestartStatus): Promise<void> {
    this.collectNotificationTargets(status);
    const targets = this.getNotificationTargets();
    if (targets.length === 0) return;
    const waitingTasks = status.phase === "cancelled"
      ? []
      : this.store.listAllSessions()
        .filter((session) => session.status === "running" || this.store.countQueuedPrompts(session.localSessionId) > 0)
        .map((session) => ({
          id: session.remoteSessionId ?? session.localSessionId,
          localSessionId: session.localSessionId,
          isRunning: session.status === "running",
          title: session.title,
        }));
    await Promise.all(targets.map(async ({ contextKey, replyMessageId, reason }) => {
      const card = this.renderer.renderSafeRestartStatus({
        scheduleId: status.scheduleId,
        reason: reason ?? status.reason,
        phase: status.phase,
        remainingMs: status.remainingMs,
        pendingFinalDeliveries: status.activity.pendingFinalDeliveries,
        waitingTasks,
      });
      const cardHash = JSON.stringify(card);
      const messageId = this.messageIds.get(contextKey);
      if (messageId) {
        if (this.cardHashes.get(contextKey) === cardHash) return;
        try {
          await this.outbound.updateInteractiveCard(messageId, card);
          this.cardHashes.set(contextKey, cardHash);
          return;
        } catch (error) {
          this.logger.warn({ error, contextKey, messageId }, "Failed to update safe restart status card; sending a replacement.");
          this.messageIds.delete(contextKey);
          this.cardHashes.delete(contextKey);
        }
      }
      try {
        let created: string | undefined;
        if (isThreadContextKey(contextKey) && !replyMessageId) {
          throw new Error("The safe-restart topic target has no reply message anchor.");
        }
        if (replyMessageId) {
          if (!this.outbound.replyInteractiveCard) {
            throw new Error("The outbound transport cannot preserve the requesting thread.");
          }
          created = await this.outbound.replyInteractiveCard(
            contextKey,
            { messageId: replyMessageId, replyInThread: true },
            card,
          );
        } else {
          created = await this.outbound.sendInteractiveCard(contextKey, card);
        }
        if (created) {
          if (this.activeScheduleId === status.scheduleId) {
            this.messageIds.set(contextKey, created);
            this.cardHashes.set(contextKey, cardHash);
          } else {
            await this.stopCard(created, status, reason ?? status.reason);
          }
        }
      } catch (error) {
        this.logger.warn({ error, contextKey }, "Failed to send safe restart status card.");
      }
    }));
  }

  private enqueueSupersededCards(
    status: SafeRestartStatus,
    messageIds: Array<[string, string]>,
    targets: Map<string, RestartNotificationTarget>,
  ): void {
    const queued = this.queue.catch(() => undefined).then(async () => {
      await Promise.all(messageIds.map(async ([contextKey, messageId]) => {
        const reason = targets.get(contextKey)?.reason ?? status.reason;
        await this.stopCard(messageId, status, reason);
      }));
    });
    this.queue = queued;
  }

  private async stopCard(messageId: string, status: SafeRestartStatus, reason: string): Promise<void> {
    try {
      await this.outbound.updateInteractiveCard(messageId, this.renderer.renderSafeRestartStatus({
        scheduleId: status.scheduleId,
        reason,
        phase: "superseded",
        pendingFinalDeliveries: status.activity.pendingFinalDeliveries,
        waitingTasks: [],
      }));
    } catch (error) {
      this.logger.warn(
        { error, messageId, scheduleId: status.scheduleId },
        "Failed to stop a superseded safe restart status card.",
      );
    }
  }

  private collectNotificationTargets(status: SafeRestartStatus): void {
    for (const target of status.notificationTargets ?? []) {
      const contextKey = target.contextKey.trim();
      if (!contextKey) continue;
      const existing = this.notificationTargets.get(contextKey);
      const replyMessageId = existing?.replyMessageId ?? target.replyMessageId?.trim();
      const reason = target.reason?.trim() ?? existing?.reason;
      this.notificationTargets.set(contextKey, {
        contextKey,
        ...(replyMessageId ? { replyMessageId } : {}),
        ...(reason ? { reason } : {}),
      });
    }
  }
}
