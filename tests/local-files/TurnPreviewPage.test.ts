import path from "node:path";
import { parseHTML } from "linkedom";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { mapCodexNotification } from "../../src/codex/CodexEventMapper.js";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import { reduceTurnEvent } from "../../src/presentation/TurnStateReducer.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";
import type { ToolState } from "../../src/runtime/types.js";
import { detectTurnPreviewLanguage, renderTurnPreviewPage, renderTurnPreviewSnapshot, renderTurnPreviewDetail } from "../../src/local-files/TurnPreviewPage.js";

function state(tool?: Partial<ToolState>): TurnViewState {
  return {
    sessionId: "session", turnId: "turn", startedAt: 1_000, status: "running",
    prompt: "Inspect the command failure.", assistantText: "", plan: [],
    completedTools: [], failedTools: [], fileSummary: [],
    activities: tool ? [{ kind: "tool", id: "tool:1", tool: {
      id: "tool:1", kind: "command", title: "npm test", status: "completed",
      command: "/bin/zsh -lc 'npm test'", startedAt: 1_000, completedAt: 2_500,
      ...tool,
    } }] : [],
  };
}

describe("Turn Preview", () => {

  test("shows a retryable history failure without changing the completed execution status", () => {
    const input = { ...state(), status: "completed" as const, historyDetail: "summary" as const, historyDetailError: "Provider <script>unavailable</script>" };
    const preview = renderTurnPreviewSnapshot(input);
    expect(preview.status).toBe("completed");
    expect(preview.terminal).toBe(true);
    expect(preview.content).toContain("历史执行详情读取失败");
    expect(preview.content).toContain("刷新页面重试");
    expect(preview.content).toContain("&lt;script&gt;unavailable&lt;/script&gt;");
    expect(preview.content).not.toContain('data-preview-key="error"');
    expect(renderTurnPreviewSnapshot({ ...input, historyDetailError: undefined }).content).toContain("仅保存轮次摘要");
    expect(renderTurnPreviewSnapshot(input, undefined, "en").content).toContain("Refresh to retry");
  });

  test.each(["zh", "en"] as const)("renders independent reasoning sections lazily without changing cards (%s)", (language) => {
    const input = state({ output: "tool result" });
    input.activities.unshift({ kind: "reasoning", id: "reasoning:r1:0", text: "Old truncated summary" });
    const renderers = (["grouped", "timeline"] as const).map((thinkingCardLayout) => new CardRenderer({ thinkingCardLayout }));
    const cards = renderers.map((renderer) => [renderer.renderTurn(input), renderer.renderTurnDetails(input)]);
    input.reasoningItems = [
      { itemId: "r1", summary: ["**Understanding API Implementation**\n\nSummary paragraph", "Second summary"], content: ["<script>alert(1)</script>\n\nBody paragraph"] },
      { itemId: "body-only", afterActivityId: "tool:1", summary: [], content: ["Only body"] },
      { itemId: "empty", summary: [" "], content: [] },
    ];
    expect(renderers.map((renderer) => [renderer.renderTurn(input), renderer.renderTurnDetails(input)])).toEqual(cards);
    const html = renderTurnPreviewSnapshot(input, undefined, language).content;
    const doc = parseHTML(html).document;
    expect(doc.querySelectorAll("details.reasoning-step")).toHaveLength(2);
    expect(doc.querySelector("details.reasoning-step")?.hasAttribute("open")).toBe(false);
    expect(doc.querySelectorAll('[data-reasoning-field="summary"] .reasoning-part')).toHaveLength(2);
    expect(doc.querySelector(".reasoning-header")?.textContent).toBe("💭 Understanding API Implementation");
    expect(doc.querySelector('[data-reasoning-field="summary"]')?.textContent).not.toContain("Understanding API Implementation");
    expect(doc.querySelectorAll(".reasoning-kinds, .reasoning-section > h3")).toHaveLength(0);
    expect(html).not.toContain("Old truncated summary");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(doc.querySelector('[data-activity-id="reasoning:body-only"] [data-reasoning-field="summary"]')).toBeNull();
    expect(html.indexOf("tool result")).toBeLessThan(html.indexOf("Only body"));
    const deferred = renderTurnPreviewSnapshot(input, undefined, language, { deferDetails: true }).content;
    expect(deferred).toContain("💭 Understanding API Implementation");
    expect(deferred).not.toContain("Summary paragraph");
    expect(deferred).not.toContain("Only body");
    expect(deferred).not.toContain("Waiting for Agent progress");
    const key = "reasoning:r1";
    const detail = renderTurnPreviewDetail(input, key, undefined, language)!;
    expect(detail.content).toContain("Summary paragraph");
    expect(detail.content).not.toContain("Understanding API Implementation");
    expect(detail.content).toContain("Body paragraph");
    const same = renderTurnPreviewDetail({ ...input, totalTokens: 42 }, key, undefined, language)!;
    expect(same.revision).toBe(detail.revision);
    const changed = structuredClone(input);
    changed.reasoningItems![0]!.content.push("More body");
    expect(renderTurnPreviewDetail(changed, key, undefined, language)!.revision).not.toBe(detail.revision);
    expect(renderTurnPreviewDetail(input, "reasoning:unknown")).toBeUndefined();
    expect(renderTurnPreviewDetail(input, "reasoning:empty")).toBeUndefined();
  });

  test.each([
    ["**Understanding API Implementation**\n\nI need to implement a moderately large task.", "Understanding API Implementation", "I need to implement a moderately large task."],
    ["\n\r\n## Inspecting the API ##\r\n\r\nRead the implementation.", "Inspecting the API", "Read the implementation."],
    ["__Reviewing tests__\nTest the changes.", "Reviewing tests", "Test the changes."],
    ["# Inspect `src/index.ts` &amp; **tests**\n\nKeep the body.", "Inspect src/index.ts & tests", "Keep the body."],
    ["**Title only**", "Title only", ""],
  ])("moves a leading title into the header without changing saved reasoning (%s)", (text, title, body) => {
    for (const field of ["summary", "content"] as const) {
      const input = state();
      input.reasoningItems = [{ itemId: "r1", summary: [], content: [], [field]: [text] }];
      const saved = structuredClone(input);
      for (const deferDetails of [false, true]) {
        const { document } = parseHTML(renderTurnPreviewSnapshot(input, undefined, "zh", { deferDetails }).content);
        expect(document.querySelector(".reasoning-header")?.textContent).toBe(`💭 ${title}`);
        expect(document.querySelector(".reasoning-header")?.getAttribute("title")).toBe(title);
        const details = renderTurnPreviewDetail(input, "reasoning:r1")!;
        const expanded = parseHTML(details.content).document;
        expect(details.content).not.toContain(title);
        expect(expanded.querySelector(".reasoning-part")?.textContent?.trim() ?? "").toBe(body);
        if (!deferDetails) {
          expect(document.querySelector(".reasoning-section")?.outerHTML ?? "").toBe(details.content);
        }
      }
      expect(input).toEqual(saved);
    }
  });

  test.each([
    "A plain opening paragraph.\n\nKeep all of it.",
    "**An unfinished streamed title",
    "**Emphasis** in a sentence.",
    "**One** and **two**",
    "    **This is code**\n\nKeep the code.",
    "```md\n# This is code\n```",
  ])("does not discard a paragraph, incomplete title, or code (%s)", (text) => {
    const input = state();
    input.reasoningItems = [{ itemId: "r1", summary: [text], content: [] }];
    for (const language of ["zh", "en"] as const) {
      const { document } = parseHTML(renderTurnPreviewSnapshot(input, undefined, language).content);
      expect(document.querySelector(".reasoning-header")?.textContent).toBe(language === "zh" ? "💭 思考" : "💭 Reasoning");
      expect(document.querySelector(".reasoning-part")?.textContent?.trim()).not.toBe("");
      expect(renderTurnPreviewDetail(input, "reasoning:r1", undefined, language)?.content).toContain(document.querySelector(".reasoning-part")!.innerHTML);
    }
  });

  test("preserves all sections and later headings when both reasoning fields are supplied", () => {
    const input = state();
    input.reasoningItems = [{ itemId: "r1",
      summary: ["**First title**\n\nSummary body\n\n### Later heading\n\nLater body", "**Second title**\n\nSecond summary"],
      content: ["**Body heading**\n\nFull content"],
    }];
    const { document } = parseHTML(renderTurnPreviewSnapshot(input).content);
    expect(document.querySelector(".reasoning-header")?.textContent).toBe("💭 First title");
    const detail = renderTurnPreviewDetail(input, "reasoning:r1")!.content;
    expect(detail).not.toContain("First title");
    for (const text of ["Summary body", "Later heading", "Later body", "Second title", "Second summary", "Body heading", "Full content"]) {
      expect(detail).toContain(text);
    }
    expect(document.querySelector(".reasoning-section h3")?.textContent).toBe("Later heading");
  });

  test("uses a content title without discarding an untitled summary or truncating long text", () => {
    const input = state();
    const title = "A long content title ".repeat(30).trim();
    input.reasoningItems = [{ itemId: "r1", summary: ["Untitled summary remains intact."], content: [`# ${title}\n\nComplete body.`] }];
    const { document } = parseHTML(renderTurnPreviewSnapshot(input, undefined, "en", { deferDetails: true }).content);
    expect(document.querySelector(".reasoning-title")?.textContent).toBe(`💭 ${title}`);
    expect(document.querySelector(".reasoning-header")?.getAttribute("title")).toBe(title);
    const detail = renderTurnPreviewDetail(input, "reasoning:r1")!;
    expect(detail.content).toContain("Untitled summary remains intact.");
    expect(detail.content).toContain("Complete body.");
    expect(detail.content).not.toContain(title);
    const page = renderTurnPreviewPage({ state: input, eventsUrl: "/events", scriptPath: "/client.js" });
    expect(page).toContain(".reasoning-title { min-width:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }");
  });

  test("escapes titles and preserves heading links and images without making the header interactive", () => {
    const input = state();
    input.reasoningItems = [{ itemId: "safe", summary: ['**<script>alert("x")</script> & safe**\n\nSafe body'], content: [] },
      { itemId: "linked", summary: ["# [Report](https://example.com/report) ![Diagram](https://example.com/image.png)\n\nBody"], content: [] }];
    const { document } = parseHTML(renderTurnPreviewSnapshot(input).content);
    const headers = document.querySelectorAll(".reasoning-header");
    expect(headers[0]?.textContent).toBe('💭 <script>alert("x")</script> & safe');
    expect(headers[0]?.getAttribute("title")).toBe('<script>alert("x")</script> & safe');
    expect(headers[1]?.textContent).toBe("💭 Report Diagram");
    expect(document.querySelectorAll("script, .reasoning-header a, .reasoning-header img")).toHaveLength(0);
    expect(document.querySelector('.reasoning-part a')?.getAttribute("href")).toBe("https://example.com/report");
    expect(document.querySelector('.reasoning-part img')?.getAttribute("src")).toBe("https://example.com/image.png");
  });

  test("groups legacy summary sections and preserves legacy Commentary as messages", () => {
    const input = state();
    input.activities = [
      { kind: "reasoning", id: "reasoning:legacy:0", text: "First summary" },
      { kind: "reasoning", id: "reasoning:legacy:1", text: "Second summary" },
      { kind: "reasoning", id: "commentary:legacy", text: "Legacy commentary" },
    ];
    const { document } = parseHTML(renderTurnPreviewSnapshot(input).content);
    expect(document.querySelectorAll(".reasoning-step")).toHaveLength(1);
    expect(document.querySelectorAll(".reasoning-part")).toHaveLength(2);
    expect(document.querySelector(".message.commentary")?.textContent?.trim()).toBe("Legacy commentary");
    expect(document.querySelector('[data-reasoning-field="content"]')).toBeNull();
    expect(renderTurnPreviewDetail(input, "reasoning:legacy")?.content).toContain("Second summary");
  });

  test.each(["zh", "en"] as const)("shows the empty progress placeholder only while awaiting progress (%s)", (language) => {
    const waitingText = language === "zh" ? "正在等待 Agent 返回进度" : "Waiting for Agent progress";
    for (const deferDetails of [false, true]) {
      const snapshot = (input: TurnViewState) => renderTurnPreviewSnapshot(input, undefined, language, { deferDetails });
      for (const status of ["starting", "running", "tool_running"] as const) {
        const initial = snapshot({ ...state(), status });
        expect(initial.content).toContain(waitingText);
        expect(parseHTML(initial.content).document.querySelector(".timeline")?.hasAttribute("hidden")).toBe(false);
      }
      const cases: TurnViewState[] = [
        ...(["completed", "cancelled", "failed"] as const).map((status) => ({ ...state(), status })),
        { ...state(), status: "completed", finalResponse: "The final answer." },
        { ...state(), finalResponse: "The final answer." },
        { ...state(), assistantText: "Streaming answer" },
        { ...state(), error: "Runtime failed" },
        { ...state(), status: "waiting_for_approval" },
        { ...state(), plan: [{ text: "Inspect the issue", status: "in_progress" }] },
        { ...state(), fileSummary: [{ path: "changed.ts" }] },
      ];
      for (const input of cases) {
        const rendered = snapshot(input);
        expect(rendered.content).not.toContain(waitingText);
        const timeline = parseHTML(rendered.content).document.querySelector(".timeline")!;
        expect(timeline.hasAttribute("hidden")).toBe(true);
        expect(timeline.innerHTML).toBe("");
        if (input.finalResponse) expect(rendered.content).toContain(input.finalResponse);
        expect(rendered.status).toBe(input.status);
      }
      const withTools = snapshot({ ...state({}), status: "completed", finalResponse: "Done" });
      expect(withTools.content).not.toContain(waitingText);
      expect(parseHTML(withTools.content).document.querySelector(".timeline")?.hasAttribute("hidden")).toBe(false);
      const page = renderTurnPreviewPage({ state: cases[3]!, eventsUrl: "/events", scriptPath: "/client.js", language });
      expect(page).not.toContain(waitingText);
      expect(page).toContain("The final answer.");
    }
  });

  test("reserves page scrollbar space without changing nested tool scrolling", () => {
    const page = renderTurnPreviewPage({ state: state({}), eventsUrl: "/events", scriptPath: "/client.js" });
    expect(page).toContain("html { scrollbar-gutter: stable; }");
    expect(page).toMatch(/@supports not \(scrollbar-gutter: stable\)\s*\{\s*html \{ overflow-y: scroll; \}/u);
    expect(page).toMatch(/\.tool-content \{[^}]*overflow: auto;/u);
    expect(page).toContain(".tool-content { scrollbar-width: none; }");
  });

  test("renders persisted initial and appended images with signed raw URLs", () => {
    const first = path.resolve("image #1 (a) & b.png");
    const second = path.resolve("image #2.png");
    const input = state();
    input.promptImagePaths = [first];
    input.activities = [{ kind: "user", id: "steer:image", text: "x".repeat(7000), localImagePaths: [second, second] }];
    const resolve = (filePath: string) => `https://viewer.example/preview/signed?path=${encodeURIComponent(filePath)}&sig=token`;
    const saved = JSON.parse(JSON.stringify(input)) as TurnViewState;
    const document = parseHTML(renderTurnPreviewSnapshot(saved, resolve).content).document;
    const promptImage = document.querySelector(".user.prompt img")!;
    const steerImages = document.querySelectorAll('[data-activity="steer:image"] img');
    expect(steerImages).toHaveLength(1);
    for (const [image, filePath] of [[promptImage, first], [steerImages[0]!, second]] as const) {
      const url = new URL(image.getAttribute("src")!);
      expect(url.origin).toBe("https://viewer.example");
      expect(url.searchParams.get("path")).toBe(filePath);
      expect(url.searchParams.get("sig")).toBe("token");
      expect(url.searchParams.get("raw")).toBe("1");
    }
    expect(promptImage.getAttribute("alt")).toBe("图片 1");
  });

  test("handles image-only messages, missing cached images, and legacy text-only snapshots", () => {
    const input = state();
    input.prompt = "";
    input.promptImagePaths = [path.resolve("removed.png")];
    input.activities = [{ kind: "user", id: "steer:image", text: "", localImagePaths: [path.resolve("also-removed.png")] }];
    const unavailable = renderTurnPreviewSnapshot(input, () => undefined, "en").content;
    expect(unavailable).toContain("Image 1 unavailable");
    expect(unavailable).not.toContain("<img");
    expect(unavailable).not.toContain("removed.png");
    expect(renderTurnPreviewSnapshot(input, () => "javascript:alert(1)").content).not.toContain("<img");
    delete input.promptImagePaths;
    input.prompt = "Old Prompt";
    input.activities = [{ kind: "user", id: "steer:old", text: "Old message" }];
    const legacy = renderTurnPreviewSnapshot(input).content;
    expect(legacy).toContain("Old Prompt");
    expect(legacy).toContain("Old message");
    expect(legacy).not.toContain("message-image");
  });

  test.each(["zh", "en"] as const)("shows the latest runtime error reason literally in the %s preview", (language) => {
    let input = state();
    const additionalDetails = 'rate_limit_reached (code=3003). Please try again in 60 seconds.\n<script>alert(1)</script> ![remote](https://example.test/error.png)';
    for (const attempt of [1, 2]) {
      const mapped = mapCodexNotification("error", {
        threadId: "thread", turnId: "turn", willRetry: true,
        error: { message: `Reconnecting... ${attempt}/5`, additionalDetails },
      });
      if (mapped?.kind !== "runtime_error") throw new Error("Expected a runtime error");
      input = reduceTurnEvent(input, {
        type: "progress", sessionId: "session", turnId: "turn", activityId: "commentary:runtime-error:turn",
        severity: "warning", append: false, text: `运行请求出错，Agent 正在重试：${mapped.message}`,
      });
      const preview = renderTurnPreviewSnapshot(input, undefined, language);
      expect(preview.terminal).toBe(false);
      expect(preview.content).toContain(`Reconnecting... ${attempt}/5`);
      expect(preview.content.match(/rate_limit_reached/g)).toHaveLength(1);
      expect(preview.content).toContain("Please try again in 60 seconds.");
      expect(preview.content).toContain("&lt;script&gt;");
      expect(preview.content).not.toContain("<script>");
      expect(preview.content).not.toContain("<img");
    }
    expect(input.activities).toHaveLength(1);
    expect(renderTurnPreviewSnapshot(input).content).not.toContain("Reconnecting... 1/5");
    input = reduceTurnEvent(input, { type: "turn_completed", sessionId: "session", turnId: "turn", finalResponse: "Recovered" });
    const completed = renderTurnPreviewSnapshot(input, undefined, language);
    expect(completed.terminal).toBe(true);
    expect(completed.content).toContain("rate_limit_reached");
    expect(completed.content).toContain("Recovered");
  });

  test("keeps long error reasons complete in Preview and activity history while bounding the live card", () => {
    const text = `Reconnecting... 2/5\n\n${"upstream detail ".repeat(500)}\nRATE_LIMIT_END`;
    const input = reduceTurnEvent(state(), {
      type: "progress", sessionId: "session", turnId: "turn", activityId: "commentary:runtime-error:turn",
      severity: "warning", append: false, text,
    });
    expect(renderTurnPreviewSnapshot(input).content).toContain(text);
    const renderer = new CardRenderer();
    expect(JSON.stringify(renderer.renderTurn(input))).not.toContain("RATE_LIMIT_END");
    expect(JSON.stringify(renderer.renderActivityHistory(input, 0))).toContain("RATE_LIMIT_END");
    input.status = "failed";
    input.error = "Request failed\n\nHTTP 429: rate_limit_reached";
    const failed = renderTurnPreviewSnapshot(input);
    expect(failed.terminal).toBe(true);
    expect(failed.content).toContain(input.error);
  });

  test("does not restore a promoted answer through the legacy progress fallback", () => {
    let input = reduceTurnEvent(state(), {
      type: "progress", sessionId: "session", turnId: "turn", activityId: "commentary:answer", text: "Only the final answer.",
    });
    input = reduceTurnEvent(input, {
      type: "agent_text_delta", sessionId: "session", turnId: "turn", text: "Only the final answer.", replacesActivityId: "commentary:answer",
    });
    input = reduceTurnEvent(input, { type: "turn_completed", sessionId: "session", turnId: "turn", finalResponse: "Only the final answer." });
    expect(input.activities).toEqual([]);
    expect(input.progressText).toBeUndefined();
    expect(renderTurnPreviewSnapshot(input).content.match(/Only the final answer\./g)).toHaveLength(1);
    expect(JSON.stringify(new CardRenderer().renderTurnDetails(input)).match(/Only the final answer\./g)).toHaveLength(1);
  });

  test("keeps unphased updates in the timeline and promotes only the actual final answer", () => {
    let input = state();
    input = reduceTurnEvent(input, {
      type: "progress", sessionId: "session", turnId: "turn", activityId: "commentary:progress", text: "Inspecting the code.",
    });
    input = reduceTurnEvent(input, { type: "tool_started", sessionId: "session", turnId: "turn",
      tool: { id: "tool", kind: "command", title: "git status", status: "running" } });
    const preview = renderTurnPreviewSnapshot(input);
    expect(preview.content.indexOf("Inspecting the code.")).toBeLessThan(preview.content.indexOf("git status"));
    expect(preview.content).not.toContain("回答生成中");
    expect(JSON.stringify(new CardRenderer().renderTurn(input))).toContain("Inspecting the code.");
    input = reduceTurnEvent(input, {
      type: "progress", sessionId: "session", turnId: "turn", activityId: "commentary:answer", text: "Final answer.",
    });
    input = reduceTurnEvent(input, {
      type: "agent_text_delta", sessionId: "session", turnId: "turn", text: "Final answer.", replacesActivityId: "commentary:answer",
    });
    input = reduceTurnEvent(input, { type: "turn_completed", sessionId: "session", turnId: "turn", finalResponse: "Final answer." });
    const completed = renderTurnPreviewSnapshot(input);
    expect(completed.content.match(/Final answer\./g)).toHaveLength(1);
    expect(completed.content).toContain("Inspecting the code.");
    expect(completed.content).not.toContain("回答生成中");
    expect(input.activities.map((activity) => activity.id)).toEqual(["commentary:progress", "tool"]);
  });

  test.each(["zh", "en"] as const)("shows pending plan confirmation safely in the %s read-only preview", (language) => {
    const input = state();
    input.status = "waiting_for_approval";
    input.activities = [{ kind: "assistant", id: "commentary:plan:p1", text: "## Implementation plan\nRun tests before building." }];
    input.approval = {
      id: "mode:thr_1:r1", kind: "mode_change", title: '<img src=x onerror="alert(1)">',
      reason: "**Review plan**\n<script>alert(1)</script>", options: [{ id: "accept", label: "Approve Plan" }],
    };
    const pending = renderTurnPreviewSnapshot(input, undefined, language);
    expect(pending.statusLabel).toBe(language === "zh" ? "等待确认" : "Waiting for approval");
    expect(pending.content).toContain("Run tests before building.");
    expect(pending.content).toContain("<strong>Review plan</strong>");
    expect(pending.content).toContain("&lt;img");
    expect(pending.content).toContain("&lt;script&gt;");
    expect(pending.content).not.toContain("<script>");
    expect(pending.content).not.toContain("<img src=x");
    expect(pending.content).toContain(language === "zh" ? "请在飞书任务卡片中确认或拒绝。" : "Approve or reject using the task card in Feishu.");
    expect(pending.content).not.toContain("Approve Plan</button>");
    input.approval = undefined;
    input.status = "running";
    const resolved = renderTurnPreviewSnapshot(input, undefined, language);
    expect(resolved.content).not.toContain("<strong>Review plan</strong>");
    expect(resolved.content).toContain("Run tests before building.");
  });

  test.each(["prompt", "commentary", "user", "assistantText", "finalResponse"] as const)("serves local Markdown images in %s through signed raw URLs", (area) => {
    const input = state();
    input.projectCwd = path.resolve("preview project");
    const imagePath = path.join(input.projectCwd, "auth #1.png");
    const markdown = [
      `![Absolute](<${imagePath.replaceAll("\\", "/").replaceAll("#", "%23")}>)`,
      `![File URL](${pathToFileURL(imagePath).href})`,
      "![Relative][qr]", "", "[qr]: auth%20%231.png", "",
      "`![Literal](auth%20%231.png)`",
    ].join("\n");
    if (area === "commentary" || area === "user") {
      input.activities = [{ kind: area === "commentary" ? "assistant" : "user", id: area, text: markdown }];
    } else {
      input[area] = markdown;
    }
    const resolveUrl = vi.fn(() => "https://viewer.example/preview/signed?path=auth.png");
    const { content } = renderTurnPreviewSnapshot(input, resolveUrl);
    expect(resolveUrl.mock.calls).toEqual([[imagePath], [imagePath], [imagePath]]);
    expect(content.match(/src="https:\/\/viewer.example\/preview\/signed\?path=auth.png&amp;raw=1"/gu)).toHaveLength(3);
    expect(content).toContain("<code>![Literal](auth%20%231.png)</code>");
    expect(content).not.toContain('src="file:');
  });

  test("resolves absolute images without a project and does not guess a relative image's directory", () => {
    const input = state();
    const imagePath = path.resolve("auth.png");
    input.finalResponse = `![Absolute](<${imagePath.replaceAll("\\", "/")}>)\n![Relative](auth.png)`;
    const resolveUrl = vi.fn(() => "https://viewer.example/preview/signed");
    const { content } = renderTurnPreviewSnapshot(input, resolveUrl);
    expect(resolveUrl.mock.calls).toEqual([[imagePath]]);
    expect(content).toContain('src="https://viewer.example/preview/signed?raw=1" alt="Absolute"');
  });

  test("never emits file URLs when a local image cannot be resolved", () => {
    const input = state();
    input.finalResponse = `![Missing](${pathToFileURL(path.resolve("missing.png")).href})`;
    expect(renderTurnPreviewSnapshot(input).content).not.toContain('src="file:');
    expect(renderTurnPreviewSnapshot(input, () => undefined).content).not.toContain('src="file:');
  });

  test("links changed files from the project directory in both file lists", () => {
    const file = { path: "src/changed & reviewed.ts", additions: 3, deletions: 1 };
    const input = state({ files: [file] });
    input.projectCwd = path.resolve("preview-project");
    const absolutePath = path.join(input.projectCwd, file.path);
    input.fileSummary = [file, { path: absolutePath }, { path: "removed.ts" }];
    const resolveUrl = vi.fn((target: string) => target === absolutePath
      ? "https://viewer.example/preview/signed?path=file&mode=code"
      : undefined);

    const { content } = renderTurnPreviewSnapshot(input, resolveUrl);
    expect(content.match(/class="file-link"/gu)).toHaveLength(3);
    expect(content).toContain('href="https://viewer.example/preview/signed?path=file&amp;mode=code" target="_blank" rel="noreferrer noopener"');
    expect(content.split(`<code>${path.join("src", "changed &amp; reviewed.ts")}</code></a>`)).toHaveLength(4);
    expect(content).toContain('<span class="additions">+3</span>');
    expect(content).toContain('<span class="deletions">-1</span>');
    expect(content).toContain("<li><code>removed.ts</code></li>");
    expect(resolveUrl).toHaveBeenCalledWith(absolutePath);
    expect(resolveUrl).not.toHaveBeenCalledWith(file.path);
  });

  test.each([
    [path.resolve("preview-project"), path.resolve("preview-project/src/file.ts"), path.join("src", "file.ts")],
    [path.resolve("preview-project"), "./src/file.ts", path.join("src", "file.ts")],
    [path.resolve("preview-project"), "../external.ts", path.resolve("external.ts")],
    [path.resolve("preview-project"), path.resolve("preview-project-other/file.ts"), path.resolve("preview-project-other/file.ts")],
    [path.resolve("preview-project"), "..cache/file.ts", path.join("..cache", "file.ts")],
    ["C:\\project", "c:/project/src/file.ts", "src\\file.ts"],
    ["C:\\project", "C:/project-other/file.ts", "C:\\project-other\\file.ts"],
    ["C:\\project", "D:/project/file.ts", "D:\\project\\file.ts"],
    ["\\\\server\\share\\project", "\\\\server\\share\\project\\src\\file.ts", "src\\file.ts"],
    ["\\\\server\\share\\project", "\\\\server\\other\\file.ts", "\\\\server\\other\\file.ts"],
  ])("displays %s / %s relative only when it belongs to the project", (projectCwd, filePath, expected) => {
    const file = { path: filePath };
    const input = state({ files: [file] });
    input.projectCwd = projectCwd;
    input.fileSummary = [file];
    const resolveUrl = vi.fn(() => undefined);
    for (const viewer of [undefined, resolveUrl]) {
      const { content } = renderTurnPreviewSnapshot(input, viewer);
      expect(content.split(`<code>${expected}</code>`)).toHaveLength(3);
      expect(content).not.toContain('class="file-link"');
    }
  });

  test("keeps file paths readable without a viewer or a project directory", () => {
    const input = state({ files: [{ path: "src/file.ts" }] });
    input.fileSummary = [{ path: "src/file.ts" }];
    const resolveUrl = vi.fn(() => "https://viewer.example/preview/file");
    const withoutProject = renderTurnPreviewSnapshot(input, resolveUrl).content;
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(withoutProject).not.toContain('class="file-link"');
    expect(withoutProject.match(/<code>src\/file.ts<\/code>/gu)).toHaveLength(2);
    input.projectCwd = path.resolve("preview-project");
    expect(renderTurnPreviewSnapshot(input).content).not.toContain('class="file-link"');
  });

  test("localizes UI labels without changing command content", () => {
    const input = state({ output: "command output" });
    input.totalTokens = 42;
    input.model = "gpt-5.3-codex";
    input.latestContextTokens = 1_024;
    input.tokenUsageCumulative = 1_536;
    input.contextCompactionAfterTokens = 768;
    input.totalToolCount = 1;
    const snapshot = renderTurnPreviewSnapshot(input, undefined, "en");
    expect(snapshot.statusLabel).toBe("Processing");
    expect(snapshot.content).toContain('<code class="tool-command-title">npm test</code>');
    expect(snapshot.content).toContain('aria-label="Output"');
    expect(snapshot.content).toContain('title="Start time"');
    expect(snapshot.content).toContain("14 characters");
    expect(snapshot.content).toContain('class="tool-header-timing">1s</span>');
    expect(snapshot.content).toContain("Success");
    expect(snapshot.content).toContain("command output");
    expect(snapshot.content).not.toContain(">命令<");
    expect(snapshot.content).not.toContain(">输出");
    expect(snapshot.metadata).toContain("tools");
    expect(snapshot.metadata).toContain('title="Turn">42 tokens</span>');
    expect(snapshot.metadata).toContain('title="Model">gpt-5.3-codex</span>');
    expect(snapshot.metadata).not.toContain("Context");
    expect(snapshot.metadata).not.toContain("Cumulative");
    const chineseMetadata = renderTurnPreviewSnapshot(input, undefined, "zh").metadata;
    expect(chineseMetadata).toContain('title="本轮">42 tokens</span>');
    expect(chineseMetadata).not.toContain("累计");
    expect(chineseMetadata).not.toContain("上下文");
    input.contextCompactionBeforeTokens = 1_024;
    expect(renderTurnPreviewSnapshot(input, undefined, "en").metadata).toContain('title="Compaction">1K → 768 tokens</span>');

    const page = renderTurnPreviewPage({ state: input, eventsUrl: "/events", scriptPath: "/client.js", language: "en" });
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('<div class="header-top">');
    expect(page).toContain("Live updates");
  });

  test.each(["zh", "en"] as const)("renders current-turn total and cache tokens with exact values in %s", (language) => {
    const mapped = mapCodexNotification("thread/tokenUsage/updated", {
      threadId: "thread", turnId: "turn", tokenUsage: {
        last: { inputTokens: 3_558, outputTokens: 5, totalTokens: 3_563, cachedInputTokens: 3_555 },
        total: { inputTokens: 13_558, outputTokens: 105, totalTokens: 13_663, cachedInputTokens: 13_555 },
      },
    });
    if (mapped?.kind !== "token_usage") throw new Error("Expected token usage");
    const input = reduceTurnEvent(state(), { ...mapped, type: "token_usage_updated", sessionId: "session" });
    const labels = language === "zh" ? ["非缓存", "总计", "缓存命中"] : ["Non-cached", "Total", "Cache hit"];
    for (const status of ["running", "completed"] as const) {
      const snapshot = renderTurnPreviewSnapshot({ ...input, status }, undefined, language);
      expect(snapshot.metadata).toContain(`title="${labels[0]}: 8 tokens">${labels[0]} 8 tokens</span>`);
      expect(snapshot.metadata).toContain(`title="${labels[1]}: 3,563 tokens">${labels[1]} 3.6K tokens</span>`);
      expect(snapshot.metadata).toContain(`title="${labels[2]}: 3,555 tokens">${labels[2]} 3.6K tokens</span>`);
      expect(snapshot.metadata).not.toContain("13,663");
    }
    expect(renderTurnPreviewSnapshot({ ...input, cachedInputTokens: 0 }, undefined, language).metadata)
      .toContain(`${labels[2]} 0 tokens</span>`);
    const legacy = renderTurnPreviewSnapshot({ ...state(), totalTokens: 8 }, undefined, language).metadata;
    expect(legacy).not.toContain(labels[1]);
    expect(legacy).not.toContain(labels[2]);
  });

  test("detects the preferred browser language from Accept-Language", () => {
    expect(detectTurnPreviewLanguage(undefined)).toBe("zh");
    expect(detectTurnPreviewLanguage("en-US,en;q=0.9,zh;q=0.8")).toBe("en");
    expect(detectTurnPreviewLanguage("en;q=0.8,zh-CN;q=0.9")).toBe("zh");
  });

  test("renders saved reasoning summaries while preserving commentary and tools", () => {
    const input = state({});
    const tool = input.activities[0]!;
    input.activities = [
      { kind: "reasoning", id: "r1", text: "First **thought**." },
      { kind: "reasoning", id: "r2", text: "Second thought." },
      { kind: "assistant", id: "c1", text: "Checking the code." },
      { kind: "reasoning", id: "r3", text: "Third thought." },
      tool,
      { kind: "reasoning", id: "r4", text: "Fourth thought." },
      { kind: "user", id: "u1", text: "Also check mobile." },
      { kind: "reasoning", id: "r5", text: "Fifth thought." },
      { kind: "reasoning", id: "r6", text: "Sixth thought." },
    ];
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).toContain("First");
    expect(content).toContain("Second thought.");
    expect(content).toContain("Third thought.");
    expect(content).toContain("Fourth thought.");
    expect(content).toContain("Fifth thought.");
    expect(content).toContain("Sixth thought.");
    expect(content).toContain("Checking the code.");
    expect(content).toContain("Also check mobile.");
    expect(content).toContain('<details class="tool-step" ');
    expect(content).toContain('<summary class="tool-header">');
    expect(content).not.toContain('<details class="tool-step" open');
  });

  test("renders newly arriving summaries without removing earlier summaries", () => {
    const input = state();
    input.activities = [{ kind: "reasoning", id: 'r"1', text: "Initial thought." }];
    const before = renderTurnPreviewSnapshot(input).content;
    input.activities.push({ kind: "reasoning", id: "r2", text: "Continued thought." });
    const after = renderTurnPreviewSnapshot(input).content;
    expect(before).toContain("Initial thought.");
    expect(after).toContain("Initial thought.");
    expect(after).toContain("Continued thought.");
  });

  test("does not repeat activity kinds in message and reasoning headers", () => {
    const input = state();
    input.activities = [
      { kind: "assistant", id: "c1", text: "Checking the code." },
      { kind: "user", id: "u1", text: "Also check mobile." },
      { kind: "reasoning", id: "r1", text: "Thinking about the layout." },
      { kind: "reasoning", id: "r2", text: "Choosing the compact form." },
    ];
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).not.toContain('class="activity-label"');
    expect(content).not.toContain(">Prompt<");
    expect(content).not.toContain(">Commentary<");
    expect(content).not.toContain(">用户补充<");
    expect(content).not.toContain("原生思考");
    expect(content).toContain("Thinking about the layout.");
    expect(content).toContain("Choosing the compact form.");
  });

  test("shows the full prompt once in the body with a compact page heading", () => {
    const input = state();
    input.prompt = `Inspect ${"a long prompt ".repeat(30)}and the ending.`;
    const page = renderTurnPreviewPage({ state: input, eventsUrl: "/events", scriptPath: "/client.js" });
    const body = page.slice(page.indexOf("<body"));
    expect(body.split(input.prompt)).toHaveLength(2);
    expect(body).toMatch(/<h1[^>]*>Turn Preview<\/h1>/u);
  });

  test.each([
    ["Read", [{ type: "read", path: "D:\\dev\\agent bot\\src\\file.ts" }], "Read D:\\dev\\agent bot\\src\\file.ts"],
    ["Grep", [{ type: "search", query: "tool\\.command|title", path: "src/codex" }], 'Grep &quot;tool\\\\.command|title&quot; · src/codex'],
    ["Read", [{ type: "read", path: "src/a&b.ts" }], "Read src/a&amp;b.ts"],
    ["Grep", [{ type: "search", query: "<script>alert(1)</script>", path: "src" }], 'Grep &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; · src'],
    ["Get-Content src/file.ts", [{ type: "read", path: "src/file.ts" }], "Get-Content src/file.ts"],
    ['rg "pattern" src', [{ type: "search", query: "pattern", path: "src" }], 'rg &quot;pattern&quot; src'],
    ["Read", undefined, "Read"],
  ])("renders mapped %s targets safely in the title and expanded command", (command, commandActions, expected) => {
    for (const method of ["item/started", "item/completed"]) {
      const mapped = mapCodexNotification(method, {
        threadId: "thread", turnId: "turn",
        item: { id: "tool:1", type: "commandExecution", command, commandActions, aggregatedOutput: "file contents" },
      });
      expect(mapped?.kind).toBe("tool");
      if (mapped?.kind !== "tool") throw new Error("Expected a mapped tool");
      expect(mapped.tool.files).toBeUndefined();
      for (const language of ["zh", "en"] as const) {
        const { content } = renderTurnPreviewSnapshot(state(mapped.tool), undefined, language);
        expect(content).toContain(`<code class="tool-command-title">${expected}</code>`);
        expect(content).toContain(`<pre class="command-block">${expected}</pre>`);
        expect(content).toContain("file contents");
        expect(content).not.toContain("<script>");
        expect(content.match(/<details /gu)).toHaveLength(1);
        expect(content.match(/data-scroll-id=/gu)).toHaveLength(1);
      }
    }
  });

  test("collapses the cleaned command to a summary and keeps the full command in the body", () => {
    const startedAt = new Date(2026, 8, 12, 7, 30, 1).getTime();
    const { content } = renderTurnPreviewSnapshot(state({
      status: "failed", exitCode: 1,
      startedAt, completedAt: startedAt + 1_500,
      output: "Command failed.\r\n<script>bad</script>\r\n",
      error: "Command failed.\n<script>bad</script>",
    }));
    expect(content.split("npm test")).toHaveLength(3);
    expect(content).not.toContain("/bin/zsh");
    expect(content).toMatch(/<details class="tool-step" /u);
    expect(content).toContain('<summary class="tool-header">');
    expect(content).toContain('<code class="tool-command-title">npm test</code>');
    expect(content).toContain('<pre class="command-block"');
    const header = /<summary class="tool-header"[^>]*>([\s\S]*?)<\/summary>/u.exec(content)?.[1] ?? "";
    expect(header).toContain('title="失败">❌</span>');
    expect(header).not.toContain('class="tool-state');
    expect(header).toContain('class="tool-header-timing">1s</span>');
    expect(content.match(/class="tool-state failed"/gu)).toHaveLength(1);
    expect(header).not.toContain('title="开始时间"');
    expect(content).toContain('<pre class="tool-output error-output" aria-label="结果 / 错误">');
    expect(content.match(/<details /gu)).toHaveLength(1);
    expect(content).toContain('<span class="tool-command-prefix" aria-hidden="true">$</span>');
    expect(content).toContain(`datetime="${new Date(startedAt).toISOString()}" title="开始时间">07:30:01</time>`);
    expect(content).toContain("39 字符");
    expect(content.split("Command failed.")).toHaveLength(2);
    expect(content).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(content).not.toContain("<script>");
    expect(content).not.toContain("退出码 1");
    expect(content).not.toContain("耗时 00:01");
    expect(content).not.toContain(">完成<");
  });

  test("keeps the tool status visible and uses more than the first line in a command summary", () => {
    const input = state({
      command: "@'\nconst result = await inspectProject();\nconsole.log(result);\n'@ | node",
      startedAt: 1_000, completedAt: 3_000,
    });
    const { content } = renderTurnPreviewSnapshot(input);
    const header = /<summary class="tool-header"[^>]*>([\s\S]*?)<\/summary>/u.exec(content)?.[1] ?? "";
    expect(header).toContain("@&#39; const result = await inspectProject(); console.log(result);");
    expect(header).toContain('class="tool-header-timing">2s</span>');
    expect(header).toContain('title="成功">✅</span>');
    expect(content).toContain("const result = await inspectProject();\nconsole.log(result);");
  });

  test.each([
    [0, ""], [500, ""], [58_000, "58s"], [60_000, "1:00"], [152_000, "2:32"],
  ])("shows compact nonzero durations for %i ms in the header and fixed footer", (durationMs, expected) => {
    const { content } = renderTurnPreviewSnapshot(state({
      startedAt: 1_000, completedAt: 1_000 + durationMs,
      output: "output contents", error: "error contents", files: [{ path: "changed.ts" }],
    }));
    const header = /<summary class="tool-header">([\s\S]*?)<\/summary>/u.exec(content)![1]!;
    expect(header).toContain(`class="tool-header-timing">${expected}</span>`);
    expect(header).toContain('title="成功">✅</span>');
    const body = content.slice(content.indexOf('<div class="tool-body">'));
    expect(body).toContain('class="tool-state completed">成功</span>');
    expect(body).toContain(`class="tool-footer-timing">${expected}</span>`);
    expect(body).not.toContain("tool-header-timing");
    expect(body).toContain('title="开始时间"');
    expect(body).toContain("29 字符");
    expect(body).not.toContain("<details");
    expect(body).not.toContain("耗时");
    expect(body).toContain("输出");
    expect(body).toContain("错误");
    expect(body).toContain("文件");
    expect(body).toContain("output contents");
    expect(body).toContain("error contents");
    expect(body).toContain("changed.ts");
  });

  test("formats REPL input as readable code instead of showing the argument JSON", () => {
    const input = state();
    input.activities = [{ kind: "tool", id: "repl:1", tool: {
      id: "repl:1", title: "browser.repl", kind: "mcp", status: "completed",
      command: `browser.repl\n${JSON.stringify({ input: "const first = 1; const second = first + 1;" })}`,
      output: JSON.stringify({
        content: [{ type: "text", text: "value: 2\\nmessage: done" }],
        structuredContent: { value: 2 },
        _meta: { executionTimeMs: 12 },
      }),
      startedAt: 1_000, completedAt: 2_000,
    } }];
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).toContain('<code class="tool-command-title">const first = 1;');
    expect(content).not.toContain(">REPL<");
    expect(content).not.toContain('class="command-block"');
    expect(content).toContain("const first = 1;\nconst second = first + 1;");
    expect(content).not.toContain('"input"');
    expect(content).toContain('aria-label="结果"');
    expect(content).toContain("22 字符");
    expect(content).toContain("value: 2\nmessage: done");
    expect(content).not.toContain("structuredContent");
    expect(content).not.toContain("executionTimeMs");
    expect(content).not.toContain("&quot;value&quot;");
    expect(content).toContain("repl-result");
  });

  test("removes the shell wrapper before formatting a REPL command", () => {
    const input = state();
    input.activities = [{ kind: "tool", id: "repl:wrapped", tool: {
      id: "repl:wrapped", title: "cua_repl.js", kind: "mcp", status: "completed",
      command: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'cua_repl.js\n${JSON.stringify({ code: "await page.reload();" })}'`,
      startedAt: 1_000, completedAt: 2_000,
    } }];
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).toContain("await page.reload();");
    expect(content).not.toContain("Program Files\\PowerShell");
    expect(content).not.toContain("-Command");
  });

  test("does not classify a shell command that mentions a REPL as a REPL tool", () => {
    const input = state();
    input.activities = [{ kind: "tool", id: "tool:query", tool: {
      id: "tool:query", title: "pwsh -Command query cua_repl.js", kind: "command", status: "completed",
      command: "@'\nconst result = await query('cua_repl.js');\n'@ | node",
      startedAt: 1_000, completedAt: 2_000,
    } }];
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).toContain('<code class="tool-command-title">@&#39;');
    expect(content).not.toContain(">REPL<");
    expect(content).toContain("@&#39;");
    expect(content).toContain("const result = await query");
  });

  test("formats compound commands and structured tool arguments across multiple lines", () => {
    const input = state();
    input.activities = [{ kind: "tool", id: "tool:format", tool: {
      id: "tool:format", title: "browser.open", kind: "mcp", status: "completed",
      command: `browser.open\n${JSON.stringify({ url: "https://example.com", options: { waitUntil: "load" } })}`,
      startedAt: 1_000, completedAt: 2_000,
    } }];
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).toContain("browser.open\n{");
    expect(content).toContain("  &quot;options&quot;: {");
    expect(content).toContain("    &quot;waitUntil&quot;: &quot;load&quot;");

    input.activities[0] = { kind: "tool", id: "tool:shell", tool: {
      id: "tool:shell", title: "build", kind: "command", status: "completed",
      command: "/bin/bash -lc 'npm test && npm run build'",
      startedAt: 1_000, completedAt: 2_000,
    } };
    const shellContent = renderTurnPreviewSnapshot(input).content;
    expect(shellContent).toContain("npm test &amp;&amp; \\\n  npm run build");
  });

  test("renders the full output retained separately from the card-sized snapshot", () => {
    const input = state({ output: "…tail" });
    input.fullToolOutputs = { "tool:1": `head ${"x".repeat(7_000)} tail` };
    const { content } = renderTurnPreviewSnapshot(input);
    expect(content).toContain(`head ${"x".repeat(7_000)} tail`);
    expect(content).not.toContain("…tail");
    expect(content).toContain("7,010 字符");
  });

  test("keeps distinct error details and tool images available", () => {
    const { content } = renderTurnPreviewSnapshot(state({
      output: "partial output", error: "a different failure", imagePath: "C:/test/image.png",
    }), () => "http://localhost/file?signed=1");
    expect(content).toContain('<pre class="tool-output" aria-label="输出">');
    expect(content).toContain('<pre class="tool-output error-output" aria-label="错误">');
    expect(content.match(/<details /gu)).toHaveLength(1);
    expect(content).toContain("partial output");
    expect(content).toContain("a different failure");
    expect(content).toContain('src="http://localhost/file?signed=1&amp;raw=1"');
  });

  test("shares one scroll region and keeps start time and result size outside it", () => {
    const { content } = renderTurnPreviewSnapshot(state({
      startedAt: undefined, completedAt: undefined,
      command: "npm test", output: "test output", files: [{ path: "changed.ts" }],
    }));
    expect(content.match(/<details /gu)).toHaveLength(1);
    expect(content.match(/data-scroll-id=/gu)).toHaveLength(1);
    expect(content).toContain('class="tool-content" data-scroll-id="tool:1:content" tabindex="0"');
    expect(content).toMatch(/<\/ul><\/div><div class="tool-footer"><span class="tool-state completed">成功<\/span><span title="开始时间">未知<\/span><span class="tool-footer-timing">\?<\/span><span>11 字符<\/span><\/div>/u);
    expect(content.indexOf('class="command-block"')).toBeLessThan(content.indexOf('class="tool-output"'));
  });

  test("ticks only live tools and leaves unknown terminal durations unknown", () => {
    const running = renderTurnPreviewSnapshot(state({ status: "running", completedAt: undefined }));
    expect(running.content.match(/data-live-tool-duration/gu)).toHaveLength(2);
    const unknown = renderTurnPreviewSnapshot(state({ completedAt: undefined }));
    expect(unknown.content).toContain('class="tool-header-timing">?</span>');
    expect(unknown.content).not.toContain("data-live-tool-duration");
    const completed = state({});
    completed.status = "failed";
    const page = renderTurnPreviewPage({ state: completed, eventsUrl: "/events", scriptPath: "/client.js" });
    expect(page).not.toContain("data-live-elapsed");
    expect(page).not.toContain(">已完成<");
    expect(page).toContain(">执行失败<");
  });

  test.each([
    ["running", "⏳", "进行中"], ["completed", "✅", "成功"], ["failed", "❌", "失败"],
  ] as const)("places the %s icon before the title and the text status in the footer", (status, icon, label) => {
    const { content } = renderTurnPreviewSnapshot(state({ status }));
    const header = /<summary class="tool-header">([\s\S]*?)<\/summary>/u.exec(content)![1]!;
    expect(content).toContain(`data-tool-status="${status}"`);
    expect(header).toContain(`aria-label="${label}" title="${label}">${icon}</span>`);
    expect(header.indexOf(icon)).toBeLessThan(header.indexOf('class="tool-command-title"'));
    expect(header).not.toContain('class="tool-state');
    expect(content).toContain(`<div class="tool-footer"><span class="tool-state ${status}">${label}</span>`);
  });

  test.each(["\\", "`", "^"])("omits %s line continuations in summaries while preserving paths and full commands", (continuation) => {
    const command = `Get-Content C:\\src\\file.ts ${continuation}\n  -Raw`;
    const { content } = renderTurnPreviewSnapshot(state({ command }));
    const header = /<summary class="tool-header">([\s\S]*?)<\/summary>/u.exec(content)![1]!;
    expect(header).toContain('<code class="tool-command-title">Get-Content C:\\src\\file.ts -Raw</code>');
    expect(content).toContain(`<pre class="command-block">${command}</pre>`);
  });

  test("omits display-only shell continuation markers from compound command summaries", () => {
    const { content } = renderTurnPreviewSnapshot(state({ command: "npm test && npm run build" }));
    const header = /<summary class="tool-header">([\s\S]*?)<\/summary>/u.exec(content)![1]!;
    expect(header).toContain('<code class="tool-command-title">npm test &amp;&amp; npm run build</code>');
    expect(content).toContain("npm test &amp;&amp; \\\n  npm run build");
  });
});

describe("deferred Turn Preview rendering", () => {
  test("omits collapsed logs, images, file lists and long commands from initial HTML and SSE summaries", () => {
    const input = state({ command: "run " + "x".repeat(500), output: "PRIVATE OUTPUT " + "x".repeat(100_000), error: "PRIVATE ERROR", imagePath: path.resolve("private.png"), files: [{ path: path.resolve("private.ts") }] });
    input.fullToolOutputs = { "tool:1": "FULL LOG " + "y".repeat(100_000) };
    input.fileSummary = [{ path: path.resolve("summary.ts") }];
    const resolver = vi.fn(() => "https://viewer.test/file");
    const summary = renderTurnPreviewSnapshot(input, resolver, "zh", { deferDetails: true });
    const page = renderTurnPreviewPage({ state: input, localFileUrl: resolver, eventsUrl: "/events", scriptPath: "/client.js" });
    for (const content of [page, summary.content]) {
      expect(content).not.toContain("PRIVATE OUTPUT");
      expect(content).not.toContain("FULL LOG");
      expect(content).not.toContain("PRIVATE ERROR");
      expect(content).not.toContain("private.png");
      expect(content).not.toContain("private.ts");
      expect(content).not.toContain("summary.ts");
      expect(content).not.toContain("x".repeat(500));
      expect(content).not.toContain("<img");
      expect(content).toContain('data-detail-key="tool:tool:1"');
      expect(content).toContain('data-detail-key="files"');
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(summary.content.length).toBeLessThan(3000);
    const detail = renderTurnPreviewDetail(input, "tool:tool:1", resolver)!;
    expect(detail.content).toContain("FULL LOG");
    expect(detail.content).toContain("PRIVATE ERROR");
    expect(detail.content).toContain("<img");
    expect(detail.content).not.toContain("summary.ts");
    const revision = detail.revision;
    input.totalTokens = 100;
    expect(renderTurnPreviewDetail(input, detail.key, resolver)!.revision).toBe(revision);
    input.fullToolOutputs["tool:1"] += "changed";
    expect(renderTurnPreviewDetail(input, detail.key, resolver)!.revision).not.toBe(revision);
    expect(renderTurnPreviewDetail(input, "missing", resolver)).toBeUndefined();
    expect(renderTurnPreviewDetail(input, "files", resolver)!.content).toContain("summary.ts");
  });
});
