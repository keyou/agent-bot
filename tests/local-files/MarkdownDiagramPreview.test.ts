/// <reference lib="dom" />
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";

const directories: string[] = [];
const servers: LocalFileViewerServer[] = [];
const flow = "flowchart LR\nA[开始] --> B[结束]\n";
const fence = (source = flow, language = "mermaid") => ["~~~" + language, source.trimEnd(), "~~~"].join("\n");

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture(sources: string[], extension = ".md", basePath = "") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-markdown-diagram-"));
  directories.push(directory);
  const filePath = path.join(directory, "diagram" + extension);
  fs.writeFileSync(filePath, sources[0]!);
  const server = new LocalFileViewerServer({
    host: "127.0.0.1", port: 0, stateDirectory: directory,
    ...(basePath ? { publicBaseUrl: "http://viewer.test" + basePath } : {}),
  });
  servers.push(server);
  const address = await server.start();
  const signed = new URL(server.createFileUrl(filePath)!);
  const url = new URL(signed.pathname + signed.search, "http://127.0.0.1:" + address.port);
  const pages: string[] = [];
  for (const source of sources) {
    fs.writeFileSync(filePath, source);
    pages.push(await (await fetch(url)).text());
  }
  const script = await (await fetch(new URL(basePath + "/assets/viewer.js", url))).text();
  return { pages, script, url, filePath };
}

function client(pages: string[], script: string, options: { invalid?: boolean; libraryFails?: boolean } = {}) {
  vi.useFakeTimers();
  const { document } = parseHTML(pages[0]!);
  const render = vi.fn(async (_id: string, _source: string) => ({ svg: '<svg viewBox="0 0 300 100"><text>Rendered</text></svg>' }));
  if (options.invalid) render.mockRejectedValueOnce(new Error("Syntax error"));
  const initialize = vi.fn();
  const window = { mermaid: { render, initialize }, location: { hash: "" }, scrollX: 0, scrollY: 0,
    innerHeight: 600, scrollTo: vi.fn(), addEventListener: vi.fn() };
  const listeners = new Map<string, (event: { data: string }) => void>();
  class EventSource {
    close() {}
    addEventListener(name: string, callback: (event: { data: string }) => void) { listeners.set(name, callback); }
  }
  const append = document.head.appendChild.bind(document.head);
  const loads = vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    const result = append(node);
    if ((node as HTMLElement).tagName === "SCRIPT") {
      node.dispatchEvent(new document.defaultView!.Event(options.libraryFails ? "error" : "load"));
    }
    return result;
  });
  runInNewContext(script, { document, window, EventSource, setTimeout, clearTimeout,
    requestAnimationFrame: (fn: () => void) => fn() });
  const blocks = () => Array.from(document.querySelectorAll<HTMLElement>("[data-diagram]"));
  const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
  const update = (index: number) => {
    const next = parseHTML(pages[index]!).document;
    listeners.get("update")!({ data: JSON.stringify({
      content: next.querySelector("#viewer-content")!.innerHTML,
      metadata: next.querySelector("#viewer-metadata")!.innerHTML,
      viewMode: "markdown",
    }) });
  };
  return { document, render, initialize, loads, blocks, click, update, flush: () => vi.advanceTimersByTimeAsync(200) };
}

describe("Markdown file diagrams", () => {
  test.each([".md", ".MD", ".markdown", ".mdown", ".mkd", ".mkdn"])("renders diagram controls in %s while preserving full source and downloads", async (extension) => {
    const source = ["# 流程", fence(), fence('graph TD\nX["<script>alert(1)</script>"] --> Y', "flowchart"), fence("const n = 1;", "ts")].join("\n\n");
    const f = await fixture([source], extension);
    const { document } = parseHTML(f.pages[0]!);
    const blocks = document.querySelectorAll(".markdown-body [data-diagram]");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.querySelector(".diagram-source code")?.textContent).toBe(flow);
    expect(document.body.dataset.diagramScript).toBe("/assets/mermaid.js");
    expect(blocks[0]?.querySelector('[data-diagram-mode="preview"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(blocks[0]?.querySelector('[data-diagram-mode="source"]')?.textContent).toBe("源码");
    expect(blocks[0]?.querySelector("[data-diagram-size-toggle]")).not.toBeNull();
    expect(document.querySelector(".markdown-body script")).toBeNull();
    expect(document.querySelector('[data-view-panel="code"] [data-diagram]')).toBeNull();
    expect(document.querySelector(".markdown-code-block code.language-ts")).not.toBeNull();
    const raw = new URL(f.url); raw.searchParams.set("raw", "1");
    expect(await (await fetch(raw)).text()).toBe(source);
    raw.searchParams.set("download", "1");
    const download = await fetch(raw);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe(source);
    const tampered = new URL(f.url); tampered.searchParams.set("path", path.join(path.dirname(f.filePath), "other.md"));
    expect((await fetch(tampered)).status).toBe(403);
  });

  test("uses the bundled renderer under the configured base path and keeps strict CSP", async () => {
    const f = await fixture([fence()], ".md", "/bot");
    const response = await fetch(f.url);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(f.pages[0]).toContain('data-diagram-script="/bot/assets/mermaid.js"');
    const library = await fetch(new URL("/bot/assets/mermaid.js", f.url));
    expect(library.status).toBe(200);
    expect((await library.text()).length).toBeGreaterThan(100_000);
    const c = client(f.pages, f.script);
    await c.flush();
    expect(c.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", htmlLabels: false, maxEdges: 500 }));
    expect(c.loads).toHaveBeenCalledOnce();
    expect(c.render).toHaveBeenCalledWith(expect.any(String), flow, expect.anything());
    expect(c.blocks()[0]?.querySelector("svg")).not.toBeNull();
  });

  test("preserves diagram SVG, size, mode and scroll through file updates and insertions", async () => {
    const changed = "flowchart TD\nA --> C\n";
    const extra = "flowchart LR\nX --> Y\n";
    const f = await fixture([fence(), "# Added heading\n\n" + fence(), "# Added heading\n\n" + fence(changed), fence(extra) + "\n\n" + fence(changed)]);
    const c = client(f.pages, f.script);
    await c.flush();
    const block = c.blocks()[0]!;
    const svg = block.querySelector("svg");
    c.click("[data-diagram-size-toggle]");
    c.click('[data-diagram-mode="source"]');
    const source = block.querySelector<HTMLElement>(".diagram-source")!;
    source.scrollLeft = 45; source.scrollTop = 60;
    c.click('[data-view-mode-button="code"]');
    c.update(1);
    await c.flush();
    expect(c.blocks()[0]).toBe(block);
    expect(block.querySelector("svg")).toBe(svg);
    expect(c.render).toHaveBeenCalledOnce();
    expect(source.hidden).toBe(false);
    expect([source.scrollLeft, source.scrollTop]).toEqual([45, 60]);
    expect(block.dataset.diagramSize).toBe("actual");
    expect(c.document.body.dataset.viewMode).toBe("code");
    c.update(2);
    await c.flush();
    expect(c.blocks()[0]).toBe(block);
    expect(block.querySelector(".diagram-source code")?.textContent).toBe(changed);
    expect(source.hidden).toBe(false);
    expect(block.dataset.diagramSize).toBe("actual");
    expect(c.render).toHaveBeenCalledOnce();
    c.update(3);
    await c.flush();
    expect(c.blocks()[1]).toBe(block);
    expect(c.blocks()[0]?.dataset.diagramSize).toBe("fit");
    block.querySelector<HTMLElement>('[data-diagram-mode="preview"]')!.click();
    await c.flush();
    expect(c.render).toHaveBeenLastCalledWith(expect.any(String), changed, expect.anything());
    expect(c.loads).toHaveBeenCalledOnce();
  });

  test("matches unchanged diagrams by source when another diagram is inserted before them", async () => {
    const f = await fixture([fence(), fence("flowchart TD\nX --> Y\n") + "\n\n" + fence()]);
    const c = client(f.pages, f.script);
    await c.flush();
    const block = c.blocks()[0]!;
    const svg = block.querySelector("svg");
    c.click('[data-diagram-mode="source"]');
    c.update(1);
    await c.flush();
    expect(c.blocks()[1]).toBe(block);
    expect(block.querySelector("svg")).toBe(svg);
    expect(block.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(false);
    expect(c.render).toHaveBeenCalledTimes(2);
  });

  test("loads diagrams only when they arrive and removes them when the file changes", async () => {
    const f = await fixture(["Ordinary **Markdown**", fence(), "Removed diagram"]);
    const c = client(f.pages, f.script);
    await c.flush();
    expect(c.loads).not.toHaveBeenCalled();
    c.update(1);
    await c.flush();
    expect(c.blocks()).toHaveLength(1);
    expect(c.render).toHaveBeenCalledOnce();
    c.update(2);
    expect(c.blocks()).toHaveLength(0);
    expect(c.document.querySelector("#viewer-content")?.textContent).toContain("Removed diagram");
  });

  test("falls back to source for invalid diagrams and renders after correction", async () => {
    const f = await fixture([fence("flowchart LR\nA --> [\n"), fence()]);
    const c = client(f.pages, f.script, { invalid: true });
    await c.flush();
    expect(c.blocks()[0]?.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(false);
    expect(c.blocks()[0]?.querySelector(".diagram-notice")?.textContent).toContain("已显示源码");
    c.update(1);
    await c.flush();
    expect(c.blocks()[0]?.querySelector("svg")).not.toBeNull();
    expect(c.blocks()[0]?.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(true);
  });

  test("retains source if the local renderer cannot load", async () => {
    const f = await fixture([fence()]);
    const c = client(f.pages, f.script, { libraryFails: true });
    await c.flush();
    expect(c.render).not.toHaveBeenCalled();
    expect(c.blocks()[0]?.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(false);
    expect(c.blocks()[0]?.querySelector(".diagram-source code")?.textContent).toBe(flow);
  });

  test("keeps renderer security limits for Markdown files", async () => {
    const unsafe = '%%{init: {"securityLevel":"loose"}}%%\n' + flow;
    const f = await fixture([fence(unsafe) + "\n\n" + fence(flow + " ".repeat(50_001) + "x")]);
    const c = client(f.pages, f.script);
    await c.flush();
    expect(c.render).not.toHaveBeenCalled();
    expect(c.loads).not.toHaveBeenCalled();
    for (const block of c.blocks()) expect(block.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(false);
  });

  test("keeps duplicate diagrams independent on repeated file snapshots", async () => {
    const f = await fixture([fence() + "\n\n" + fence()]);
    const c = client(f.pages, f.script);
    await c.flush();
    const before = c.blocks();
    before[1]!.querySelector<HTMLElement>('[data-diagram-mode="source"]')!.click();
    before[0]!.querySelector<HTMLElement>("[data-diagram-size-toggle]")!.click();
    c.update(0);
    await c.flush();
    expect(c.blocks()[0]).toBe(before[0]);
    expect(c.blocks()[1]).toBe(before[1]);
    expect(c.blocks()[0]?.dataset.diagramSize).toBe("actual");
    expect(c.blocks()[1]?.dataset.diagramSize).toBe("fit");
    expect(c.blocks()[0]?.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(true);
    expect(c.blocks()[1]?.querySelector<HTMLElement>(".diagram-source")?.hidden).toBe(false);
    expect(c.render).toHaveBeenCalledTimes(2);
  });

  test("delivers diagram fences in real file-change SSE updates", async () => {
    const f = await fixture(["Initial text"]);
    const eventsUrl = new URL(f.url); eventsUrl.searchParams.set("events", "1");
    const abort = new AbortController();
    try {
      const response = await fetch(eventsUrl, { signal: abort.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      const next = async (): Promise<{ content: string; viewMode: string }> => {
        while (true) {
          const boundary = buffered.indexOf("\n\n");
          if (boundary >= 0) {
            const event = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
            if (event.startsWith("event: update\n")) return JSON.parse(event.split("\ndata: ")[1]!);
          } else {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("SSE ended");
            buffered += decoder.decode(chunk.value, { stream: true });
          }
        }
      };
      expect((await next()).content).not.toContain("data-diagram");
      fs.writeFileSync(f.filePath, fence());
      const update = await next();
      expect(update.viewMode).toBe("markdown");
      expect(update.content).toContain('data-diagram-mode="preview"');
    } finally { abort.abort(); }
  }, 10_000);
});
