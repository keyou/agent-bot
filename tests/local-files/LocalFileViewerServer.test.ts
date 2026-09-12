import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

const temporaryDirectories: string[] = [];
const servers: LocalFileViewerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalFileViewerServer", () => {
  test("serves signed text previews with stable line anchors and raw content", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "example.ts");
    fs.writeFileSync(filePath, "const value = '<safe>';\nconsole.log(value);\n", "utf8");
    const server = await startServer(directory);

    const fileUrl = server.createFileUrl(filePath, ":2:4");
    expect(fileUrl).toBeDefined();
    expect(fileUrl).toContain("#L2");
    const parsedFileUrl = new URL(fileUrl!);
    expect(parsedFileUrl.pathname).toMatch(/^\/preview\/[A-Za-z0-9_-]{16}$/u);
    expect(parsedFileUrl.searchParams.get("path")).toBe(filePath.replaceAll("\\", "/"));
    expect(parsedFileUrl.searchParams.has("token")).toBe(false);
    expect(parsedFileUrl.searchParams.has("sig")).toBe(false);

    const pageResponse = await fetch(fileUrl!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("example.ts");
    expect(page).toContain(`<h1 id="viewer-title" data-file-path="${filePath}">${filePath}</h1>`);
    expect(page).toContain("main { padding: 0; }");
    expect(page).toContain("scroll-margin-top: var(--viewer-header-offset)");
    expect(page).toContain('--viewer-code-font: "Cascadia Mono", "JetBrains Mono"');
    expect(page).toContain(".code, .code code, .code .line, .code .line * { font-family: var(--viewer-code-font) !important;");
    expect(page).toContain("font-variant-ligatures: none");
    expect(page).toContain(".line:target, .line.is-target-line");
    expect(page).toContain("id=\"L2\"");
    expect(page).toContain('<span class="hljs-keyword">const</span>');
    expect(page).toContain("&lt;safe&gt;");
    expect(page).not.toContain("const value = '<safe>'");

    const rawLink = /href="([^"]+)">打开原始文件/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(rawLink).toBeDefined();
    expect(rawLink).toContain(`?path=${encodeURIComponent(filePath.replaceAll("\\", "/"))
      .replaceAll("%3A", ":")
      .replaceAll("%2F", "/")}&raw=1`);
    const rawResponse = await fetch(rawLink!);
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toBe("const value = '<safe>';\nconsole.log(value);\n");
  });

  test("keeps multiline syntax spans valid across anchored lines", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "multiline.ts");
    fs.writeFileSync(filePath, "/* first line\nsecond line */\nconst ready = true;\n", "utf8");
    const server = await startServer(directory);

    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page).toMatch(/id="L1"[^]*<span class="hljs-comment">\/\* first line<\/span><\/span>/u);
    expect(page).toMatch(/id="L2"[^]*<span class="hljs-comment">second line \*\/<\/span><\/span>/u);
    expect(page).toContain('<code class="language-typescript">');
  });

  test("renders Markdown by default and keeps a code view with line anchors", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "README.md");
    fs.writeFileSync(filePath, [
      "# Agent Bot",
      "",
      "Use **Markdown** safely.",
      "",
      "```ts",
      "const ready = true;",
      "```",
      "",
      "<script>alert('unsafe')</script>",
      "",
    ].join("\n"), "utf8");
    const server = await startServer(directory);

    const fileUrl = server.createFileUrl(filePath)!;
    const page = await (await fetch(fileUrl)).text();
    expect(page).toContain('<body data-view-mode="rendered"');
    expect(page).toContain('id="viewer-view-switch"');
    expect(page).toContain('data-view-mode-button="rendered">预览</button>');
    expect(page).toContain('data-view-mode-button="code">代码</button>');
    expect(page).toContain('<article class="markdown-body" data-view-panel="rendered"><h1>Agent Bot</h1>');
    expect(page).toContain("Use <strong>Markdown</strong> safely.");
    expect(page).toContain('<pre class="markdown-code-block hljs"><code class="language-ts">');
    expect(page).toContain('&lt;script&gt;alert(\'unsafe\')&lt;/script&gt;');
    expect(page).not.toContain("<script>alert('unsafe')</script>");
    expect(page).toContain('<section data-view-panel="code"><pre class="code hljs">');
    expect(page).toContain('id="L1"');

    const script = await (await fetch(new URL("/assets/viewer.js", fileUrl))).text();
    expect(script).toContain('document.body.dataset.viewMode === "code" ? "code" : "rendered"');
    expect(script).toContain('button.addEventListener("click"');
    expect(script).toContain('document.body.dataset.viewMode = mode === "code" ? "code" : "rendered"');
    expect(script).toContain('if (/^#L\\d+$/u.test(window.location.hash)) document.body.dataset.viewMode = "code"');
    expect(script).toContain('viewSwitch.hidden = update.viewMode !== "markdown" && update.viewMode !== "html"');
  });

  test.each([".html", ".htm", ".HTML"])("previews %s in a sandbox while retaining source and raw downloads", async (extension) => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, `report & notes${extension}`);
    const source = '<!doctype html>\n<style>body { color: green; }</style>\n<h1>Report</h1>\n<script>document.body.dataset.ready = "yes";</script>';
    fs.writeFileSync(filePath, source, "utf8");
    const server = await startServer(directory);
    const response = await fetch(server.createFileUrl(filePath, ":3")!);
    const page = await response.text();
    expect(page).toContain('<body data-view-mode="rendered"');
    expect(page).toContain('id="viewer-view-switch"');
    expect(page).toContain('data-view-mode-button="code">代码</button>');
    expect(page).toContain('sandbox="allow-scripts" referrerpolicy="no-referrer"');
    expect(page).not.toContain("allow-same-origin");
    expect(page).not.toContain('<script>document.body.dataset.ready = "yes";</script>');
    expect(page).toContain('<section data-view-panel="code"><pre class="code hljs">');
    expect(page).toContain('id="L3"');
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");

    const renderUrl = htmlFrameUrl(page);
    expect(new URL(renderUrl).searchParams.get("render")).toBe("html");
    const rendered = await fetch(renderUrl);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe(source);
    expect(rendered.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const policy = rendered.headers.get("content-security-policy");
    expect(policy).toContain("sandbox allow-scripts;");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("allow-same-origin");
    const head = await fetch(renderUrl, { method: "HEAD" });
    expect(head.headers.get("content-security-policy")).toBe(policy);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(source)));
    expect(await head.text()).toBe("");

    const rawUrl = new URL(renderUrl);
    rawUrl.searchParams.delete("render");
    rawUrl.searchParams.set("raw", "1");
    rawUrl.searchParams.set("download", "1");
    const raw = await fetch(rawUrl);
    expect(await raw.text()).toBe(source);
    expect(raw.headers.get("content-disposition")).toContain("attachment;");
    expect(raw.headers.get("content-security-policy")).not.toContain("script-src 'unsafe-inline'");

    const tampered = new URL(renderUrl);
    tampered.searchParams.set("path", path.join(directory, "secret.html"));
    expect((await fetch(tampered)).status).toBe(403);
  });

  test("keeps full HTML rendering separate from the truncated source preview", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "large.html");
    const source = `<!doctype html><body>${" ".repeat(2 * 1024 * 1024)}<p>Full document tail</p></body>`;
    fs.writeFileSync(filePath, source, "utf8");
    const server = await startServer(directory);
    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page).toContain('<section data-view-panel="code"><div class="notice">');
    expect(page).not.toContain("Full document tail");
    expect(await (await fetch(htmlFrameUrl(page))).text()).toBe(source);
  });

  test("preserves the encoding of HTML documents", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "encoded.html");
    const source = Buffer.from('\ufeff<!doctype html><h1>中文报告</h1>', "utf16le");
    fs.writeFileSync(filePath, source);
    const server = await startServer(directory);
    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page).toContain("中文报告");
    const rendered = await fetch(htmlFrameUrl(page));
    expect(rendered.headers.get("content-type")).toBe("text/html; charset=utf-16le");
    expect(Buffer.from(await rendered.arrayBuffer())).toEqual(source);
  });

  test.each([
    ["report.txt", Buffer.from("<h1>Not HTML</h1>")],
    ["binary.html", Buffer.from([0, 1, 2, 3, 4, 5])],
  ])("does not enable HTML rendering for %s", async (fileName, source) => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, source);
    const server = await startServer(directory);
    const url = new URL(server.createFileUrl(filePath)!);
    expect(await (await fetch(url)).text()).not.toContain('<iframe class="html-preview"');
    url.searchParams.set("render", "html");
    const response = await fetch(url);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).not.toContain("script-src 'unsafe-inline'");
  });

  test("streams updated HTML frame URLs and source without leaving preview mode", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "live.html");
    fs.writeFileSync(filePath, "<h1>First</h1>", "utf8");
    const server = await startServer(directory);
    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    const eventsUrl = /data-events-url="([^"]+)"/u.exec(page)![1]!.replaceAll("&amp;", "&");
    const controller = new AbortController();
    try {
      const events = createServerSentEventReader(await fetch(eventsUrl, { signal: controller.signal }));
      const initial = JSON.parse(await events.next("update"));
      expect(initial.viewMode).toBe("html");
      expect(htmlFrameUrl(initial.content)).toBe(htmlFrameUrl(page));
      fs.writeFileSync(filePath, "<h1>Updated report</h1>", "utf8");
      const update = JSON.parse(await events.next("update"));
      expect(update.viewMode).toBe("html");
      expect(update.content).toContain('data-view-panel="code"');
      expect(update.content).toContain("Updated report");
      expect(htmlFrameUrl(update.content)).not.toBe(htmlFrameUrl(initial.content));
      expect(await (await fetch(htmlFrameUrl(update.content))).text()).toBe("<h1>Updated report</h1>");
    } finally {
      controller.abort();
    }
  }, 10_000);

  test("wraps Markdown tables in scroll regions without squeezing cells or changing alignment", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "progress.md");
    fs.writeFileSync(filePath, [
      "| Case | Batch/backend | N | Completed/timeout | Mean/median | Calls | Input/output Token | Uncached |",
      "|---|---|---:|---:|---:|---:|---:|---:|",
      "| B05 | previous-online/aha | 4 | 4/0 | 370.1/379.8 | 32.8 | 2,115,023/18,382 | 67,041 |",
      "",
      "| Details | Status |",
      "|---|:---:|",
      "| **Ready** `<safe>` | [Trace](https://example.com/trace) |",
      "",
    ].join("\n"), "utf8");
    const server = await startServer(directory);

    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page.match(/class="markdown-table-scroll"/gu)).toHaveLength(2);
    expect(page.match(/<\/table><\/div>/gu)).toHaveLength(2);
    expect(page).toContain('role="region" aria-label="Markdown 表格" tabindex="0"><table>');
    expect(page).toContain('<td style="text-align:right">2,115,023/18,382</td>');
    expect(page).toContain('<td style="text-align:center"><a href="https://example.com/trace">Trace</a></td>');
    expect(page).toContain("<strong>Ready</strong> <code>&lt;safe&gt;</code>");
    expect(page).toContain(".markdown-table-scroll { max-width: 100%; margin: 0 0 1em; overflow-x: auto; }");
    expect(page).toContain("width: max-content; margin: 0; border-collapse: collapse; white-space: nowrap; overflow-wrap: normal; word-break: normal;");
    expect(page).not.toContain("table { display: block; max-width: 100%");
  });

  test("streams scrollable Markdown tables with independent horizontal position restoration", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "live.md");
    fs.writeFileSync(filePath, "| Case | Result |\n|---|---|\n| B05 | running |\n", "utf8");
    const server = await startServer(directory);
    const fileUrl = server.createFileUrl(filePath)!;
    const page = await (await fetch(fileUrl)).text();
    const eventsLink = /data-events-url="([^"]+)"/u.exec(page)![1]!.replaceAll("&amp;", "&");
    const script = await (await fetch(new URL("/assets/viewer.js", fileUrl))).text();
    expect(script).toContain('Array.from(content.querySelectorAll(".markdown-table-scroll"), (table) => table.scrollLeft)');
    expect(script).toContain("table.scrollLeft = tableScrollLeft[index] ?? 0");
    expect(script).toContain("restoreScroll(top, left, atBottom, codeScrollLeft, tableScrollLeft)");

    const controller = new AbortController();
    try {
      const events = createServerSentEventReader(await fetch(eventsLink, { signal: controller.signal }));
      const initial = JSON.parse(await events.next("update"));
      expect(initial.viewMode).toBe("markdown");
      expect(initial.content).toContain('class="markdown-table-scroll"');
      expect(initial.content).toContain("<td>running</td>");
      fs.appendFileSync(filePath, "| B08 | completed |\n", "utf8");
      const update = JSON.parse(await events.next("update"));
      expect(update.content).toContain('class="markdown-table-scroll"');
      expect(update.content).toContain("<td>completed</td>");
      expect(update.content).toContain('<section data-view-panel="code">');
    } finally {
      controller.abort();
    }
  }, 10_000);

  test("opens relative, absolute, file-URL, reference-style, and directory links from rendered Markdown", async () => {
    const directory = createTemporaryDirectory();
    const docs = path.join(directory, "docs");
    const nested = path.join(docs, "nested");
    fs.mkdirSync(nested, { recursive: true });
    const child = path.join(nested, "报告 (final).md");
    const outside = path.join(directory, "outside.txt");
    fs.writeFileSync(child, "# Child report\n", "utf8");
    fs.writeFileSync(outside, "first\nsecond\nthird\n", "utf8");
    const filePath = path.join(docs, "index.md");
    const childRelative = "nested/" + encodeURIComponent(path.basename(child));
    const source = [
      `[**Child**](${childRelative} "Report title")`,
      "[Parent](../outside.txt:2:4)",
      `[Absolute](<${outside.replaceAll("\\", "/")}>)`,
      `[File URL](${pathToFileURL(outside).href}#L3-L4)`,
      "[Directory](nested/)",
      "[Reference][report]",
      "",
      `[report]: ${childRelative}`,
      "",
      `\`[Example](${childRelative})\``,
      "```markdown",
      `[Sample](${childRelative})`,
      "```",
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");
    const server = await startServer(path.join(directory, "state"));
    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    const childHref = server.createFileUrl(child)!.replaceAll("&", "&amp;");
    expect(page).toContain(`<a href="${childHref}" title="Report title"><strong>Child</strong></a>`);
    expect(page).toContain(`<a href="${childHref}">Reference</a>`);
    expect(page).toContain(`<a href="${server.createFileUrl(outside, ":2")!.replaceAll("&", "&amp;")}">Parent</a>`);
    expect(page).toContain(`<a href="${server.createFileUrl(outside)!.replaceAll("&", "&amp;")}">Absolute</a>`);
    expect(page).toContain(`<a href="${server.createFileUrl(outside, ":3")!.replaceAll("&", "&amp;")}">File URL</a>`);
    expect(page).toContain(`<a href="${server.createFileUrl(nested)!.replaceAll("&", "&amp;")}">Directory</a>`);
    expect(page).toContain(`<code>[Example](${childRelative})</code>`);
    const childPage = await (await fetch(server.createFileUrl(child)!)).text();
    expect(childPage).toContain("<h1>Child report</h1>");
    expect(await (await fetch(server.createFileUrl(nested)!)).text()).toContain(path.basename(child));
    const original = new URL(server.createFileUrl(filePath)!);
    original.searchParams.set("raw", "1");
    expect(await (await fetch(original)).text()).toBe(source);
  });

  test("loads local Markdown images from signed raw URLs and handles missing linked files", async () => {
    const directory = createTemporaryDirectory();
    const imagePath = path.join(directory, "sample.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(imagePath, png);
    const filePath = path.join(directory, "index.md");
    fs.writeFileSync(filePath, "![Sample](sample.png)\n[Missing](missing.md)\n", "utf8");
    const server = await startServer(path.join(directory, "state"));
    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    const imageLink = /<img src="([^"]+)" alt="Sample"/u.exec(page)![1]!.replaceAll("&amp;", "&");
    const raw = await fetch(imageLink);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(png);
    const missingLink = /<a href="([^"]+)">Missing<\/a>/u.exec(page)![1]!.replaceAll("&amp;", "&");
    const missing = await fetch(missingLink);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("文件不存在");
    const tampered = new URL(missingLink);
    tampered.searchParams.set("path", filePath);
    expect((await fetch(tampered)).status).toBe(403);
  });

  test("converts Markdown links on live updates using each document's directory", async () => {
    const directory = createTemporaryDirectory();
    const child = path.join(directory, "child.txt");
    fs.writeFileSync(child, "child\n", "utf8");
    const filePath = path.join(directory, "index.md");
    fs.writeFileSync(filePath, "# Live\n", "utf8");
    const server = await startServer(path.join(directory, "state"));
    const fileUrl = server.createFileUrl(filePath)!;
    const page = await (await fetch(fileUrl)).text();
    const eventsUrl = /data-events-url="([^"]+)"/u.exec(page)![1]!.replaceAll("&amp;", "&");
    const controller = new AbortController();
    try {
      const events = createServerSentEventReader(await fetch(eventsUrl, { signal: controller.signal }));
      expect(JSON.parse(await events.next("update")).content).toContain("Live");
      fs.appendFileSync(filePath, "\n[Child](child.txt#L1)\n", "utf8");
      const update = JSON.parse(await events.next("update"));
      expect(update.content).toContain(`<a href="${server.createFileUrl(child, ":1")!.replaceAll("&", "&amp;")}">Child</a>`);
    } finally {
      controller.abort();
    }
  }, 10_000);

  test("resumes live file updates after deletion and recreation", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "live.md");
    fs.writeFileSync(filePath, "# Original\n", "utf8");
    const server = await startServer(path.join(directory, "state"));
    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    const eventsUrl = /data-events-url="([^"]+)"/u.exec(page)![1]!.replaceAll("&amp;", "&");
    const controller = new AbortController();
    try {
      const events = createServerSentEventReader(await fetch(eventsUrl, { signal: controller.signal }));
      expect(JSON.parse(await events.next("update")).content).toContain("Original");
      fs.unlinkSync(filePath);
      expect(JSON.parse(await events.next("unavailable")).message).toBeTypeOf("string");
      fs.writeFileSync(filePath, "# Restored\n", "utf8");
      expect(JSON.parse(await events.next("update")).content).toContain("Restored");
    } finally {
      controller.abort();
    }
  }, 10_000);

  test("keeps absolute paths readable while escaping query delimiters", async () => {
    const directory = createTemporaryDirectory();
    const nestedDirectory = path.join(directory, "folder & notes");
    fs.mkdirSync(nestedDirectory);
    const filePath = path.join(nestedDirectory, "example file.txt");
    fs.writeFileSync(filePath, "readable path\n", "utf8");
    const server = await startServer(directory);

    const fileUrl = new URL(server.createFileUrl(filePath)!);
    const readablePath = filePath.replaceAll("\\", "/");
    const encodedPath = encodeURIComponent(readablePath)
      .replaceAll("%3A", ":")
      .replaceAll("%2F", "/");
    expect(fileUrl.search).toBe(`?path=${encodedPath}`);
    expect(fileUrl.search).not.toContain("%5C");
    expect(fileUrl.searchParams.get("path")).toBe(readablePath);
    expect((await fetch(fileUrl)).status).toBe(200);
  });

  test("detects text from content instead of the file extension", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "extensionless-data.bin");
    fs.writeFileSync(filePath, "human-readable content\nsecond line\n", "utf8");
    const server = await startServer(directory);

    const pageResponse = await fetch(server.createFileUrl(filePath)!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("human-readable content");
    expect(page).toContain("id=\"L2\"");
    expect(page).not.toContain("该文件是二进制格式");
  });

  test("renders JSON Lines files as text", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "events.jsonl");
    fs.writeFileSync(filePath, '{"event":"started"}\n{"event":"completed"}\n', "utf8");
    const server = await startServer(directory);

    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page).toContain('<span class="hljs-attr">&quot;event&quot;</span>');
    expect(page).toContain('<span class="hljs-string">&quot;started&quot;</span>');
    expect(page).not.toContain("该文件是二进制格式");
  });

  test("streams file updates over SSE and restores the viewer scroll position", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "live.log");
    fs.writeFileSync(filePath, "first line\n", "utf8");
    const server = await startServer(directory);
    const fileUrl = server.createFileUrl(filePath)!;

    const pageResponse = await fetch(fileUrl);
    const page = await pageResponse.text();
    expect(pageResponse.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const eventsLink = /data-events-url="([^"]+)"/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    const scriptPath = /<script src="([^"]+)" defer><\/script>/u.exec(page)?.[1];
    expect(eventsLink).toBeDefined();
    expect(scriptPath).toBe("/assets/viewer.js");
    const script = await (await fetch(new URL(scriptPath!, fileUrl))).text();
    expect(script).toContain("const top = window.scrollY");
    expect(script).toContain("window.scrollTo(left, atBottom ? maxTop : Math.min(top, maxTop))");
    expect(script).toContain("code.scrollLeft = codeScrollLeft");
    expect(script).toContain("header.getBoundingClientRect().height");
    expect(script).toContain('target?.classList.add("is-target-line")');
    expect(script).toContain('title.textContent = lineNumber ? filePath + ":" + lineNumber : filePath');
    expect(script).toContain('title.addEventListener("pointerdown"');
    expect(script).toContain("range.selectNodeContents(title)");
    expect(script).toContain("highlightHashTarget();");
    expect(script).toContain('scrollIntoView({ block: "start" })');

    const controller = new AbortController();
    try {
      const eventResponse = await fetch(eventsLink!, { signal: controller.signal });
      expect(eventResponse.status).toBe(200);
      expect(eventResponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      const events = createServerSentEventReader(eventResponse);
      const initial = await events.next("update");
      expect(JSON.parse(initial).content).toContain("first line");

      fs.appendFileSync(filePath, "second line\n", "utf8");
      const update = await events.next("update");
      expect(JSON.parse(update).content).toContain("second line");
    } finally {
      controller.abort();
    }
  }, 10_000);

  test("does not decode binary content as text even when the extension looks textual", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "not-really-text.txt");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]));
    const server = await startServer(directory);

    const pageResponse = await fetch(server.createFileUrl(filePath)!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("该文件是二进制格式");
    expect(page).not.toContain("class=\"code\"");

    const rawLink = /href="([^"]+)">打开原始文件/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    const rawResponse = await fetch(rawLink!);
    expect(rawResponse.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("detects and decodes UTF-16 text from its byte-order mark", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "utf16.data");
    fs.writeFileSync(filePath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Agent Bot 文本\n", "utf16le"),
    ]));
    const server = await startServer(directory);

    const page = await (await fetch(server.createFileUrl(filePath)!)).text();
    expect(page).toContain("Agent Bot 文本");
    expect(page).not.toContain("该文件是二进制格式");
  });

  test("lists signed directory contents and opens nested paths", async () => {
    const directory = createTemporaryDirectory();
    const childDirectory = path.join(directory, "child");
    fs.mkdirSync(childDirectory);
    fs.writeFileSync(path.join(directory, "notes.data"), "directory text\n", "utf8");
    fs.writeFileSync(path.join(childDirectory, "nested.txt"), "nested content\n", "utf8");
    const server = await startServer(path.join(directory, ".viewer-state"));

    const directoryUrl = server.createFileUrl(directory);
    expect(directoryUrl).toBeDefined();
    const pageResponse = await fetch(directoryUrl!);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("📁 child");
    expect(page).toContain("📄 notes.data");
    expect(page).not.toContain("打开原始文件");
    expect(page).not.toContain(">..</");

    const childLink = /<a class="directory-entry" href="([^"]+)"><span class="entry-name">📁 child<\/span>/u
      .exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(childLink).toBeDefined();
    const childPage = await (await fetch(childLink!)).text();
    expect(childPage).toContain("nested.txt");
  });

  test("rejects modified short tokens and files that no longer exist", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "notes.md");
    fs.writeFileSync(filePath, "# Notes\n", "utf8");
    const server = await startServer(directory);
    const fileUrl = new URL(server.createFileUrl(filePath)!);

    fileUrl.pathname = `/preview/${"0".repeat(16)}`;
    expect((await fetch(fileUrl)).status).toBe(403);

    const validUrl = server.createFileUrl(filePath)!;
    const modifiedPathUrl = new URL(validUrl);
    modifiedPathUrl.searchParams.set("path", path.join(directory, "other.md"));
    expect((await fetch(modifiedPathUrl)).status).toBe(403);

    fs.rmSync(filePath);
    expect((await fetch(validUrl)).status).toBe(404);
  });

  test("keeps legacy signed links readable", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "legacy.txt");
    fs.writeFileSync(filePath, "legacy content\n", "utf8");
    const server = await startServer(directory);
    const address = await server.start();
    const legacyToken = Buffer.from(filePath, "utf8").toString("base64url");
    const secret = Buffer.from(fs.readFileSync(path.join(directory, "secret"), "utf8").trim(), "hex");
    const signature = createHmac("sha256", secret).update(legacyToken).digest("hex");
    const legacyUrl = `${address.publicBaseUrl}/view/${legacyToken}?sig=${signature}`;

    const response = await fetch(legacyUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("legacy content");
  });

  test("persists an automatically selected port for the Profile", async () => {
    const directory = createTemporaryDirectory();
    const filePath = path.join(directory, "persistent-link.txt");
    fs.writeFileSync(filePath, "persistent link\n", "utf8");
    const first = await startServer(directory);
    const firstAddress = await first.start();
    const persistentUrl = first.createFileUrl(filePath)!;
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await startServer(directory);
    const secondAddress = await second.start();
    expect(secondAddress.port).toBe(firstAddress.port);
    expect((await fetch(persistentUrl)).status).toBe(200);
    expect(fs.readFileSync(path.join(directory, "port"), "utf8").trim()).toBe(String(firstAddress.port));
  });

  test("serves signed live Turn previews from persisted presentation snapshots", async () => {
    const directory = createTemporaryDirectory();
    const changedFile = "changed & reviewed.ts";
    fs.writeFileSync(path.join(directory, changedFile), "export const previewChange = 1;\n");
    const imagePath = path.join(directory, "auth image.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(imagePath, png);
    let snapshot: TurnViewState = {
      sessionId: "session_1",
      turnId: "turn_1",
      projectCwd: directory,
      prompt: "检查 <preview> & SSE\n![Prompt](auth%20image.png)",
      status: "running",
      startedAt: Date.now() - 2_000,
      assistantText: "",
      plan: [{ text: "读取代码", status: "in_progress" }],
      activities: [{ kind: "assistant", id: "commentary:1", text: "正在检查入口。" }],
      totalToolCount: 0,
      completedTools: [],
      failedTools: [],
      fileSummary: [{ path: changedFile, additions: 1 }],
    };
    const server = new LocalFileViewerServer({
      host: "127.0.0.1",
      port: 0,
      stateDirectory: directory,
      getTurnSnapshot: (turnId) => turnId === snapshot.turnId ? snapshot : undefined,
      turnPreviewPollIntervalMs: 20,
    });
    servers.push(server);
    await server.start();

    const previewUrl = server.createTurnPreviewUrl("turn_1");
    expect(previewUrl).toBeDefined();
    const pageResponse = await fetch(previewUrl!, { headers: { "Accept-Language": "zh-CN" } });
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(page).toContain("检查 &lt;preview&gt; &amp; SSE");
    expect(page).toContain("正在检查入口。");
    expect(page).toContain("实时更新");
    expect(page).not.toContain("检查 <preview> & SSE");
    const fileUrl = /class="file-link" href="([^"]+)"/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(fileUrl).toBe(server.createFileUrl(path.join(directory, changedFile)));
    const fileResponse = await fetch(fileUrl!);
    expect(fileResponse.status).toBe(200);
    expect(await fileResponse.text()).toContain("previewChange");
    const imageUrl = /<img src="([^"]+)" alt="Prompt"/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(imageUrl).toBeDefined();
    const imageResponse = await fetch(imageUrl!);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(png);

    const eventsUrl = /data-events-url="([^"]+)"/u.exec(page)?.[1]?.replaceAll("&amp;", "&");
    expect(eventsUrl).toBeDefined();
    const controller = new AbortController();
    try {
      const events = createServerSentEventReader(await fetch(eventsUrl!, {
        signal: controller.signal,
        headers: { "Accept-Language": "zh-CN" },
      }));
      const initial = JSON.parse(await events.next("update")) as { content: string; terminal: boolean };
      expect(initial.content).toContain("正在检查入口。");
      expect(initial.terminal).toBe(false);
      expect(initial.content).toContain(`src="${imageUrl!.replaceAll("&", "&amp;")}"`);

      snapshot = {
        ...snapshot,
        status: "completed",
        completedAt: Date.now(),
        durationMs: 2_500,
        finalResponse: `完成 **Preview**。\n![QR](<${imagePath.replaceAll("\\", "/")}>)`,
        activities: [
          ...snapshot.activities,
          {
            kind: "tool",
            id: "tool_1",
            tool: {
              id: "tool_1",
              title: "npm test",
              kind: "command",
              status: "completed",
              command: "/bin/zsh -lc 'npm test'",
              output: "all passed",
              files: [{ path: changedFile, additions: 1 }],
              startedAt: Date.now() - 1_500,
              completedAt: Date.now(),
            },
          },
        ],
        totalToolCount: 1,
        completedToolCount: 1,
      };
      const update = JSON.parse(await events.next("update")) as { content: string; terminal: boolean };
      expect(update.content).toContain("npm test");
      expect(update.content).toContain("all passed");
      expect(update.content).not.toContain("/bin/zsh -lc");
      expect(update.content).toContain("耗时 00:01");
      expect(update.content).toContain("完成 <strong>Preview</strong>。");
      const updatedImageUrl = /<img src="([^"]+)" alt="QR"/u.exec(update.content)?.[1]?.replaceAll("&amp;", "&");
      expect(updatedImageUrl).toBe(imageUrl);
      expect(Buffer.from(await (await fetch(updatedImageUrl!)).arrayBuffer())).toEqual(png);
      expect(update.terminal).toBe(true);
      expect(update.content.match(/class="file-link"/gu)).toHaveLength(2);
      expect(update.content).toContain(`href="${fileUrl!.replaceAll("&", "&amp;")}"`);
    } finally {
      controller.abort();
    }

    const tampered = new URL(previewUrl!);
    tampered.searchParams.set("turn", "turn_2");
    expect((await fetch(tampered)).status).toBe(403);
    expect(server.createTurnPreviewUrl("\0invalid")).toBeUndefined();
  }, 10_000);
});

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-file-viewer-"));
  temporaryDirectories.push(directory);
  return directory;
}

function htmlFrameUrl(page: string): string {
  const url = /<iframe class="html-preview"[^>]+src="([^"]+)"/u.exec(page)?.[1];
  expect(url).toBeDefined();
  return url!.replaceAll("&amp;", "&");
}

async function startServer(stateDirectory: string): Promise<LocalFileViewerServer> {
  const server = new LocalFileViewerServer({
    host: "127.0.0.1",
    port: 0,
    stateDirectory,
  });
  servers.push(server);
  await server.start();
  return server;
}

function createServerSentEventReader(response: Response): { next: (event: string) => Promise<string> } {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(expectedEvent: string): Promise<string> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const event = /^event: (.+)$/mu.exec(block)?.[1];
          if (event !== expectedEvent) continue;
          return block.split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
        }
        const { done, value } = await reader.read();
        if (done) throw new Error(`SSE stream ended before ${expectedEvent}.`);
        buffered += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      }
    },
  };
}
