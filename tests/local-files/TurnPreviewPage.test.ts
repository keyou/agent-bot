import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";
import type { ToolState } from "../../src/runtime/types.js";
import { detectTurnPreviewLanguage, renderTurnPreviewPage, renderTurnPreviewSnapshot } from "../../src/local-files/TurnPreviewPage.js";

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
    expect(content).toContain("<code>src/changed &amp; reviewed.ts</code></a>");
    expect(content).toContain('<span class="additions">+3</span>');
    expect(content).toContain('<span class="deletions">-1</span>');
    expect(content).toContain("<li><code>removed.ts</code></li>");
    expect(resolveUrl).toHaveBeenCalledWith(absolutePath);
    expect(resolveUrl).not.toHaveBeenCalledWith(file.path);
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
    expect(snapshot.content).toContain(">Output");
    expect(snapshot.content).toContain("Duration 00:01");
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

  test("detects the preferred browser language from Accept-Language", () => {
    expect(detectTurnPreviewLanguage(undefined)).toBe("zh");
    expect(detectTurnPreviewLanguage("en-US,en;q=0.9,zh;q=0.8")).toBe("en");
    expect(detectTurnPreviewLanguage("en;q=0.8,zh-CN;q=0.9")).toBe("zh");
  });

  test("omits original reasoning while preserving commentary and tools", () => {
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
    expect(content).not.toContain("First");
    expect(content).not.toContain("Second thought.");
    expect(content).not.toContain("Third thought.");
    expect(content).not.toContain("Fourth thought.");
    expect(content).not.toContain("Fifth thought.");
    expect(content).not.toContain("Sixth thought.");
    expect(content).toContain("Checking the code.");
    expect(content).toContain("Also check mobile.");
    expect(content).toContain('<section class="tool-step" ');
    expect(content).not.toContain('<details class="tool-step"');
  });

  test("does not render original reasoning when more reasoning arrives", () => {
    const input = state();
    input.activities = [{ kind: "reasoning", id: 'r"1', text: "Initial thought." }];
    const before = renderTurnPreviewSnapshot(input).content;
    input.activities.push({ kind: "reasoning", id: "r2", text: "Continued thought." });
    const after = renderTurnPreviewSnapshot(input).content;
    expect(before).not.toContain("Initial thought.");
    expect(after).not.toContain("Initial thought.");
    expect(after).not.toContain("Continued thought.");
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
    expect(content).not.toContain("Thinking about the layout.");
    expect(content).not.toContain("Choosing the compact form.");
  });

  test("shows the full prompt once in the body with a compact page heading", () => {
    const input = state();
    input.prompt = `Inspect ${"a long prompt ".repeat(30)}and the ending.`;
    const page = renderTurnPreviewPage({ state: input, eventsUrl: "/events", scriptPath: "/client.js" });
    const body = page.slice(page.indexOf("<body"));
    expect(body.split(input.prompt)).toHaveLength(2);
    expect(body).toMatch(/<h1[^>]*>Turn Preview<\/h1>/u);
  });

  test("expands the cleaned command once and collapses identical output and error into one disclosure", () => {
    const startedAt = new Date(2026, 8, 12, 7, 30, 1).getTime();
    const { content } = renderTurnPreviewSnapshot(state({
      status: "failed", exitCode: 1,
      startedAt, completedAt: startedAt + 1_500,
      output: "Command failed.\r\n<script>bad</script>\r\n",
      error: "Command failed.\n<script>bad</script>",
    }));
    expect(content.split("npm test")).toHaveLength(2);
    expect(content).not.toContain("/bin/zsh");
    expect(content).toMatch(/<section class="tool-step" /u);
    expect(content).toContain('<code class="tool-command-title">npm test</code>');
    expect(content).not.toContain('class="command-block"');
    const header = /<div class="tool-header"[^>]*>([\s\S]*?)<\/div>/u.exec(content)?.[1] ?? "";
    expect(header).not.toContain("tool-state");
    expect(content).toContain('<span class="tool-output-meta"><span title="开始时间">07:30:01</span><span>耗时 00:01</span><span class="tool-state failed"');
    expect(content).toMatch(/<details class="tool-output error-output" data-activity-id="tool:1:output">/u);
    expect(content).not.toContain('data-activity-id="tool:1:error"');
    expect(content.split("Command failed.")).toHaveLength(2);
    expect(content).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(content).not.toContain("<script>");
    expect(content).not.toContain("退出码 1");
    expect(content).toContain("耗时 00:01");
    expect(content.indexOf(">命令<")).toBeLessThan(content.indexOf(">失败<"));
    expect(content).not.toContain(">完成<");
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
    expect(content).toContain(">结果<");
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
  });

  test("keeps distinct error details and tool images available", () => {
    const { content } = renderTurnPreviewSnapshot(state({
      output: "partial output", error: "a different failure", imagePath: "C:/test/image.png",
    }), () => "http://localhost/file?signed=1");
    expect(content).toContain('data-activity-id="tool:1:output"');
    expect(content).toContain('<details class="tool-output error-output" data-activity-id="tool:1:error">');
    expect(content).toContain("partial output");
    expect(content).toContain("a different failure");
    expect(content).toContain('src="http://localhost/file?signed=1&amp;raw=1"');
  });

  test("ticks only live tools and leaves unknown terminal durations unknown", () => {
    const running = renderTurnPreviewSnapshot(state({ status: "running", completedAt: undefined }));
    expect(running.content).toContain("data-live-tool-duration");
    const unknown = renderTurnPreviewSnapshot(state({ completedAt: undefined }));
    expect(unknown.content).toContain("耗时未知");
    expect(unknown.content).not.toContain("data-live-tool-duration");
    const completed = state({});
    completed.status = "failed";
    const page = renderTurnPreviewPage({ state: completed, eventsUrl: "/events", scriptPath: "/client.js" });
    expect(page).not.toContain("data-live-elapsed");
    expect(page).not.toContain(">已完成<");
    expect(page).toContain(">执行失败<");
  });
});
