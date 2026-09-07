import path from "node:path";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import { describe, expect, test, vi } from "vitest";
import { isFileUrl, rewriteMarkdownFileLinks } from "../../src/local-files/MarkdownFileLinks.js";

function fixture(markdown: string, source = path.resolve("docs", "index.md")) {
  const renderer = new MarkdownIt({ html: false, linkify: true });
  const validate = renderer.validateLink.bind(renderer);
  renderer.validateLink = (url) => isFileUrl(url) || validate(url);
  const createUrl = vi.fn((filePath: string) => {
    const url = new URL("https://viewer.example/base/preview/token");
    url.searchParams.set("path", filePath);
    return url;
  });
  const environment = {};
  const tokens = renderer.parse(markdown, environment);
  rewriteMarkdownFileLinks(tokens, source, createUrl);
  return { html: renderer.renderer.render(tokens, renderer.options, environment), createUrl };
}

describe("Markdown file links", () => {
  test.each([
    "https://example.com:443/report.md#L2",
    "http://localhost:1234/preview/token?path=/tmp/report.md",
    "//example.com/report.md",
    "mailto:123",
    "vscode:42",
    "#section",
    "#L2",
    "?page=2",
  ])("preserves non-file links: %s", (target) => {
    const { html, createUrl } = fixture(`[Link](${target})`);
    expect(html).toContain(`<a href="${target}">Link</a>`);
    expect(createUrl).not.toHaveBeenCalled();
  });

  test("decodes escaped filenames exactly once and preserves heading fragments", () => {
    const source = path.resolve("docs with spaces", "index.md");
    const { html, createUrl } = fixture("[Link](notes%20%2520%23%3F.md#heading)", source);
    expect(createUrl).toHaveBeenCalledWith(path.join(path.dirname(source), "notes %20#?.md"));
    expect(html).toContain("#heading");
  });

  test("does not interpret numbers in a fragment or query as a line suffix", () => {
    const { html, createUrl } = fixture("[Link](report.md?value=part:2#section:3)");
    expect(createUrl).toHaveBeenCalledWith(path.resolve("docs", "report.md"));
    expect(html).toContain('#section:3">Link</a>');
    expect(html).not.toContain("#L");
  });

  test.each(["child.ts:12:3", "./child.ts:12", "child.ts#L12", "child.ts#L12C4-L20C8"])("normalizes line references: %s", (target) => {
    const { html, createUrl } = fixture(`[Line](${target})`);
    expect(createUrl).toHaveBeenCalledWith(path.resolve("docs", "child.ts"));
    expect(html).toContain('#L12">Line</a>');
  });

  test("rewrites nested linked images and reference-style links, not inline or fenced code", () => {
    const { html, createUrl } = fixture([
      "[![Image](image.png)](report.md)", "", "[Report][ref]", "", "[ref]: report.md \"Title\"",
      "", "`[Code](report.md)`", "", "```", "[Code](report.md)", "```",
    ].join("\n"));
    expect(createUrl).toHaveBeenCalledTimes(3);
    expect(html).toContain('raw=1" alt="Image"');
    expect(html).toContain('title="Title">Report</a>');
    expect(html).toContain("<code>[Code](report.md)</code>");
    expect(html).toContain("<pre><code>[Code](report.md)\n</code></pre>");
  });

  test("converts file URLs without forwarding viewer control query parameters", () => {
    const target = pathToFileURL(path.resolve("report.md"));
    target.search = "?raw=1&path=/another-file&download=1";
    const { html, createUrl } = fixture(`[Report](${target.href})`);
    expect(createUrl).toHaveBeenCalledWith(path.resolve("report.md"));
    expect(html).not.toContain("file:");
    expect(html).not.toContain("raw=1");
    expect(html).not.toContain("download=1");
  });

  test.each(["javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,test", "java&#x73;cript:alert(1)"])("keeps dangerous links blocked: %s", (target) => {
    const { html, createUrl } = fixture(`[Unsafe](${target})`);
    expect(html).not.toContain("<a ");
    expect(createUrl).not.toHaveBeenCalled();
  });

  test.each(["file:///bad%00name", "file:///bad%ZZname", "file:///bad%2Fname"])("never emits invalid file URLs: %s", (target) => {
    const { html, createUrl } = fixture(`[Invalid](${target})`);
    expect(html).not.toContain('href="file:');
    expect(createUrl).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform !== "win32")("handles Windows drive and backslash paths", () => {
    for (const target of ["D:/project/report.md:7", "/D:/project/report.md:7", String.raw`D:\project\report.md:7`]) {
      const { html, createUrl } = fixture(`[Report](${target})`);
      expect(createUrl).toHaveBeenCalledWith("D:\\project\\report.md");
      expect(html).toContain('#L7">Report</a>');
    }
  });
});
