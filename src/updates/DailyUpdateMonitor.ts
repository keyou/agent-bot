import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { compareSemver } from "../cli/SelfUpdater.js";
import { CardRenderer } from "../feishu/CardRenderer.js";
import type { CardAction, FeishuOutbound } from "../feishu/types.js";
import type { StateStore } from "../state/StateStore.js";
import { stableVersionSchema } from "./PublishedRelease.js";
import type { UpdateCheckSchedule, UpdateNotice } from "./types.js";

interface DailyUpdateOptions {
  store: StateStore;
  outbound: Pick<FeishuOutbound, "sendInteractiveCard" | "updateInteractiveCard">;
  logger: Pick<Logger, "warn" | "info">;
  currentVersion: string;
  userOpenId(): string | undefined;
  readLatest(): Promise<string>;
  readNotes(version: string): Promise<string>;
  checkSupport(): Promise<void>;
  applyUpdate(version: string): Promise<void>;
  hasPendingUpdate(): boolean;
  pendingVersion(): string | undefined;
  now?(): number;
  random?(): number;
}

export function scheduleDailyUpdate(now: number, random = Math.random): UpdateCheckSchedule {
  const start = new Date(now);
  if (start.getHours() >= 17) start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setHours(17, 0, 0, 0);
  const lower = Math.max(now, start.getTime());
  const dueAt = lower + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (end.getTime() - lower));
  return { day: localDay(start.getTime()), dueAt, checked: false };
}

function localDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export class DailyUpdateMonitor {
  private readonly renderer = new CardRenderer();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private work: Promise<void> = Promise.resolve();
  private busy = false;
  private cardWrites: Promise<void> = Promise.resolve();
  private readonly lastCardState = new Map<string, string>();

  constructor(private readonly options: DailyUpdateOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.work = this.recover().catch((error: unknown) => this.logError(error));
    await this.work;
    if (this.stopped) return;
    this.timer = setInterval(() => this.poll(), 1_000);
    this.timer.unref();
    this.poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.work;
    await this.cardWrites;
  }

  async cancel(action: CardAction): Promise<void> {
    if (this.stopped) throw new Error("自动更新已停止。");
    const notice = this.options.store.getUpdateNotice(String(action.value.version ?? ""));
    if (!notice || !action.messageId || action.userId !== notice.userOpenId
      || action.userId !== this.options.userOpenId() || action.value.token !== notice.token
      || (notice.messageId && notice.messageId !== action.messageId)) {
      throw new Error("更新卡片已失效或无权操作。");
    }
    if (notice.status === "cancelled") return;
    if ((notice.status !== "countdown" && notice.status !== "announcing")
      || (notice.deadline !== undefined && this.now() >= notice.deadline)) {
      throw new Error("取消倒计时已结束，请查看安全重启卡片中的更新状态。");
    }
    this.options.store.saveUpdateNotice({ ...notice, messageId: action.messageId, status: "cancelled" });
    this.options.logger.info({ version: notice.version }, "Cancelled automatic Agent Bot update.");
    await this.refreshCard(notice.version);
  }

  async cancelPreparedUpdate(version: string): Promise<void> {
    const notice = this.options.store.getUpdateNotice(version);
    if (!notice || (notice.status !== "preparing" && notice.status !== "scheduled")) return;
    this.options.store.saveUpdateNotice({ ...notice, status: "cancelled" });
    await this.refreshCard(version).catch((error: unknown) => this.logError(error));
  }

  private poll(): void {
    if (this.stopped || this.busy) return;
    this.busy = true;
    this.work = this.tick().catch((error: unknown) => this.logError(error)).finally(() => { this.busy = false; });
  }

  private async tick(): Promise<void> {
    for (const notice of this.options.store.listPendingUpdateNotices()) {
      if (this.stopped) return;
      if (notice.status !== "countdown") continue;
      if (notice.userOpenId !== this.options.userOpenId()) {
        this.options.store.saveUpdateNotice({ ...notice, status: "cancelled" });
        await this.refreshCard(notice.version);
      } else if (this.now() < notice.deadline!) {
        try {
          await this.refreshCard(notice.version);
        } catch (error) {
          await this.fail(notice.version, error);
        }
      } else {
        await this.apply(notice);
      }
    }
    if (this.stopped) return;
    const now = this.now();
    let schedule = this.options.store.getUpdateCheckSchedule();
    if (!schedule || schedule.day !== localDay(now)) {
      // Keep tomorrow's persisted random slot when starting after the daily window.
      if (!schedule || schedule.dueAt <= now) {
        schedule = scheduleDailyUpdate(now, this.options.random);
        this.options.store.saveUpdateCheckSchedule(schedule);
        this.options.logger.info({ dueAt: new Date(schedule.dueAt).toISOString() }, "Scheduled daily Agent Bot update check.");
      }
    }
    if (schedule.checked || now < schedule.dueAt) return;
    const hour = new Date(now).getHours();
    if (hour < 10 || hour >= 17) return;
    const owner = this.options.userOpenId();
    if (!owner || this.options.hasPendingUpdate()) return;
    this.options.store.saveUpdateCheckSchedule({ ...schedule, checked: true });
    const version = stableVersionSchema.parse(await this.options.readLatest());
    if (this.stopped || compareSemver(version, this.options.currentVersion) <= 0
      || this.options.store.getUpdateNotice(version)) return;
    const notes = await this.options.readNotes(version);
    if (this.stopped || owner !== this.options.userOpenId()) return;
    if (!notes.trim()) throw new Error(`Release notes are unavailable for Agent Bot ${version}.`);
    let supportError: string | undefined;
    try {
      await this.options.checkSupport();
    } catch (error) {
      supportError = error instanceof Error ? error.message : String(error);
    }
    if (this.stopped || owner !== this.options.userOpenId()) return;
    await this.announce({
      version, currentVersion: this.options.currentVersion, userOpenId: owner,
      token: randomUUID(), notes, status: supportError ? "failed" : "announcing", error: supportError,
    });
  }

  private async announce(notice: UpdateNotice): Promise<void> {
    this.options.store.saveUpdateNotice(notice);
    try {
      const messageId = await this.options.outbound.sendInteractiveCard(
        `open_id:${notice.userOpenId}`, this.renderer.renderUpdateNotice(notice, this.now()), notice.token,
      );
      if (!messageId) throw new Error("Update notification delivery was not confirmed; automatic update stopped.");
      const current = this.options.store.getUpdateNotice(notice.version)!;
      this.options.store.saveUpdateNotice({
        ...current, messageId, status: current.status === "announcing" ? "countdown" : current.status,
        deadline: current.status === "announcing" ? this.now() + 60_000 : undefined,
      });
      this.options.logger.info({ version: notice.version }, "Delivered private Agent Bot update notice.");
      if (!this.stopped) await this.refreshCard(notice.version);
    } catch (error) {
      await this.fail(notice.version, error);
    }
  }

  private async apply(notice: UpdateNotice): Promise<void> {
    if (this.stopped) return;
    const current = this.options.store.getUpdateNotice(notice.version)!;
    if (current.status !== "countdown") return;
    this.options.store.saveUpdateNotice({ ...current, status: "preparing" });
    try {
      await this.refreshCard(current.version);
      if (this.stopped) return;
      if (this.options.hasPendingUpdate()) throw new Error("已有更新或重启正在等待执行，本次自动更新已停止。");
      await this.options.applyUpdate(current.version);
      const latest = this.options.store.getUpdateNotice(current.version)!;
      if (latest.status !== "cancelled") this.options.store.saveUpdateNotice({ ...latest, status: "scheduled" });
    } catch (error) {
      await this.fail(current.version, error);
      return;
    }
    if (!this.stopped) await this.refreshCard(current.version).catch((error: unknown) => this.logError(error));
  }

  private async recover(): Promise<void> {
    for (const notice of this.options.store.listPendingUpdateNotices()) {
      if (this.stopped) return;
      let recovered: UpdateNotice;
      if (compareSemver(this.options.currentVersion, notice.version) >= 0) {
        recovered = { ...notice, status: "completed" };
      } else if (notice.userOpenId !== this.options.userOpenId()) {
        recovered = { ...notice, status: "cancelled" };
      } else if (notice.status === "countdown" && notice.messageId) {
        // Renew the cancellation window on the same card after downtime.
        recovered = { ...notice, deadline: this.now() + 60_000 };
      } else if ((notice.status === "scheduled" || notice.status === "preparing") && this.options.pendingVersion() === notice.version) {
        recovered = { ...notice, status: "scheduled" };
      } else {
        recovered = { ...notice, status: "failed", error: "上次自动更新被中断，未自动重试。" };
      }
      this.options.store.saveUpdateNotice(recovered);
      try {
        await this.refreshCard(recovered.version);
        if (recovered.status === "countdown" && !this.stopped) {
          const current = this.options.store.getUpdateNotice(recovered.version)!;
          if (current.status === "countdown") this.options.store.saveUpdateNotice({ ...current, deadline: this.now() + 60_000 });
        }
      } catch (error) {
        if (recovered.status === "countdown") await this.fail(recovered.version, error);
        else this.logError(error);
      }
    }
  }

  private async fail(version: string, error: unknown): Promise<void> {
    const notice = this.options.store.getUpdateNotice(version)!;
    if (notice.status !== "cancelled") {
      this.options.store.saveUpdateNotice({ ...notice, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    this.logError(error);
    if (!this.stopped) await this.refreshCard(version).catch((cardError: unknown) => this.logError(cardError));
  }

  private refreshCard(version: string): Promise<void> {
    const write = this.cardWrites.then(async () => {
      if (this.stopped) return;
      const notice = this.options.store.getUpdateNotice(version)!;
      if (!notice.messageId) return;
      const key = `${notice.status}:${notice.status === "countdown" ? Math.ceil((notice.deadline! - this.now()) / 5_000) : ""}`;
      if (this.lastCardState.get(version) === key) return;
      await this.options.outbound.updateInteractiveCard(notice.messageId, this.renderer.renderUpdateNotice(notice, this.now()));
      this.lastCardState.set(version, key);
    });
    this.cardWrites = write.catch(() => undefined);
    return write;
  }

  private logError(error: unknown): void {
    this.options.logger.warn({ error }, "Automatic Agent Bot update did not complete.");
  }
}
