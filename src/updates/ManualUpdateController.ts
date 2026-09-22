import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { truncateText } from "../utils/markdown.js";
import { compareSemver } from "../cli/SelfUpdater.js";
import { CardRenderer, type TaskListCardAction } from "../feishu/CardRenderer.js";
import type { CardAction, MessageReplyTarget } from "../feishu/types.js";
import type { OutboundRouter } from "../presentation/OutboundRouter.js";
import type { StateStore } from "../state/StateStore.js";
import { publishedVersionSchema, type PublishedRelease } from "./PublishedRelease.js";

interface ManualUpdateOptions {
  store: StateStore;
  outbound: Pick<OutboundRouter, "sendText" | "sendInteractiveCard" | "updateInteractiveCard">;
  logger: Pick<Logger, "warn">;
  currentVersion: string;
  ownerOpenId(): string | undefined;
  readReleases(): Promise<PublishedRelease[]>;
  checkSupport(): Promise<void>;
  hasPendingUpdate(): boolean;
  applyUpdate(version: string, contextKey: string, replyTarget?: MessageReplyTarget): Promise<void>;
  now?(): number;
}

export class ManualUpdateController {
  private readonly renderer = new CardRenderer();
  private selecting = false;

  constructor(private readonly options: ManualUpdateOptions) {}

  async show(contextKey: string, userId?: string): Promise<void> {
    await this.options.outbound.sendText(contextKey, "正在检查正式版和 Alpha 版更新，请稍后。");
    const [releases, support] = await Promise.all([
      this.options.readReleases(),
      this.options.checkSupport().then(() => undefined, (error: unknown) => String(error instanceof Error ? error.message : error)),
    ]);
    const owner = this.options.ownerOpenId();
    const notice = support
      ? `当前安装方式不支持在线更新：${truncateText(support, 600)}`
      : !owner || userId !== owner
        ? "仅配置的机器人所有者可以执行更新。"
        : this.selecting || this.options.hasPendingUpdate()
          ? "已有更新或重启正在进行，请稍后再检查。"
          : undefined;
    const now = this.options.now?.() ?? Date.now();
    const bindings: Array<{ token: string; value: Record<string, string> }> = [];
    const actions: TaskListCardAction[] = [];
    const sections = [{ title: "当前版本", lines: [`${this.options.currentVersion}`] }];
    for (const release of releases) {
      const label = release.channel === "latest" ? "正式版" : "Alpha";
      if (!release.version) {
        sections.push({ title: label, lines: [`查询失败：${truncateText(release.error ?? "暂时无法获取版本", 300)}`] });
        continue;
      }
      const version = publishedVersionSchema.parse(release.version);
      const comparison = compareSemver(version, this.options.currentVersion);
      sections.push({ title: `${label} ${version}`, lines: [
        comparison > 0 ? "有新版本" : comparison === 0 ? "当前已安装" : "早于当前版本，不提供降级",
        truncateText(release.notes ?? "暂无更新简介。", 2000),
        `[完整更新日志](https://github.com/keyou/agent-bot/releases/tag/v${version})`,
      ] });
      if (comparison > 0 && !notice) {
        const token = randomUUID();
        bindings.push({ token, value: { action: "agentbot_update_select", token, version, contextKey, owner: owner!, createdAt: String(now) } });
        actions.push({ text: `Update ${version}`, value: { action: "agentbot_update_select", token, contextKey } });
      }
    }
    const summary = notice ?? (actions.length > 0
      ? "选择一个版本开始更新；等待任务与结果投递完成后重启，失败时尝试回滚。"
      : releases.some((release) => !release.version)
        ? "部分版本查询失败，请稍后重新发送 /update。"
        : "暂无高于当前版本的可用更新。");
    sections.push({ title: "说明", lines: [summary] });
    const messageId = await this.options.outbound.sendInteractiveCard(contextKey,
      this.renderer.renderSectionsCard("Agent Bot 更新", sections, actions));
    if (messageId && bindings.length) this.options.store.upsertCardActionBindings(messageId, bindings);
  }

  async select(action: CardAction, replyTarget?: MessageReplyTarget): Promise<void> {
    const token = typeof action.value.token === "string" ? action.value.token : "";
    const binding = action.messageId && token ? this.options.store.getCardActionBinding(action.messageId, token) : undefined;
    const now = this.options.now?.() ?? Date.now();
    const createdAt = Number(binding?.createdAt);
    if (!binding || binding.action !== "agentbot_update_select" || binding.contextKey !== action.contextKey
      || !Number.isFinite(createdAt) || now - createdAt > 30 * 60_000
      || now < createdAt) {
      throw new Error("更新卡片已失效，请重新发送 /update。");
    }
    if (!action.userId || action.userId !== binding.owner || action.userId !== this.options.ownerOpenId()) {
      throw new Error("仅配置的机器人所有者可以执行更新。");
    }
    const version = publishedVersionSchema.parse(binding.version);
    if (compareSemver(version, this.options.currentVersion) <= 0) throw new Error("此版本无需更新，请重新发送 /update。");
    if (this.selecting || this.options.hasPendingUpdate()) throw new Error("已有更新或重启正在进行，请勿重复操作。");
    this.selecting = true;
    try {
      this.options.store.retainCardActionBindings(action.messageId!, []);
      await this.options.outbound.sendText(action.contextKey, `正在下载并校验 Agent Bot ${version}，请稍后；完成后将安排安全更新。`);
      await this.options.applyUpdate(version, action.contextKey, replyTarget);
      await this.showResult(action, version, "更新已就绪，等待任务与结果投递完成后自动安装并重启。");
    } catch (error) {
      await this.showResult(action, version, "更新未完成，当前服务继续运行。请重新发送 /update 后重试。");
      throw error;
    } finally {
      this.selecting = false;
    }
  }

  private async showResult(action: CardAction, version: string, status: string): Promise<void> {
    try {
      await this.options.outbound.updateInteractiveCard(action.contextKey, action.messageId!,
        this.renderer.renderSectionsCard("Agent Bot 更新", [{ title: version, lines: [status] }]));
    } catch (error) {
      this.options.logger.warn({ error, version }, "Failed to refresh the manual update card.");
    }
  }
}
