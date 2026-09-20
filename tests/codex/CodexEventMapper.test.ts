import { describe, expect, test } from "vitest";
import { mapCodexNotification } from "../../src/codex/CodexEventMapper.js";

describe("mapCodexNotification", () => {
  test.each([true, false])("maps runtime errors without losing willRetry=%s", (willRetry) => {
    expect(mapCodexNotification("error", {
      threadId: "thr_1", turnId: "turn_1", willRetry,
      error: { message: "Connection refused", codexErrorInfo: "streamDisconnected", additionalDetails: null },
    })).toEqual({
      kind: "runtime_error", threadId: "thr_1", turnId: "turn_1", willRetry, message: "Connection refused",
    });
  });

  test.each([
    { message: "Reconnecting... 2/5", additionalDetails: "rate_limit_reached (code=3003). Please try again in 60 seconds.", expected: "Reconnecting... 2/5\n\nrate_limit_reached (code=3003). Please try again in 60 seconds." },
    { message: " Connection refused ", additionalDetails: " Connection refused ", expected: "Connection refused" },
    { message: "HTTP 503: Service unavailable", additionalDetails: "Service unavailable", expected: "HTTP 503: Service unavailable" },
    { message: "Service unavailable", additionalDetails: "HTTP 503: Service unavailable", expected: "HTTP 503: Service unavailable" },
    { message: "Reconnecting... 1/5", additionalDetails: " \n ", expected: "Reconnecting... 1/5" },
    { message: "Reconnecting... 1/5", additionalDetails: { reason: "invalid" }, expected: "Reconnecting... 1/5" },
    { message: " ", additionalDetails: "Request timed out", expected: "Request timed out" },
  ])("preserves error details without duplicating text: $expected", ({ message, additionalDetails, expected }) => {
    const error = { message, additionalDetails };
    for (const willRetry of [true, false]) {
      expect(mapCodexNotification("error", { threadId: "thr_1", turnId: "turn_1", willRetry, error }))
        .toMatchObject({ kind: "runtime_error", willRetry, message: expected });
    }
    expect(mapCodexNotification("turn/completed", {
      threadId: "thr_1", turn: { id: "turn_1", status: "failed", error },
    })).toMatchObject({ kind: "terminal", status: "failed", error: expected });
  });

  test.each([
    { error: null, willRetry: true },
    { error: { message: " " }, willRetry: true },
    { error: { message: "failed" }, willRetry: "true" },
    { error: { message: "failed" } },
  ])("ignores malformed runtime error notifications", (params) => {
    expect(mapCodexNotification("error", { threadId: "thr_1", turnId: "turn_1", ...params })).toBeUndefined();
  });

  test("preserves assistant message item ids and commentary phases", () => {
    expect(
      mapCodexNotification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "message_1", text: "", phase: "commentary" },
      }),
    ).toEqual({
      kind: "agent_message_phase",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "message_1",
      phase: "commentary",
    });
    expect(
      mapCodexNotification("item/agentMessage/delta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "message_1",
        delta: "先检查官方文档",
      }),
    ).toEqual({
      kind: "agent_delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "message_1",
      text: "先检查官方文档",
    });
  });

  test.each(["plan", "default"])("maps %s mode confirmation notifications", (targetMode) => {
    expect(mapCodexNotification("mode/changeRequested", {
      threadId: "thr_1", turnId: "turn_1", requestId: "request_1", targetMode,
      sourceToolCallId: null, reason: "Review the plan", allowedPrompts: [{ tool: "PowerShell", prompt: "run tests" }],
    })).toEqual({
      kind: "mode_change_requested", threadId: "thr_1", turnId: "turn_1", requestId: "request_1", targetMode,
      reason: "Review the plan", allowedPrompts: [{ tool: "PowerShell", prompt: "run tests" }],
    });
    for (const decision of ["approved", "rejected", "cancelled"]) {
      expect(mapCodexNotification("mode/changeResolved", {
        threadId: "thr_1", turnId: "turn_1", requestId: "request_1", targetMode, decision,
      })).toEqual({
        kind: "mode_change_resolved", threadId: "thr_1", turnId: "turn_1", requestId: "request_1", targetMode, decision,
      });
    }
  });

  test("validates mode confirmation payloads without requiring allowed prompts", () => {
    const params = { threadId: "thr_1", turnId: "turn_1", requestId: "request_1", targetMode: "default", reason: "" };
    expect(mapCodexNotification("mode/changeRequested", params)?.kind).toBe("mode_change_requested");
    for (const invalid of [
      { requestId: "" }, { targetMode: "unknown" }, { reason: null }, { allowedPrompts: [{}] },
      { threadId: undefined }, { turnId: undefined },
    ]) {
      expect(mapCodexNotification("mode/changeRequested", { ...params, ...invalid })).toBeUndefined();
    }
    expect(mapCodexNotification("mode/changeResolved", { ...params, decision: "accept" })).toBeUndefined();
    expect(mapCodexNotification("mode/change/requested", params)).toBeUndefined();
  });

  test("streams plan text and replaces it on completion using the same activity", () => {
    const params = { threadId: "thr_1", turnId: "turn_1" };
    expect(mapCodexNotification("item/plan/delta", { ...params, itemId: "plan_1", delta: "## Plan\n" })).toEqual({
      kind: "progress", ...params, activityId: "commentary:plan:plan_1", text: "## Plan\n", append: true,
    });
    expect(mapCodexNotification("item/completed", { ...params, item: { type: "plan", id: "plan_1", text: "## Plan\nRun tests" } })).toEqual({
      kind: "progress", ...params, activityId: "commentary:plan:plan_1", text: "## Plan\nRun tests", append: false,
    });
    expect(mapCodexNotification("item/started", { ...params, item: { type: "plan", id: "plan_1", text: "" } })).toBeUndefined();
    expect(mapCodexNotification("item/plan/delta", { ...params, delta: "missing id" })).toBeUndefined();
    expect(mapCodexNotification("item/completed", { ...params, item: { type: "plan", id: "plan_1" } })).toBeUndefined();
  });

  test("maps plan updates", () => {
    expect(
      mapCodexNotification("turn/plan/updated", {
        threadId: "thr_1",
        turnId: "turn_1",
        plan: [
          { step: "inspect", status: "completed" },
          { step: "fix", status: "inProgress" },
        ],
      }),
    ).toEqual({
      kind: "plan",
      threadId: "thr_1",
      turnId: "turn_1",
      steps: [
        { text: "inspect", status: "completed" },
        { text: "fix", status: "in_progress" },
      ],
    });
  });

  test("maps effective last-request and cumulative token usage without cached input", () => {
    expect(
      mapCodexNotification("thread/tokenUsage/updated", {
        threadId: "thr_1",
        turnId: "turn_1",
        tokenUsage: {
          total: { inputTokens: 98_765, cachedInputTokens: 90_000, outputTokens: 500, totalTokens: 99_265 },
          last: { inputTokens: 12_345, cachedInputTokens: 10_000, outputTokens: 100, totalTokens: 12_445 },
          modelContextWindow: 200_000,
        },
      }),
    ).toEqual({
      kind: "token_usage",
      threadId: "thr_1",
      turnId: "turn_1",
      lastTokens: 2_445,
      cumulativeTokens: 9_265,
      lastTotalTokens: 12_445,
      cumulativeTotalTokens: 99_265,
      lastCachedTokens: 10_000,
      cumulativeCachedTokens: 90_000,
      contextTokens: 12_445,
    });
  });

  test.each([
    [{ inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 }, 25, 0],
    [{ totalTokens: 30 }, 30, undefined],
    [{ inputTokens: 20, outputTokens: 5 }, 25, undefined],
    [{ inputTokens: 20 }, undefined, undefined],
    [{ totalTokens: 25, cachedInputTokens: -1 }, 25, undefined],
    [{ totalTokens: 25, cachedInputTokens: NaN }, 25, undefined],
    [{ totalTokens: Infinity }, undefined, undefined],
  ])("preserves reported totals without inventing missing cache data: %j", (usage, total, cached) => {
    expect(mapCodexNotification("thread/tokenUsage/updated", {
      threadId: "thr_1", turnId: "turn_1", tokenUsage: { last: usage, total: usage },
    })).toMatchObject({
      kind: "token_usage", lastTotalTokens: total, cumulativeTotalTokens: total,
      lastCachedTokens: cached, cumulativeCachedTokens: cached,
    });
  });

  test("maps context compaction item lifecycle and the legacy completion notification", () => {
    expect(
      mapCodexNotification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        startedAtMs: 1_000,
        item: { type: "contextCompaction", id: "compact_1" },
      }),
    ).toEqual({
      kind: "context_compaction",
      threadId: "thr_1",
      turnId: "turn_1",
      phase: "started",
      compactionId: "compact_1",
      timestampMs: 1_000,
    });
    expect(
      mapCodexNotification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        completedAtMs: 3_500,
        item: { type: "contextCompaction", id: "compact_1" },
      }),
    ).toEqual({
      kind: "context_compaction",
      threadId: "thr_1",
      turnId: "turn_1",
      phase: "completed",
      compactionId: "compact_1",
      timestampMs: 3_500,
    });
    expect(
      mapCodexNotification("thread/compacted", {
        threadId: "thr_1",
        turnId: "turn_1",
      }),
    ).toEqual({
      kind: "context_compaction",
      threadId: "thr_1",
      turnId: "turn_1",
      phase: "completed",
    });
  });

  test("maps command lifecycle items", () => {
    expect(
      mapCodexNotification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        completedAtMs: 2000,
        item: {
          type: "commandExecution",
          id: "item_1",
          command: "npm test",
          status: "completed",
          aggregatedOutput: "11 passed",
          exitCode: 0,
          durationMs: 900,
        },
      }),
    ).toEqual({
      kind: "tool",
      phase: "updated",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: expect.objectContaining({
        id: "item_1",
        title: "npm test",
        command: "npm test",
        status: "completed",
        exitCode: 0,
        output: "11 passed",
      }),
    });
  });

  test.each(["item/started", "item/completed"])("includes Read and Grep targets in %s", (method) => {
    for (const [command, commandActions, expected] of [
      ["Read", [{ type: "read", path: "D:\\dev\\agent bot\\src\\file.ts", name: "file.ts" }], "Read D:\\dev\\agent bot\\src\\file.ts"],
      ["Grep", [{ type: "search", query: "tool\\.command|title", path: "src/codex" }], 'Grep "tool\\\\.command|title" · src/codex'],
      ["Read", [{ type: "read", name: "README.md" }], "Read README.md"],
      ["Grep", [{ type: "search", query: "" }], 'Grep ""'],
      ["Grep", [{ type: "search", path: "src" }], "Grep src"],
      ["Read", [{ type: "read", path: "a.ts" }, { type: "read", path: "b.ts" }], "Read a.ts\nRead b.ts"],
    ] as const) {
      expect(mapCodexNotification(method, {
        threadId: "thr_1", turnId: "turn_1",
        item: { id: "item_1", type: "commandExecution", command, commandActions },
      })).toMatchObject({
        kind: "tool", phase: method === "item/started" ? "started" : "updated",
        tool: { title: expected, command: expected, status: method === "item/started" ? "running" : "completed" },
      });
    }
  });

  test.each([
    ["Read", undefined],
    ["Read", []],
    ["Read", { type: "read", path: "file.ts" }],
    ["Read", [null, { type: "read", path: 42 }, { type: "search", path: "src" }]],
    ["Grep", [{ type: "search", query: null, path: " " }]],
    ["OtherTool", [{ type: "read", path: "file.ts" }]],
    ["Get-Content src/file.ts", [{ type: "read", path: "D:\\dev\\src\\file.ts" }]],
    ['rg "pattern" src', [{ type: "search", query: "pattern", path: "src" }]],
    ['pwsh -Command "Get-Content src/file.ts"', [{ type: "read", path: "src/file.ts" }]],
    ["Read src/file.ts", [{ type: "read", path: "src/file.ts" }]],
  ])("preserves %s when the command is complete or targets are unavailable", (command, commandActions) => {
    expect(mapCodexNotification("item/completed", {
      threadId: "thr_1", turnId: "turn_1",
      item: { id: "item_1", type: "commandExecution", command, commandActions },
    })).toMatchObject({ kind: "tool", tool: { title: command, command } });
  });

  test("maps command output deltas without marking the tool complete", () => {
    expect(
      mapCodexNotification("item/commandExecution/outputDelta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "running test 3/10\n",
      }),
    ).toEqual({
      kind: "tool_output_delta",
      threadId: "thr_1",
      turnId: "turn_1",
      toolId: "item_1",
      delta: "running test 3/10\n",
    });
  });

  test("maps image view lifecycle using the notification phase", () => {
    const item = {
      type: "imageView",
      id: "image_1",
      path: "D:\\dev\\agent-bot\\.tmp\\monitor-1.png",
    };

    expect(mapCodexNotification("item/started", { threadId: "thr_1", turnId: "turn_1", item })).toEqual({
      kind: "tool",
      phase: "started",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: expect.objectContaining({
        id: "image_1",
        kind: "image_view",
        status: "running",
        command: "view_image D:\\dev\\agent-bot\\.tmp\\monitor-1.png",
        imagePath: "D:\\dev\\agent-bot\\.tmp\\monitor-1.png",
      }),
    });
    expect(mapCodexNotification("item/completed", { threadId: "thr_1", turnId: "turn_1", item })).toEqual({
      kind: "tool",
      phase: "updated",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: expect.objectContaining({
        id: "image_1",
        kind: "image_view",
        status: "completed",
        command: "view_image D:\\dev\\agent-bot\\.tmp\\monitor-1.png",
        imagePath: "D:\\dev\\agent-bot\\.tmp\\monitor-1.png",
      }),
    });
  });

  test("maps completed image generation without retaining the base64 result", () => {
    const mapped = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      completedAtMs: 1234,
      item: {
        type: "imageGeneration",
        id: "generated_1",
        status: "completed",
        revisedPrompt: "A square profile avatar",
        result: "base64-data-that-must-not-be-retained",
        savedPath: "D:\\images\\avatar.png",
      },
    });

    expect(mapped).toEqual({
      kind: "tool",
      phase: "updated",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: {
        id: "generated_1",
        title: "生成图片",
        kind: "image_generation",
        status: "completed",
        command: "A square profile avatar",
        imagePath: "D:\\images\\avatar.png",
        startedAt: undefined,
        completedAt: 1234,
      },
    });
    expect(JSON.stringify(mapped)).not.toContain("base64-data");
  });

  test("maps web search actions with useful titles and expandable details", () => {
    const search = mapCodexNotification("item/started", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "webSearch",
        id: "web_1",
        query: "fallback query",
        action: { type: "search", queries: ["Codex App Server", "WebSearchItem schema"] },
      },
    });
    const openPage = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "webSearch",
        id: "web_2",
        action: { type: "openPage", url: "https://developers.openai.com/codex/app-server?source=test" },
      },
    });
    const findInPage = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "webSearch",
        id: "web_3",
        action: {
          type: "findInPage",
          url: "https://developers.openai.com/codex/app-server",
          pattern: "thread/start",
        },
      },
    });

    expect(search).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        title: "网页搜索 · Codex App Server；WebSearchItem schema",
        command: "web_search\n- Codex App Server\n- WebSearchItem schema",
      }),
    }));
    expect(openPage).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        title: "打开网页 · developers.openai.com/codex/app-server",
        command: "open_page https://developers.openai.com/codex/app-server?source=test",
      }),
    }));
    expect(findInPage).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        title: "页内查找 · thread/start",
        command: "find_in_page \"thread/start\"\nhttps://developers.openai.com/codex/app-server",
      }),
    }));
  });

  test("preserves MCP and dynamic tool arguments and successful results", () => {
    const mcp = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "mcpToolCall",
        id: "mcp_1",
        server: "lark",
        tool: "search",
        status: "completed",
        arguments: { query: "Codex" },
        result: { content: [{ type: "text", text: "found" }], structuredContent: { total: 1 } },
      },
    });
    const dynamic = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "dynamicToolCall",
        id: "dynamic_1",
        tool: "inspect",
        status: "completed",
        arguments: { path: "a.png" },
        contentItems: [{ type: "inputText", text: "image inspected" }],
      },
    });

    expect(mcp).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        command: expect.stringContaining('"query": "Codex"'),
        output: expect.stringContaining('"text": "found"'),
      }),
    }));
    expect(dynamic).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        command: expect.stringContaining('"path": "a.png"'),
        output: expect.stringContaining('"text": "image inspected"'),
      }),
    }));
  });

  test("maps reasoning summary deltas with a stable activity id", () => {
    expect(
      mapCodexNotification("item/reasoning/summaryTextDelta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "reason_1",
        summaryIndex: 2,
        delta: "正在分析调用链",
      }),
    ).toEqual({
      kind: "progress",
      threadId: "thr_1",
      turnId: "turn_1",
      activityId: "reasoning:reason_1:2",
      text: "正在分析调用链",
      append: true,
    });
  });

  test("does not expose raw reasoning text deltas", () => {
    expect(
      mapCodexNotification("item/reasoning/textDelta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "reason_1",
        contentIndex: 0,
        delta: "private raw reasoning",
      }),
    ).toBeUndefined();
  });
});
