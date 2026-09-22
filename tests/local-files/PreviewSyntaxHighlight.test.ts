/// <reference lib="dom" />
import { parseHTML } from "linkedom";
import hljs from "highlight.js/lib/common";
import { afterEach, describe, expect, test, vi } from "vitest";
import { highlightPreviewCode, MAX_PREVIEW_HIGHLIGHT_BYTES } from "../../src/local-files/PreviewSyntaxHighlight.js";
import { renderTurnPreviewPage, renderTurnPreviewSnapshot } from "../../src/local-files/TurnPreviewPage.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

function state(text: string): TurnViewState {
  return { sessionId: "s", turnId: "t", startedAt: 1, status: "completed", prompt: text,
    assistantText: "", finalResponse: text, plan: [], completedTools: [], failedTools: [], fileSummary: [],
    activities: [{ id: "commentary:1", kind: "assistant", text }] };
}
function fence(language: string, code: string): string { return `\`\`\`${language}\n${code}\n\`\`\``; }
function content(text: string) {
  return parseHTML(`<main>${renderTurnPreviewSnapshot(state(text)).content}</main>`).document;
}
afterEach(() => vi.restoreAllMocks());

describe("Turn Preview syntax highlighting", () => {
  test.each([
    ["javascript", 'const message = "hello";'], ["js", 'console.log("hello");'],
    ["jsx", 'const view = <div title="hello">World</div>;'],
    ["typescript", 'interface User { name: string; }'], ["TS", 'const count: number = 42;'],
    ["tsx", 'const view = <span>Hi</span>;'], ["python", 'def hello(name):\n    return "Hello " + name'],
    ["py", 'print("hello")'], ["bash", 'echo "$HOME"'], ["sh", 'echo "hello"'], ["zsh", 'echo "$USER"'],
    ["powershell", 'Get-Content "$HOME/test.txt"'], ["pwsh", '$value = "Hello"'], ["ps1", '$value = 123'],
    ["json", '{"enabled": true, "count": 12}'], ["yaml", 'enabled: true\ncount: 12'], ["yml", 'name: example'],
    ["sql", 'SELECT name FROM users WHERE active = true;'], ["html", '<div class="hello">World</div>'],
    ["xml", '<item id="1">value</item>'], ["css", '.item { color: red; }'],
    ["go", 'func main() { println("hello") }'], ["rust", 'fn main() { let value = 12; }'],
    ["java", 'public class Main { int count = 1; }'], ["c", '#include <stdio.h>\nint main() { return 0; }'],
    ["cpp", 'class Example { public: int value = 1; };'], ["csharp", 'public class Example { string Name = "hi"; }'],
    ["kotlin", 'fun main() { val name = "hi" }'], ["swift", 'let message = "Hello"'],
    ["dockerfile", 'FROM node:22\nRUN npm install'], ["bat", '@echo off\necho Hello'],
    ["diff", '-removed\n+added'], ["toml", '[server]\nport = 1234'],
  ])("highlights %s in prompts, Commentary and answers while preserving exact code", (language, code) => {
    const document = content(fence(language, code));
    for (const selector of [".user.prompt", ".commentary", ".final-result"]) {
      const block = document.querySelector(`${selector} pre code`)!;
      expect(block).not.toBeNull();
      expect(block.textContent).toBe(code + "\n");
      expect(block.querySelector('[class^="hljs-"]')).not.toBeNull();
    }
  });

  test.each(["", "text", "plaintext", "unknown-language", 'unknown" onclick="alert(1)', "constructor", "__proto__"])("keeps %s safe and plain", (language) => {
    const code = '<script>alert("unsafe")</script>\n  & value';
    const block = content(fence(language, code)).querySelector("pre code")!;
    expect(block.textContent).toBe(code + "\n");
    expect(block.querySelector("script,[onclick],span")).toBeNull();
  });

  test("escapes HTML in supported languages and leaves inline code, indented code and diagrams alone", () => {
    const text = [fence("html", '<img src=x onerror="evil()"><script>alert(1)</script>'),
      '`const x = "hi"`', '    const indented = 1;', fence("mermaid", "flowchart LR\nA --> B")].join("\n\n");
    const document = content(text);
    expect(document.querySelector(".user.prompt .markdown > p > code")!.textContent).toBe('const x = "hi"');
    expect(document.querySelector(".user.prompt code:not([class]) span")).toBeNull();
    expect(document.querySelector("img,script,[onerror]")).toBeNull();
    expect(document.querySelector(".diagram-source code")!.textContent).toBe("flowchart LR\nA --> B\n");
    expect(document.querySelector(".diagram-source span")).toBeNull();
  });

  test("limits highlighting by UTF-8 bytes without truncating source", () => {
    const code = `const text = "${"汉".repeat(MAX_PREVIEW_HIGHLIGHT_BYTES / 2)}";\nEND`;
    const highlight = vi.spyOn(hljs, "highlight");
    const block = content(fence("js", code)).querySelector("pre code")!;
    expect(block.textContent).toBe(code + "\n");
    expect(block.querySelector("span")).toBeNull();
    expect(highlight).not.toHaveBeenCalled();
  });

  test("falls back to escaped source on highlighter failure", () => {
    vi.spyOn(hljs, "highlight").mockImplementation(() => { throw new Error("Parser failed"); });
    const code = 'const syntax_failure_123 = "<unsafe>";';
    const block = content(fence("js", code)).querySelector("pre code")!;
    expect(block.textContent).toBe(code + "\n");
    expect(block.querySelector("unsafe,span")).toBeNull();
  });

  test("caches unchanged SSE code while bounding retained entries", () => {
    const code = 'const unique_cache_check = "ok";';
    const highlight = vi.spyOn(hljs, "highlight");
    const initial = state(fence("js", code));
    renderTurnPreviewSnapshot(initial);
    renderTurnPreviewSnapshot({ ...initial, model: "another-model" });
    expect(highlight).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 33; index++) highlightPreviewCode(`const eviction_${index} = 1;`, "js");
    const calls = highlight.mock.calls.length;
    renderTurnPreviewSnapshot(initial);
    expect(highlight).toHaveBeenCalledTimes(calls + 1);
  });

  test("includes scoped light/dark colors without changing tool backgrounds or weights", () => {
    const html = renderTurnPreviewPage({ state: state(fence("js", "const x = 1;")), eventsUrl: "/events", scriptPath: "/client.js" });
    expect(html).toContain(".markdown pre .hljs-keyword");
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain("--syntax-keyword:#ff7b72");
    expect(html).toContain(".tool-content pre { max-width: none; max-height: none; padding: 0; overflow: visible; background: transparent; }");
  });
});
