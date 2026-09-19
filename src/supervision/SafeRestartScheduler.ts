export interface ServerActivityState {
  runningSessions: number;
  pendingFinalDeliveries: number;
  latestInboundAt?: string;
}

export type SafeRestartPhase =
  | "waiting_tasks"
  | "waiting_delivery"
  | "countdown"
  | "restarting"
  | "cancelled";

export interface RestartNotificationTarget {
  contextKey: string;
  replyMessageId?: string;
  reason?: string;
}

export interface SafeRestartStatus {
  scheduleId: number;
  reason: string;
  notificationTargets?: RestartNotificationTarget[];
  phase: SafeRestartPhase;
  activity: ServerActivityState;
  remainingMs?: number;
}

export interface SafeRestartSchedulerOptions {
  readActivity(): ServerActivityState;
  onReady(reason: string, notificationTargets: RestartNotificationTarget[]): void | Promise<void>;
  onStatus?(status: SafeRestartStatus): void | Promise<void>;
  onStatusError?(error: unknown): void;
  quietPeriodMs?: number;
  pollIntervalMs?: number;
}

export interface SafeRestartScheduleOptions {
  restartImmediatelyIfIdle?: boolean;
}

export class SafeRestartScheduler {
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private pollAgain = false;
  private reason?: string;
  private notificationTargets: RestartNotificationTarget[] = [];
  private idleSince?: number;
  private idleInboundAt?: string;
  private scheduleId = 0;
  private restartImmediatelyIfIdle = false;

  constructor(private readonly options: SafeRestartSchedulerOptions) {}

  get scheduled(): boolean {
    return Boolean(this.reason);
  }

  get pendingReason(): string | undefined {
    return this.reason;
  }

  schedule(
    reason: string,
    notificationTarget?: RestartNotificationTarget,
    options: SafeRestartScheduleOptions = {},
  ): boolean {
    const newlyScheduled = !this.reason;
    if (newlyScheduled) {
      this.notificationTargets = [];
      this.restartImmediatelyIfIdle = options.restartImmediatelyIfIdle === true;
    } else if (options.restartImmediatelyIfIdle) {
      this.restartImmediatelyIfIdle = true;
    }
    this.scheduleId += 1;
    this.addNotificationTarget(notificationTarget, reason);
    this.reason = reason;
    this.idleSince = undefined;
    this.idleInboundAt = undefined;
    if (!this.timer) {
      this.timer = setInterval(() => this.requestPoll(), this.options.pollIntervalMs ?? 1_000);
    }
    this.requestPoll();
    return newlyScheduled;
  }

  cancel(): void {
    this.clear();
  }

  async cancelCurrent(): Promise<boolean> {
    if (!this.reason) return false;
    return this.cancelScheduled(this.scheduleId);
  }

  async forceScheduled(expectedScheduleId: number): Promise<boolean> {
    const reason = this.reason;
    if (!reason || this.scheduleId !== expectedScheduleId) return false;
    await this.restart(reason, expectedScheduleId, this.options.readActivity());
    return true;
  }

  async cancelScheduled(expectedScheduleId: number): Promise<boolean> {
    const reason = this.reason;
    if (!reason || this.scheduleId !== expectedScheduleId) return false;
    const activity = this.options.readActivity();
    const notificationTargets = this.notificationTargetsSnapshot();
    this.clear();
    await this.emitStatus({
      scheduleId: expectedScheduleId,
      reason,
      notificationTargets,
      phase: "cancelled",
      activity,
    });
    return true;
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reason = undefined;
    this.notificationTargets = [];
    this.idleSince = undefined;
    this.idleInboundAt = undefined;
    this.restartImmediatelyIfIdle = false;
  }

  private async poll(): Promise<void> {
    const reason = this.reason;
    if (!reason) return;
    const scheduleId = this.scheduleId;
    const state = this.options.readActivity();
    if (state.runningSessions > 0 || state.pendingFinalDeliveries > 0) {
      this.idleSince = undefined;
      this.idleInboundAt = undefined;
      await this.emitStatus({
        scheduleId,
        reason,
        notificationTargets: this.notificationTargetsSnapshot(),
        phase: state.runningSessions > 0 ? "waiting_tasks" : "waiting_delivery",
        activity: state,
      });
      return;
    }
    if (this.restartImmediatelyIfIdle) {
      await this.restart(reason, scheduleId, state);
      return;
    }
    const quietPeriodMs = this.options.quietPeriodMs ?? 5_000;
    const latestInboundAt = state.latestInboundAt ?? "";
    if (this.idleSince === undefined || this.idleInboundAt !== latestInboundAt) {
      this.idleSince = Date.now();
      this.idleInboundAt = latestInboundAt;
      await this.emitStatus({
        scheduleId,
        reason,
        notificationTargets: this.notificationTargetsSnapshot(),
        phase: "countdown",
        activity: state,
        remainingMs: quietPeriodMs,
      });
      return;
    }
    const remainingMs = Math.max(0, quietPeriodMs - (Date.now() - this.idleSince));
    if (remainingMs > 0) {
      await this.emitStatus({
        scheduleId,
        reason,
        notificationTargets: this.notificationTargetsSnapshot(),
        phase: "countdown",
        activity: state,
        remainingMs,
      });
      return;
    }
    const confirmed = this.options.readActivity();
    if (
      confirmed.runningSessions > 0
      || confirmed.pendingFinalDeliveries > 0
      || (confirmed.latestInboundAt ?? "") !== this.idleInboundAt
    ) {
      this.idleSince = undefined;
      this.idleInboundAt = undefined;
      if (confirmed.runningSessions > 0 || confirmed.pendingFinalDeliveries > 0) {
        await this.emitStatus({
          scheduleId,
          reason,
          notificationTargets: this.notificationTargetsSnapshot(),
          phase: confirmed.runningSessions > 0 ? "waiting_tasks" : "waiting_delivery",
          activity: confirmed,
        });
      } else {
        await this.emitStatus({
          scheduleId,
          reason,
          notificationTargets: this.notificationTargetsSnapshot(),
          phase: "countdown",
          activity: confirmed,
          remainingMs: quietPeriodMs,
        });
      }
      return;
    }
    await this.restart(reason, scheduleId, confirmed);
  }

  private async restart(reason: string, scheduleId: number, activity: ServerActivityState): Promise<void> {
    const notificationTargets = this.notificationTargetsSnapshot();
    this.clear();
    await this.emitStatus({
      scheduleId,
      reason,
      notificationTargets,
      phase: "restarting",
      activity,
      remainingMs: 0,
    });
    await this.options.onReady(reason, notificationTargets);
  }

  private requestPoll(): void {
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = this.drainPolls().finally(() => {
      this.polling = undefined;
      if (this.pollAgain && this.reason) this.requestPoll();
    });
  }

  private async drainPolls(): Promise<void> {
    do {
      this.pollAgain = false;
      await this.poll();
    } while (this.pollAgain && this.reason);
  }

  private async emitStatus(status: SafeRestartStatus): Promise<void> {
    if (!this.options.onStatus) return;
    await Promise.resolve(this.options.onStatus(status)).catch((error: unknown) => {
      this.options.onStatusError?.(error);
    });
  }

  private addNotificationTarget(value: RestartNotificationTarget | undefined, reason: string): void {
    const target = normalizedNotificationTarget(value, reason);
    if (!target) return;
    const existingIndex = this.notificationTargets.findIndex(
      (candidate) => candidate.contextKey === target.contextKey,
    );
    if (existingIndex < 0) {
      this.notificationTargets.push(target);
      return;
    }
    const existing = this.notificationTargets[existingIndex]!;
    this.notificationTargets[existingIndex] = {
      ...existing,
      reason: target.reason,
      ...(target.replyMessageId
        ? { replyMessageId: target.replyMessageId }
        : {}),
    };
  }

  private notificationTargetsSnapshot(): RestartNotificationTarget[] {
    return this.notificationTargets.map((target) => ({ ...target }));
  }
}

function normalizedNotificationTarget(
  value: RestartNotificationTarget | undefined,
  reason: string,
): RestartNotificationTarget | undefined {
  const contextKey = value?.contextKey.trim();
  if (!contextKey) return undefined;
  const replyMessageId = value?.replyMessageId?.trim();
  return {
    contextKey,
    ...(replyMessageId ? { replyMessageId } : {}),
    reason,
  };
}
