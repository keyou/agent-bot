import { describe, expect, test, vi } from "vitest";
import { normalizeFeishuMarkdown } from "../../src/feishu/FeishuMarkdown.js";

describe("normalizeFeishuMarkdown", () => {
  test("moves fenced code blocks nested under list items to the top level", () => {
    const markdown = [
      "1. Actor 错误全部转为：",
      "",
      "   ```cpp",
      "   BuaRendererActionError::kActionFailed",
      "   ```",
      "",
      "2. 最终统一生成：",
      "",
      "   ```json",
      "   {",
      "     \"code\": \"action_failed\"",
      "   }",
      "   ```",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe([
      "1. Actor 错误全部转为：",
      "",
      "```cpp",
      "BuaRendererActionError::kActionFailed",
      "```",
      "",
      "2. 最终统一生成：",
      "",
      "```json",
      "{",
      "  \"code\": \"action_failed\"",
      "}",
      "```",
    ].join("\n"));
  });

  test("leaves top-level fences and their contents unchanged", () => {
    const markdown = [
      "```text",
      "   ```this is code, not a nested fence",
      "value",
      "```",
    ].join("\r\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe(markdown);
  });

  test("includes Windows local file line references in link labels", () => {
    const markdown = "见 [app_controller_mac.mm](/D:/dev/lark2/aha/chrome/browser/app_controller_mac.mm:536)。";

    expect(normalizeFeishuMarkdown(markdown)).toBe(
      "见 [app_controller_mac.mm:536](/D:/dev/lark2/aha/chrome/browser/app_controller_mac.mm:536)。",
    );
  });

  test("includes line and column references for local file links across platforms", () => {
    const markdown = [
      "[worker.ts](/home/user/project/worker.ts:42:7)",
      "[worker.ts](file:///D:/project/worker.ts:42)",
      "[worker.ts](D:\\project\\worker.ts:42)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe([
      "[worker.ts:42:7](/home/user/project/worker.ts:42:7)",
      "[worker.ts:42](file:///D:/project/worker.ts:42)",
      "[worker.ts:42](D:\\project\\worker.ts:42)",
    ].join("\n"));
  });

  test("shows complete paths for files outside the current project", () => {
    const markdown = [
      "[controller.ts](D:\\dev\\agent-bot\\src\\controller.ts:42)",
      "[runner.py](C:\\Users\\Admin\\sandbox_runtime\\runner.py:122)",
      "[cache.cc](/D:/dev/another-project/sandbox_env_cache.cc:490)",
      "[cell.py](file:///C:/Users/Admin/runtime/cell.py:248)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot")).toBe([
      "[controller.ts:42](D:\\dev\\agent-bot\\src\\controller.ts:42)",
      "runner.py(`C:\\Users\\Admin\\sandbox_runtime\\runner.py:122`)",
      "cache.cc(`D:\\dev\\another-project\\sandbox_env_cache.cc:490`)",
      "cell.py(`C:\\Users\\Admin\\runtime\\cell.py:248`)",
    ].join("\n"));
  });

  test("shows file names for local file links inside a Windows project", () => {
    const markdown = [
      "[app.ts](D:\\dev\\agent-bot\\src\\app.ts:12)",
      "[index.ts](/D:/dev/agent-bot/src/index.ts:18)",
      "[README.md](D:\\dev\\agent-bot\\README.md:7)",
      "[转换后的 Trace Markdown](D:/dev/agent-bot/.cache/runs/moa-trace.execution-timeline.md)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot")).toBe([
      "[app.ts:12](D:\\dev\\agent-bot\\src\\app.ts:12)",
      "[index.ts:18](/D:/dev/agent-bot/src/index.ts:18)",
      "[README.md:7](D:\\dev\\agent-bot\\README.md:7)",
      "转换后的 Trace Markdown(`moa-trace.execution-timeline.md`)",
    ].join("\n"));
  });

  test("shows complete POSIX paths only outside the current project", () => {
    const markdown = [
      "[worker.ts](/home/user/project/src/worker.ts:12)",
      "[cell.py](/home/user/project/runtime/cell.py:248)",
      "[shared.ts](/opt/shared/shared.ts:7)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown, "/home/user/project")).toBe([
      "[worker.ts:12](/home/user/project/src/worker.ts:12)",
      "[cell.py:248](/home/user/project/runtime/cell.py:248)",
      "shared.ts(`/opt/shared/shared.ts:7`)",
    ].join("\n"));
  });

  test("does not append the visible local path more than once", () => {
    const markdown = "[转换后的 Trace Markdown](D:/dev/agent-bot/output.md)";
    const normalized = normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot");

    expect(normalized).toBe("转换后的 Trace Markdown(`output.md`)");
    expect(normalizeFeishuMarkdown(normalized, "D:\\dev\\agent-bot")).toBe(normalized);
  });

  test("replaces local file targets with signed viewer URLs while preserving readable path labels", () => {
    const markdown = [
      "[app.ts](D:\\dev\\agent-bot\\src\\app.ts:12)",
      "[转换后的 Trace Markdown](D:/dev/agent-bot/.cache/moa-trace.execution-timeline.md)",
      "[报告](<D:/dev/agent-bot/output/report (final).md>)",
      "[runner.py](C:\\Users\\Admin\\runtime\\runner.py:122)",
    ].join("\n");
    const resolver = (filePath: string, reference?: string): string => {
      const name = filePath.replaceAll("\\", "/").split("/").at(-1);
      return `http://127.0.0.1:3210/view/${encodeURIComponent(name ?? "file")}?sig=signed${reference ? `#L${reference.slice(1).split(":")[0]}` : ""}`;
    };

    expect(normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot", resolver)).toBe([
      "[app.ts:12](http://127.0.0.1:3210/view/app.ts?sig=signed#L12)",
      "[转换后的 Trace Markdown](http://127.0.0.1:3210/view/moa-trace.execution-timeline.md?sig=signed)(`moa-trace.execution-timeline.md`)",
      "[报告](http://127.0.0.1:3210/view/report%20(final).md?sig=signed)(`report (final).md`)",
      "[runner.py](http://127.0.0.1:3210/view/runner.py?sig=signed#L122)(`C:\\Users\\Admin\\runtime\\runner.py:122`)",
    ].join("\n"));
  });

  test("does not duplicate references or rewrite web links, images, or fenced code", () => {
    const markdown = [
      "[worker.ts:42](/D:/project/worker.ts:42)",
      "[service](https://example.com/service:42)",
      "[screenshot](/D:/project/screenshot.png)",
      "![diagram](/D:/project/diagram.png:42)",
      "```markdown",
      "[worker.ts](/D:/project/worker.ts:42)",
      "```",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe(markdown);
  });
  test.each([
    ["D:\\work\\project", "outputs/jev-ultrafast-vs-aha-bua.md", "D:\\work\\project\\outputs\\jev-ultrafast-vs-aha-bua.md"],
    ["D:\\work\\project", "./outputs/report.md", "D:\\work\\project\\outputs\\report.md"],
    ["D:\\work\\project", "outputs\\report.md", "D:\\work\\project\\outputs\\report.md"],
    ["/work/project", "outputs/report.md", "/work/project/outputs/report.md"],
    ["/work/project", "../shared/report.md", "/work/shared/report.md"],
    ["/work/project", "README.md", "/work/project/README.md"],
    ["/work/project", "<outputs/report (final).md>", "/work/project/outputs/report (final).md"],
    ["/work/project", "outputs/报告%20%2520.md", "/work/project/outputs/报告 %20.md"],
    ["/work/project", "outputs/report.md?raw=1&path=/other&download=1", "/work/project/outputs/report.md"],
  ])("resolves relative reports from %s: %s", (cwd, target, expected) => {
    const resolver = vi.fn(() => "http://viewer.test/preview/signed?path=report");
    const normalized = normalizeFeishuMarkdown('[查看研究报告](' + target + ')', cwd, resolver);
    expect(resolver).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    expect(normalized).toContain("[查看研究报告](http://viewer.test/preview/signed?path=report)");
    expect(normalized).not.toContain("raw=1");
    expect(normalized).not.toContain("http://outputs");
    expect(normalizeFeishuMarkdown(normalized, cwd, resolver)).toBe(normalized);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["report.md:12:3", ":12:3", "#L12"],
    ["outputs/report.md#L12C3-L20", ":12", "#L12"],
    ["outputs/report.md#研究结论", undefined, "#%E7%A0%94%E7%A9%B6%E7%BB%93%E8%AE%BA"],
  ])("preserves relative report line references and fragments: %s", (target, reference, hash) => {
    const resolver = vi.fn((_file: string, line?: string) =>
      'http://viewer.test/preview/signed?path=report' + (line ? '#L' + line.slice(1).split(':')[0] : ''));
    const normalized = normalizeFeishuMarkdown('[报告](' + target + ')', '/work/project', resolver);
    expect(resolver).toHaveBeenCalledExactlyOnceWith(
      '/work/project/' + (target.startsWith('outputs/') ? 'outputs/' : '') + 'report.md', reference,
    );
    expect(normalized).toContain('http://viewer.test/preview/signed?path=report' + hash);
  });

  test("renders missing relative files as text instead of leaving a broken web link", () => {
    const resolver = vi.fn(() => undefined);
    for (const label of ['查看研究报告', 'report.md', '']) {
      const normalized = normalizeFeishuMarkdown('[' + label + '](outputs/report.md)', '/work/project', resolver);
      expect(normalized).toContain('report.md');
      expect(normalized).not.toContain('](');
    }
    expect(normalizeFeishuMarkdown('[报告](outputs/report.md)', '/work/project')).not.toContain('](');
  });

  test.each([undefined, '', 'relative/project'])('does not resolve against the process directory when the project is %s', (cwd) => {
    const resolver = vi.fn(() => 'http://viewer.test/preview/signed');
    const markdown = '[报告](outputs/report.md)';
    expect(normalizeFeishuMarkdown(markdown, cwd, resolver)).toBe(markdown);
    expect(resolver).not.toHaveBeenCalled();
  });

  test.each([
    'https://example.com/report.md', 'http://outputs/report.md', '//example.com/report.md',
    'mailto:user@example.com', 'vscode:42', '#section', '?page=2', 'javascript:alert(1)',
    'outputs/bad%ZZ.md', 'outputs/bad%00.md', 'outputs/preview.png', 'outputs/preview.png#image',
  ])('does not reinterpret non-file, invalid, or image targets: %s', (target) => {
    const resolver = vi.fn(() => 'http://viewer.test/preview/signed');
    const markdown = '[Link](' + target + ')';
    expect(normalizeFeishuMarkdown(markdown, '/work/project', resolver)).toBe(markdown);
    expect(resolver).not.toHaveBeenCalled();
  });

  test("leaves relative images and code untouched while converting links outside inline code", () => {
    const resolver = vi.fn(() => 'http://viewer.test/preview/signed');
    const code = '[Code](outputs/report.md)';
    const markdown = [
      '![Image](outputs/diagram.png)',
      '`' + code + '` [Report](outputs/report.md)',
      '``' + code + ' with ` delimiter``',
      '```markdown', code, '```',
    ].join('\n');
    const normalized = normalizeFeishuMarkdown(markdown, '/work/project', resolver);
    expect(normalized).toContain('![Image](outputs/diagram.png)');
    expect(normalized).toContain('`' + code + '`');
    expect(normalized).toContain('``' + code + ' with ` delimiter``');
    expect(normalized).toContain('```markdown\n' + code + '\n```');
    expect(normalized).toContain('[Report](http://viewer.test/preview/signed)');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

});
