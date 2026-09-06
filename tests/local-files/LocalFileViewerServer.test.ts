import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";

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
    expect(script).toContain('viewSwitch.hidden = update.viewMode !== "markdown"');
  });

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
});

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-file-viewer-"));
  temporaryDirectories.push(directory);
  return directory;
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
