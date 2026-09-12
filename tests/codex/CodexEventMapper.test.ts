import { describe, expect, test } from "vitest";
import { mapCodexNotification } from "../../src/codex/CodexEventMapper.js";

describe("mapCodexNotification", () => {
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
      contextTokens: 12_445,
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
