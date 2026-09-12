import { describe, expect, test, vi } from "vitest";
import {
  appendSteerMessage,
  createTurnViewState,
  reduceTurnEvent,
} from "../../src/presentation/TurnStateReducer.js";
import type { AgentEvent, ToolState } from "../../src/runtime/types.js";

const tool = (id: string, title: string, status: ToolState["status"], extra: Partial<ToolState> = {}): ToolState => ({
  id,
  title,
  kind: "command",
  status,
  ...extra,
});

function event(type: AgentEvent["type"], fields: Record<string, unknown>): AgentEvent {
  return { type, sessionId: "s1", turnId: "turn_1", ...fields } as AgentEvent;
}

describe("TurnStateReducer", () => {
  test("keeps the active tool visible and moves successful tools to bounded history", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t1", "npm test", "running") }));
    expect(state.activeTool?.title).toBe("npm test");
    expect(state.activeTool?.startedAt).toEqual(expect.any(Number));
    const startedAt = state.activeTool?.startedAt;

    state = reduceTurnEvent(
      state,
      event("tool_updated", { tool: tool("t1", "npm test", "completed", { output: "ok", completedAt: 2_000 }) }),
    );
    expect(state.activeTool).toBeUndefined();
    expect(state.completedTools).toHaveLength(1);
    expect(state.completedTools[0]?.output).toBe("ok");
    expect(state.completedTools[0]?.startedAt).toBe(startedAt);
    expect(state.completedTools[0]?.completedAt).toBe(2_000);

    for (let index = 2; index <= 25; index += 1) {
      state = reduceTurnEvent(state, event("tool_updated", { tool: tool(`t${index}`, `tool ${index}`, "completed") }));
    }
    expect(state.completedTools).toHaveLength(20);
    expect(state.completedTools[0]?.id).toBe("t6");
    expect(state.totalToolCount).toBe(25);
    expect(state.completedToolCount).toBe(25);
    expect(state.failedToolCount).toBe(0);
  });

  test("does not double count repeated tool updates and tracks status transitions", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t1", "npm test", "running") }));
    state = reduceTurnEvent(state, event("tool_updated", { tool: tool("t1", "npm test", "running") }));
    state = reduceTurnEvent(state, event("tool_updated", { tool: tool("t1", "npm test", "failed") }));
    state = reduceTurnEvent(state, event("tool_updated", { tool: tool("t1", "npm test", "failed") }));

    expect(state).toMatchObject({ totalToolCount: 1, completedToolCount: 0, failedToolCount: 1 });
  });

  test("appends bounded command output while running and trusts the final aggregated output", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(
      state,
      event("tool_started", { tool: tool("t1", "npm test", "running", { output: "starting\n" }) }),
    );
    state = reduceTurnEvent(state, event("tool_output_delta", { toolId: "t1", delta: "test 1 passed\n" }));
    expect(state.activeTool?.output).toBe("starting\ntest 1 passed\n");
    expect(state.activities.find((activity) => activity.id === "t1")).toMatchObject({
      kind: "tool",
      tool: { status: "running", output: "starting\ntest 1 passed\n" },
    });

    state = reduceTurnEvent(state, event("tool_output_delta", { toolId: "t1", delta: "x".repeat(7_000) }));
    const boundedOutput = state.activeTool?.output ?? "";
    expect(boundedOutput).toHaveLength(6_000);
    expect(boundedOutput.startsWith("…")).toBe(true);
    expect(boundedOutput.endsWith("x".repeat(100))).toBe(true);
    expect(state.fullToolOutputs?.t1).toBe(`starting\ntest 1 passed\n${"x".repeat(7_000)}`);

    state = reduceTurnEvent(
      state,
      event("tool_updated", { tool: tool("t1", "npm test", "completed", { output: "2 tests passed" }) }),
    );
    expect(state.activeTool).toBeUndefined();
    expect(state.completedTools[0]?.output).toBe("2 tests passed");
  });

  test("ignores output deltas for unknown or non-command tools", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    const unchanged = reduceTurnEvent(state, event("tool_output_delta", { toolId: "missing", delta: "ignored" }));
    expect(unchanged).toBe(state);

    state = reduceTurnEvent(
      state,
      event("tool_started", { tool: { ...tool("mcp", "search", "running"), kind: "mcp" } }),
    );
    const withMcp = reduceTurnEvent(state, event("tool_output_delta", { toolId: "mcp", delta: "ignored" }));
    expect(withMcp.activeTool?.output).toBeUndefined();
  });

  test("keeps failed tools separate and records plans, files, progress, and completion", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(
      state,
      event("plan_updated", {
        steps: [
          { text: "Inspect", status: "completed" },
          { text: "Implement", status: "in_progress" },
        ],
      }),
    );
    state = reduceTurnEvent(state, event("progress", { text: "正在分析调用链" }));
    state = reduceTurnEvent(
      state,
      event("tool_updated", {
        tool: tool("f1", "修改文件", "failed", {
          error: "permission denied",
          files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
        }),
      }),
    );
    state = reduceTurnEvent(state, event("turn_completed", { finalResponse: "done", durationMs: 2_500 }));

    expect(state.plan[1]).toMatchObject({ text: "Implement", status: "in_progress" });
    expect(state.progressText).toBe("正在分析调用链");
    expect(state.failedTools).toHaveLength(1);
    expect(state.fileSummary).toEqual([{ path: "src/index.ts", additions: 3, deletions: 1 }]);
    expect(state).toMatchObject({ status: "completed", finalResponse: "done", durationMs: 2_500 });
  });

  test.each([
    ["turn_cancelled", {}],
    ["turn_failed", { message: "connection lost" }],
  ] as const)("freezes elapsed time when a turn ends with %s", (type, fields) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    try {
      const initial = createTurnViewState("s1", "turn_1", 1_000);
      const terminal = reduceTurnEvent(initial, event(type, fields));

      expect(terminal).toMatchObject({
        completedAt: 4_000,
        durationMs: 3_000,
      });
      now.mockReturnValue(10_000);
      expect(terminal.durationMs).toBe(3_000);
    } finally {
      now.mockRestore();
    }
  });

  test("ignores events belonging to another turn and bounds verbose fields", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, {
      type: "progress",
      sessionId: "s1",
      turnId: "another",
      text: "ignore me",
    });
    expect(state.progressText).toBeUndefined();

    state = reduceTurnEvent(state, event("progress", { text: "x".repeat(7_000) }));
    expect(state.progressText?.length).toBeLessThanOrEqual(6_000);
  });

  test("uses completed generated images when Codex finishes without text", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("tool_updated", {
      tool: {
        id: "generated_1",
        title: "生成图片",
        kind: "image_generation",
        status: "completed",
        imagePath: "D:\\images\\avatar.png",
      },
    }));
    state = reduceTurnEvent(state, event("turn_completed", { finalResponse: "" }));

    expect(state.finalResponse).toBe("![生成图片 1](<D:/images/avatar.png>)");
  });

  test("accumulates current-turn token usage from cumulative notifications without double counting", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 123, cumulativeTokens: 1_000, contextTokens: 120_000,
    }));
    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 123, cumulativeTokens: 1_000, contextTokens: 120_000,
    }));
    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 456, cumulativeTokens: 1_456, contextTokens: 121_000,
    }));

    expect(state.totalTokens).toBe(579);
    expect(state.tokenUsageCumulative).toBe(1_456);
    expect(state.latestContextTokens).toBe(121_000);
  });

  test("tracks context compaction lifecycle and ignores duplicate completion notifications", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 1_000, cumulativeTokens: 1_000, contextTokens: 120_000,
    }));
    state = reduceTurnEvent(state, event("context_compaction", {
      phase: "started",
      compactionId: "compact_1",
      timestampMs: 1_000,
      turnCount: 12,
      storageBytes: 714 * 1_024 * 1_024,
    }));
    expect(state).toMatchObject({
      contextCompactionStatus: "running",
      contextCompactionId: "compact_1",
      contextCompactionBeforeTokens: 120_000,
      contextCompactionTurnCount: 12,
      contextCompactionStorageBytes: 714 * 1_024 * 1_024,
      progressText: "Codex 正在压缩上下文（压缩前 120,000 tokens）… · 已执行 12 轮 · 磁盘占用 714 MB",
    });
    expect(state.contextCompactionCount).toBeUndefined();
    expect(state.activities).toContainEqual({
      kind: "assistant",
      id: "context-compaction:compact_1",
      text: "Codex 正在压缩上下文（压缩前 120,000 tokens）… · 已执行 12 轮 · 磁盘占用 714 MB",
    });

    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 0, cumulativeTokens: 1_000, contextTokens: 40_000,
    }));
    state = reduceTurnEvent(state, event("context_compaction", {
      phase: "completed",
      compactionId: "compact_1",
      timestampMs: 3_500,
      turnCount: 12,
      storageBytes: 715 * 1_024 * 1_024,
    }));
    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 100, cumulativeTokens: 1_100, contextTokens: 55_000,
    }));
    state = reduceTurnEvent(state, event("context_compaction", {
      phase: "completed",
      compactionId: "compact_1",
      timestampMs: 4_000,
    }));
    state = reduceTurnEvent(state, event("context_compaction", { phase: "completed" }));
    expect(state).toMatchObject({
      contextCompactionStatus: "completed",
      contextCompactionCount: 1,
      contextCompactionId: "compact_1",
      contextCompactionDurationMs: 2_500,
      contextCompactionBeforeTokens: 120_000,
      contextCompactionAfterTokens: 40_000,
      contextCompactionTurnCount: 12,
      contextCompactionStorageBytes: 715 * 1_024 * 1_024,
      progressText: "Codex 已完成上下文压缩 · 耗时 2.5s · 上下文 120,000 → 40,000 tokens（减少 67%） · 已执行 12 轮 · 磁盘占用 715 MB，继续处理。",
    });
    expect(state.activities.filter((activity) => activity.id === "context-compaction:compact_1")).toEqual([{
      kind: "assistant",
      id: "context-compaction:compact_1",
      text: "Codex 已完成上下文压缩 · 耗时 2.5s · 上下文 120,000 → 40,000 tokens（减少 67%） · 已执行 12 轮 · 磁盘占用 715 MB，继续处理。",
    }]);

    state = reduceTurnEvent(state, event("context_compaction", {
      phase: "started",
      compactionId: "compact_2",
      timestampMs: 4_000,
      turnCount: 13,
      storageBytes: 716 * 1_024 * 1_024,
    }));
    state = reduceTurnEvent(state, event("token_usage_updated", {
      lastTokens: 0, cumulativeTokens: 1_100, contextTokens: 20_000,
    }));
    state = reduceTurnEvent(state, event("context_compaction", {
      phase: "completed",
      compactionId: "compact_2",
      timestampMs: 7_000,
      turnCount: 13,
      storageBytes: 717 * 1_024 * 1_024,
    }));
    expect(state.contextCompactionCount).toBe(2);
    expect(state.progressText).toBe(
      "Codex 已完成本轮第 2 次上下文压缩 · 耗时 3s · 上下文 55,000 → 20,000 tokens（减少 64%） · 已执行 13 轮 · 磁盘占用 717 MB，继续处理。",
    );
  });

  test("marks compaction task metrics unknown when runtime data is unavailable", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("context_compaction", { phase: "completed" }));

    expect(state.progressText).toBe("Codex 已完成上下文压缩 · 已执行轮次未知 · 磁盘占用未知，继续处理。");
  });

  test("preserves reasoning and tool activity order while updating entries in place", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(
      state,
      event("progress", { activityId: "reasoning:r1:0", text: "分析仓库", append: true }),
    );
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t1", "rg --files", "running") }));
    state = reduceTurnEvent(
      state,
      event("tool_updated", { tool: tool("t1", "rg --files", "completed", { output: "a.ts" }) }),
    );
    state = reduceTurnEvent(
      state,
      event("progress", { activityId: "reasoning:r2:0", text: "准备测试", append: true }),
    );
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t2", "npm test", "running") }));
    state = reduceTurnEvent(
      state,
      event("progress", { activityId: "reasoning:r1:0", text: "并定位入口", append: true }),
    );

    expect(state.activities.map((activity) => activity.id)).toEqual([
      "reasoning:r1:0",
      "t1",
      "reasoning:r2:0",
      "t2",
    ]);
    expect(state.activities[0]).toEqual({
      kind: "reasoning",
      id: "reasoning:r1:0",
      text: "分析仓库并定位入口",
    });
    expect(state.activities[1]).toMatchObject({
      kind: "tool",
      id: "t1",
      tool: { status: "completed", output: "a.ts" },
    });
  });

  test("inserts steer messages into the activity timeline once", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("progress", {
      activityId: "reasoning:before",
      text: "先检查代码",
    }));
    state = appendSteerMessage(state, "steer:m1", "  同时补充测试  ");
    state = reduceTurnEvent(state, event("progress", {
      activityId: "reasoning:after",
      text: "继续处理",
    }));
    state = appendSteerMessage(state, "steer:m1", "同时补充测试");

    expect(state.activities).toEqual([
      { kind: "reasoning", id: "reasoning:before", text: "先检查代码" },
      { kind: "user", id: "steer:m1", text: "同时补充测试" },
      { kind: "reasoning", id: "reasoning:after", text: "继续处理" },
    ]);
  });

  test("retains activity history beyond the 40-item display page", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    for (let index = 1; index <= 41; index += 1) {
      state = reduceTurnEvent(
        state,
        event("progress", { activityId: `reasoning:${index}`, text: `步骤 ${index}` }),
      );
    }

    expect(state.activities).toHaveLength(41);
    expect(state.activities[0]?.id).toBe("reasoning:1");
    expect(state.activities.at(-1)?.id).toBe("reasoning:41");
    expect(state.activitiesTruncated).toBe(false);
  });

  test("retains assistant, reasoning, and tool activities uniformly for pagination", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    for (let index = 1; index <= 25; index += 1) {
      state = reduceTurnEvent(state, event("progress", {
        activityId: `commentary:${index}`,
        text: `Assistant ${index}`,
      }));
    }
    for (let index = 1; index <= 30; index += 1) {
      state = reduceTurnEvent(state, event("progress", {
        activityId: `reasoning:${index}`,
        text: `Reasoning ${index}`,
      }));
    }
    for (let index = 1; index <= 20; index += 1) {
      state = reduceTurnEvent(state, event("tool_updated", {
        tool: tool(`tool:${index}`, `Tool ${index}`, "completed"),
      }));
    }

    expect(state.activities.filter((activity) => activity.kind === "assistant")).toHaveLength(25);
    expect(state.activities.filter((activity) => activity.kind === "tool")).toHaveLength(20);
    expect(state.activities.filter((activity) => activity.kind === "reasoning")).toHaveLength(30);
    expect(state.activities.some((activity) => activity.id === "reasoning:1")).toBe(true);
    expect(state.activities.some((activity) => activity.id === "tool:1")).toBe(true);
    expect(state.activitiesTruncated).toBe(false);
  });

  test("does not truncate a long assistant activity in the saved timeline", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("progress", {
      activityId: "commentary:long",
      text: "a".repeat(4_000),
      append: true,
    }));
    state = reduceTurnEvent(state, event("progress", {
      activityId: "commentary:long",
      text: "b".repeat(4_000),
      append: true,
    }));

    expect(state.activities[0]).toMatchObject({ kind: "assistant", id: "commentary:long" });
    expect((state.activities[0] as { text: string }).text).toHaveLength(8_000);
  });
});
