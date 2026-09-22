import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";
import { ManualUpdateController } from "../../src/updates/ManualUpdateController.js";
import { extractReleaseNotes, type PublishedRelease } from "../../src/updates/PublishedRelease.js";
import type { CardAction } from "../../src/feishu/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function actions(card: unknown): Record<string, unknown>[] {
  if (Array.isArray(card)) return card.flatMap(actions);
  if (!card || typeof card !== "object") return [];
  const value = card as Record<string, unknown>;
  return [
    ...(value.type === "callback" ? [value.value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(actions),
  ];
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-manual-update-"));
  const store = new StateStore(path.join(directory, "state.sqlite"));
  cleanups.push(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const options = {
    store,
    outbound: {
      sendText: vi.fn(async () => "text"),
      sendInteractiveCard: vi.fn(async (_contextKey: string, _card: Record<string, unknown>) => "update-card" as string | undefined),
      updateInteractiveCard: vi.fn(async () => undefined),
    },
    logger: { warn: vi.fn() },
    currentVersion: "0.1.23",
    ownerOpenId: vi.fn(() => "owner" as string | undefined),
    readReleases: vi.fn(async (): Promise<PublishedRelease[]> => [
      { channel: "latest", version: "0.1.24", notes: "- Stable fixes" },
      { channel: "alpha", version: "0.1.25-alpha.2", notes: "- Alpha features" },
    ]),
    checkSupport: vi.fn(async () => undefined),
    hasPendingUpdate: vi.fn(() => false),
    applyUpdate: vi.fn(async (_version: string, _contextKey: string, _replyTarget?: { messageId: string; replyInThread?: boolean }): Promise<void> => undefined),
    now: vi.fn(() => 1000),
  };
  const controller = new ManualUpdateController(options);
  const card = () => options.outbound.sendInteractiveCard.mock.calls.at(-1)![1];
  const action = (index = 0): CardAction => ({
    actionId: "select", contextKey: "chat_id:c1", messageId: "update-card", userId: "owner", value: actions(card())[index]!,
  });
  return { controller, options, store, card, action };
}

describe("manual updates", () => {
  test("announces first, shows both channels with release notes, and never installs while checking", async () => {
    const { controller, options, store, card } = fixture();
    await controller.show("chat_id:c1", "owner");
    expect(options.outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("正在检查"));
    expect(options.outbound.sendText.mock.invocationCallOrder[0]).toBeLessThan(options.readReleases.mock.invocationCallOrder[0]!);
    const text = JSON.stringify(card());
    expect(text).toContain("正式版 0.1.24");
    expect(text).toContain("Alpha 0.1.25-alpha.2");
    expect(text).toContain("Stable fixes");
    expect(text).toContain("Alpha features");
    expect(text).toContain("Update 0.1.24");
    expect(text).toContain("Update 0.1.25-alpha.2");
    expect(actions(card())).toHaveLength(2);
    expect(store.getCardActionBinding("update-card", String(actions(card())[1]!.token))).toMatchObject({ version: "0.1.25-alpha.2", owner: "owner" });
    expect(options.applyUpdate).not.toHaveBeenCalled();
  });

  test("shows Chinese introductions before card truncation for stable and Alpha releases", async () => {
    const { controller, options, card } = fixture();
    const changelog = `## [0.1.24]\n### English\n${"English stable notes ".repeat(500)}\n### 中文\n- 正式版修复任务路由。\n## [0.1.25-alpha.2]\n### 中文\n- Alpha 新增执行详情。\n### English\n- Alpha changes`;
    options.readReleases.mockResolvedValue([
      { channel: "latest", version: "0.1.24", notes: extractReleaseNotes(changelog, "0.1.24") },
      { channel: "alpha", version: "0.1.25-alpha.2", notes: extractReleaseNotes(changelog, "0.1.25-alpha.2") },
    ]);
    await controller.show("chat_id:c1", "owner");
    const text = JSON.stringify(card());
    expect(text).toContain("正式版修复任务路由");
    expect(text).toContain("Alpha 新增执行详情");
    expect(text).toContain("完整更新日志");
    expect(text).not.toContain("English stable notes");
    expect(text).not.toContain("Alpha changes");
    expect(actions(card())).toHaveLength(2);
    expect(options.applyUpdate).not.toHaveBeenCalled();
  });

  test("uses the saved exact version, announces before preparing, preserves the reply target, and consumes all choices", async () => {
    const { controller, options, action, card } = fixture();
    await controller.show("chat_id:c1", "owner");
    const alpha = action(1);
    const stable = action(0);
    alpha.value.version = "99.0.0";
    const replyTarget = { messageId: "topic-anchor", replyInThread: true as const };
    await controller.select(alpha, replyTarget);
    expect(options.applyUpdate).toHaveBeenCalledExactlyOnceWith("0.1.25-alpha.2", "chat_id:c1", replyTarget);
    expect(options.outbound.sendText.mock.invocationCallOrder.at(-1)).toBeLessThan(options.applyUpdate.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(options.outbound.updateInteractiveCard.mock.calls.at(-1))).toContain("等待任务与结果投递");
    await expect(controller.select(stable)).rejects.toThrow("失效");
    expect(actions(card())).toHaveLength(2);
  });

  test("rejects other users, forwarded cards, stale tokens, and expired choices before touching the updater", async () => {
    const { controller, options, action } = fixture();
    await controller.show("chat_id:c1", "owner");
    await expect(controller.select({ ...action(), userId: "stranger" })).rejects.toThrow("所有者");
    await expect(controller.select({ ...action(), messageId: "forwarded" })).rejects.toThrow("失效");
    await expect(controller.select({ ...action(), contextKey: "chat_id:other" })).rejects.toThrow("失效");
    await expect(controller.select({ ...action(), value: { action: "agentbot_update_select", token: "invented", version: "0.1.24" } })).rejects.toThrow("失效");
    options.now.mockReturnValue(31 * 60_000);
    await expect(controller.select(action())).rejects.toThrow("失效");
    expect(options.applyUpdate).not.toHaveBeenCalled();
  });

  test("preserves selections across a Worker restart and rechecks the configured owner", async () => {
    const { controller, options, action } = fixture();
    await controller.show("chat_id:c1", "owner");
    const recovered = new ManualUpdateController(options);
    options.ownerOpenId.mockReturnValue("changed-owner");
    await expect(recovered.select(action())).rejects.toThrow("所有者");
    options.ownerOpenId.mockReturnValue("owner");
    await recovered.select(action());
    expect(options.applyUpdate).toHaveBeenCalledOnce();
  });

  test("does not offer reinstalls or downgrades when the current version is Alpha", async () => {
    const { controller, options, card } = fixture();
    options.currentVersion = "0.1.25-alpha.2";
    await new ManualUpdateController(options).show("chat_id:c1", "owner");
    expect(actions(card())).toHaveLength(0);
    expect(JSON.stringify(card())).toContain("不提供降级");
    expect(JSON.stringify(card())).toContain("当前已安装");
    expect(options.applyUpdate).not.toHaveBeenCalled();
  });

  test("shows available versions but no update buttons for source installs, other users, or pending restarts", async () => {
    const { controller, options, card } = fixture();
    options.checkSupport.mockRejectedValueOnce(new Error("npm link installation cannot be updated"));
    await controller.show("chat_id:c1", "owner");
    expect(JSON.stringify(card())).toContain("npm link");
    expect(actions(card())).toHaveLength(0);
    await controller.show("chat_id:c1", "stranger");
    expect(JSON.stringify(card())).toContain("所有者");
    expect(actions(card())).toHaveLength(0);
    options.hasPendingUpdate.mockReturnValue(true);
    await controller.show("chat_id:c1", "owner");
    expect(actions(card())).toHaveLength(0);
    expect(options.applyUpdate).not.toHaveBeenCalled();
  });

  test("blocks simultaneous selections on different cards and retains the running service on preparation failure", async () => {
    const { controller, options, action } = fixture();
    await controller.show("chat_id:c1", "owner");
    const first = action();
    options.outbound.sendInteractiveCard.mockResolvedValueOnce("other-card");
    await controller.show("chat_id:c1", "owner");
    const second = { ...action(), messageId: "other-card" };
    let fail!: (error: Error) => void;
    options.applyUpdate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const pending = controller.select(first);
    await vi.waitFor(() => expect(options.applyUpdate).toHaveBeenCalledOnce());
    await expect(controller.select(second)).rejects.toThrow("已有更新");
    fail(new Error("Download failed"));
    await expect(pending).rejects.toThrow("Download failed");
    expect(JSON.stringify(options.outbound.updateInteractiveCard.mock.calls.at(-1))).toContain("当前服务继续运行");
    await controller.select(second);
    expect(options.applyUpdate).toHaveBeenCalledTimes(2);
  });

  test("keeps the version card within size limits for long Unicode notes and diagnostics", async () => {
    const { controller, options, card } = fixture();
    options.readReleases.mockResolvedValue([
      { channel: "latest", version: "0.1.24", notes: "修复任务".repeat(5000) },
      { channel: "alpha", version: "0.1.25-alpha.1", notes: "支持功能".repeat(5000) },
    ]);
    options.checkSupport.mockRejectedValue(new Error("很长的错误".repeat(5000)));
    await controller.show("chat_id:c1", "owner");
    expect(Buffer.byteLength(JSON.stringify(card()), "utf8")).toBeLessThan(30 * 1024);
    expect(JSON.stringify(card())).toContain("releases/tag/v0.1.25-alpha.1");
  });

  test("keeps the successful channel available when another failed and a card refresh failure does not undo an update", async () => {
    const { controller, options, action, card } = fixture();
    options.readReleases.mockResolvedValue([{ channel: "latest", error: "network offline" }, { channel: "alpha", version: "0.1.24-alpha.1", notes: "Notes unavailable" }]);
    await controller.show("chat_id:c1", "owner");
    expect(actions(card())).toHaveLength(1);
    expect(JSON.stringify(card())).toContain("network offline");
    options.outbound.updateInteractiveCard.mockRejectedValueOnce(new Error("Lark temporarily unavailable"));
    await controller.select(action());
    expect(options.applyUpdate).toHaveBeenCalledOnce();
    expect(options.logger.warn).toHaveBeenCalledOnce();
  });
});
