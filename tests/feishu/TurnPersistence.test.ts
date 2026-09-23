import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";
import { FeishuTurnPresenter } from "../../src/feishu/FeishuTurnPresenter.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-persistence-"));
  const store = new StateStore(path.join(dir, "state.sqlite"));
  const outbound: FeishuOutbound = {
    sendText: vi.fn(async () => "text"), sendMarkdown: vi.fn(async () => "answer"),
    sendInteractiveCard: vi.fn(async () => "card"), updateInteractiveCard: vi.fn(async () => {}),
  };
  const presenter = new FeishuTurnPresenter(outbound, store, undefined, { normalIntervalMs: 10, criticalGapMs: 0, elapsedUpdateIntervalMs: 60_000 });
  presenter.registerSession("s", "chat_id:c");
  return { dir, store, outbound, presenter, close: async () => {
    await presenter.flushAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
  } };
}
const identity = { sessionId: "s", turnId: "t" };
const tool = { id: "cmd", kind: "command", title: "run", command: "run", status: "running" as const };

test("coalesces hot SQLite snapshots and keeps full output exclusively in the journal", async () => {
  const f = fixture();
  const save = vi.spyOn(f.store, "saveTurnSnapshot");
  let serializedBytes = 0;
  save.mockImplementation((id, session, state, context) => {
    serializedBytes += Buffer.byteLength(JSON.stringify(state));
    // call through the prototype to avoid the spy recursion
    StateStore.prototype.saveTurnSnapshot.call(f.store, id, session, state, context);
  });
  try {
    await f.presenter.startPendingTurn("s", "chat_id:c", "Title", undefined, "request", ["initial.png"]);
    await f.presenter.onEvent({ ...identity, type: "turn_started", startedAt: Date.now() });
    await f.presenter.onEvent({ ...identity, type: "tool_started", tool });
    for (let i = 0; i < 128; i++) await f.presenter.onEvent({ ...identity, type: "tool_output_delta", toolId: tool.id, delta: "x".repeat(8192) });
    await f.presenter.appendSteerMessage("s", "t", "continue", "followup", ["followup.png"]);
    await f.presenter.onEvent({ ...identity, type: "tool_updated", tool: { ...tool, status: "completed", output: "x".repeat(1024 * 1024) } });
    await f.presenter.onEvent({ ...identity, type: "turn_completed", finalResponse: "answer" });
    expect(save.mock.calls.length).toBeLessThan(10);
    expect(serializedBytes).toBeLessThan(150_000);
    const state = f.store.getTurnSnapshot("t") as TurnViewState;
    expect(state.fullToolOutputs).toEqual({});
    expect(state.finalResponse).toBe("answer");
    expect(f.store.previews.load("t")?.fullToolOutputs?.cmd?.length).toBe(1024 * 1024);
    expect(f.store.previews.load("t")?.activities).toContainEqual({ kind: "user", id: "steer:followup", text: "continue", localImagePaths: ["followup.png"] });
    expect(f.store.getTurnDelivery("t")?.finalDelivered).toBe(true);
    expect(f.outbound.sendMarkdown).toHaveBeenCalledOnce();
    const wal = fs.statSync(path.join(f.dir, "state.sqlite-wal")).size;
    expect(wal).toBeLessThan(2 * 1024 * 1024);
    console.log("Persistence benchmark", { snapshots: save.mock.calls.length, serializedBytes, wal, journal: fs.statSync(f.store.previews.file("t")).size });
  } finally { await f.close(); }
});

test("persists per-turn Provider through pending promotion, journals and restart", async () => {
  const f = fixture();
  try {
    f.presenter.updateSessionModel("s", "model", "openai");
    const pendingId = await f.presenter.startPendingTurn("s", "chat_id:c");
    f.presenter.updateSessionModel("s", "model", "azure");
    expect(f.store.previews.load(pendingId!)?.modelProvider).toBe("azure");
    await f.presenter.onEvent({ ...identity, type: "turn_started", startedAt: Date.now() });
    f.presenter.updateSessionModel("s", "model", "next-provider");
    await f.presenter.onEvent({ ...identity, type: "turn_completed", finalResponse: "done" });
    await f.presenter.flushAll();
    const reopened = new StateStore(path.join(f.dir, "state.sqlite"));
    try {
      expect(reopened.getTurnSnapshot("t")).toMatchObject({ modelProvider: "azure" });
      expect(reopened.previews.load("t")?.modelProvider).toBe("azure");
      const restarted = new FeishuTurnPresenter(f.outbound, reopened, undefined, { criticalGapMs: 0 });
      restarted.registerSession("s", "chat_id:c", undefined, undefined, undefined, "model", "next-provider");
      await restarted.onEvent({ ...identity, type: "token_usage_updated", lastTokens: 1, cumulativeTokens: 1 });
      await restarted.flushAll();
      expect(reopened.previews.load("t")?.modelProvider).toBe("azure");
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test("does not backfill Provider into saved turns that lack it", async () => {
  const f = fixture();
  try {
    await f.presenter.onEvent({ ...identity, type: "turn_started", startedAt: Date.now() });
    await f.presenter.onEvent({ ...identity, type: "turn_completed", finalResponse: "done" });
    const restarted = new FeishuTurnPresenter(f.outbound, f.store, undefined, { criticalGapMs: 0 });
    restarted.registerSession("s", "chat_id:c", undefined, undefined, undefined, "model", "azure");
    await restarted.onEvent({ ...identity, type: "token_usage_updated", lastTokens: 1, cumulativeTokens: 1 });
    await restarted.flushAll();
    expect(f.store.previews.load("t")?.modelProvider).toBeUndefined();
    expect((f.store.getTurnSnapshot("t") as TurnViewState).modelProvider).toBeUndefined();
  } finally { await f.close(); }
});

test("bounds long card timelines without losing historical activity or final delivery", async () => {
  const f = fixture();
  try {
    await f.presenter.onEvent({ ...identity, type: "turn_started", startedAt: Date.now() });
    for (let i = 0; i < 200; i++) await f.presenter.onEvent({ ...identity, type: "progress", text: `commentary ${i}`, activityId: `commentary:${i}` });
    await f.presenter.onEvent({ ...identity, type: "turn_completed", finalResponse: "done" });
    const state = f.store.getTurnSnapshot("t") as TurnViewState;
    expect(state.activities.length).toBeLessThanOrEqual(80);
    expect(state.activitiesTruncated).toBe(true);
    expect(f.store.previews.load("t")?.activities).toHaveLength(200);
    expect(f.store.previews.load("t")?.activitiesTruncated).toBe(false);
    await f.presenter.onEvent({ ...identity, type: "token_usage_updated", lastTokens: 2, cumulativeTokens: 2 });
    expect((f.store.getTurnSnapshot("t") as TurnViewState).status).toBe("completed");
    await f.presenter.resumeDelivery("s", "chat_id:c", "t");
    expect(f.outbound.sendMarkdown).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
