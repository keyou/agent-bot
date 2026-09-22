import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";
import { renderTurnPreviewPage, renderTurnPreviewSnapshot, TURN_PREVIEW_CLIENT_SCRIPT } from "../../src/local-files/TurnPreviewPage.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

const flow = 'flowchart LR\n  A[开始] --> B{通过?}\n  B -->|是| C[完成]\n';
const diagram = (source = flow) => `\`\`\`mermaid\n${source}\`\`\``;
function state(text = diagram()): TurnViewState {
  return { sessionId: "s", turnId: "t", startedAt: 1000, status: "running", prompt: "Draw a flowchart",
    assistantText: text, plan: [], completedTools: [], failedTools: [], fileSummary: [], activities: [] };
}
const directories: string[] = [];
const servers: LocalFileViewerServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function client(initial = state(), render = vi.fn(async (_id: string, _source: string) => ({
  svg: '<svg viewBox="0 0 300 100"><text>Rendered</text></svg>',
})), libraryFails = false) {
  vi.useFakeTimers();
  const { document } = parseHTML(renderTurnPreviewPage({ state: initial, eventsUrl: "/events", scriptPath: "/client.js", diagramScriptPath: "/assets/mermaid.js" }));
  const listeners = new Map<string, (event: { data: string }) => void>();
  class EventSource {
    close() {}
    addEventListener(name: string, callback: (event: { data: string }) => void) { listeners.set(name, callback); }
  }
  const initialize = vi.fn();
  const window = { mermaid: { initialize, render }, scrollY: 0, innerHeight: 700, scrollTo: vi.fn(), addEventListener: vi.fn() };
  const append = document.head.appendChild.bind(document.head);
  const loads = vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    const appended = append(node);
    if ((node as HTMLElement).tagName === "SCRIPT") {
      (node as HTMLElement).dispatchEvent(new document.defaultView!.Event(libraryFails ? "error" : "load"));
    }
    return appended;
  });
  runInNewContext(TURN_PREVIEW_CLIENT_SCRIPT, { document, window, EventSource, setInterval: vi.fn(),
    setTimeout, clearTimeout, requestAnimationFrame: (fn: () => void) => fn() });
  const block = () => document.querySelector<HTMLElement>("[data-diagram]")!;
  const click = (mode: string) => block().querySelector<HTMLElement>(`[data-diagram-mode="${mode}"]`)!.click();
  const update = (text: string) => listeners.get("update")!({ data: JSON.stringify(renderTurnPreviewSnapshot(state(text))) });
  const flush = () => vi.advanceTimersByTimeAsync(200);
  return { document, window, block, click, update, flush, initialize, render, loads };
}

describe("Turn Preview diagrams", () => {
  test.each(["mermaid", "flowchart"])("provides escaped %s source and preview/source controls", (language) => {
    const source = 'flowchart LR\nA["<script>alert(1)</script>"] --> B';
    const page = renderTurnPreviewSnapshot(state(`\`\`\`${language}\n${source}\n\`\`\``), undefined, "en").content;
    expect(page).toContain('data-diagram-mode="preview" aria-pressed="true">Preview');
    expect(page).toContain('data-diagram-mode="source" aria-pressed="false">Source');
    expect(page).toContain('class="diagram-source" hidden');
    expect(page).toContain('&lt;script&gt;');
    expect(page).not.toContain('<script>alert');
    expect(renderTurnPreviewSnapshot(state('```js\nA --> B\n```')).content).not.toContain('data-diagram');
  });

  test("renders locally in preview by default, keeps source mode and SVG across SSE updates", async () => {
    const c = client();
    await c.flush();
    expect(c.render).toHaveBeenCalledOnce();
    expect(c.render).toHaveBeenCalledWith(expect.stringMatching(/^agentbot-diagram-/), flow, expect.anything());
    expect(c.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false, htmlLabels: false }));
    const block = c.block();
    const svg = block.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(block.querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(true);
    c.click("source");
    expect(block.querySelector<HTMLElement>(".diagram-preview")!.hidden).toBe(true);
    c.update(diagram());
    await c.flush();
    expect(c.block()).toBe(block);
    expect(c.block().querySelector("svg")).toBe(svg);
    expect(c.render).toHaveBeenCalledOnce();
    c.update(diagram('flowchart TD\nA --> C\n'));
    await c.flush();
    expect(c.block()).toBe(block);
    expect(c.render).toHaveBeenCalledOnce();
    expect(c.block().querySelector(".diagram-source code")!.textContent).toContain("A --> C");
    expect(c.block().querySelector('[data-diagram-mode="source"]')!.getAttribute("aria-pressed")).toBe("true");
    c.click("preview");
    await c.flush();
    expect(c.render).toHaveBeenCalledTimes(2);
    expect(c.loads).toHaveBeenCalledOnce();
  });

  test("fits diagram width by default and preserves actual-size mode across source and SSE updates", async () => {
    const c = client();
    await c.flush();
    const block = c.block();
    const toggle = block.querySelector<HTMLElement>("[data-diagram-size-toggle]")!;
    const svg = block.querySelector<HTMLElement>("svg")!;
    expect(block.dataset.diagramSize).toBe("fit");
    expect(svg.style.getPropertyValue("--diagram-width")).toBe("300px");
    expect(toggle.hidden).toBe(false);
    expect(toggle.textContent).toBe("原大");
    toggle.click();
    expect(block.dataset.diagramSize).toBe("actual");
    expect(toggle.textContent).toBe("适应");
    c.click("source");
    expect(toggle.hidden).toBe(true);
    c.click("preview");
    expect(block.dataset.diagramSize).toBe("actual");
    c.update(diagram());
    await c.flush();
    expect(c.block().querySelector("svg")).toBe(svg);
    expect(c.render).toHaveBeenCalledOnce();
    c.render.mockResolvedValueOnce({ svg: '<svg viewBox="0 0 500 2000"><text>Changed</text></svg>' });
    c.update(diagram('flowchart TD\nA --> B --> C\n'));
    await c.flush();
    expect(c.block()).toBe(block);
    expect(block.dataset.diagramSize).toBe("actual");
    expect(block.querySelector<HTMLElement>("svg")!.style.getPropertyValue("--diagram-width")).toBe("500px");
    const preview = block.querySelector<HTMLElement>(".diagram-preview")!;
    preview.scrollLeft = 100;
    preview.scrollTop = 300;
    toggle.click();
    expect(block.dataset.diagramSize).toBe("fit");
    expect([preview.scrollLeft, preview.scrollTop]).toEqual([0, 0]);
    expect(c.render).toHaveBeenCalledTimes(2);
  });

  test("keeps diagram size independent between blocks", async () => {
    const c = client(state(diagram() + "\n\n" + diagram("flowchart TD\nX --> Y\n")));
    await c.flush();
    const blocks = c.document.querySelectorAll<HTMLElement>("[data-diagram]");
    blocks[0]!.querySelector<HTMLElement>("[data-diagram-size-toggle]")!.click();
    expect(blocks[0]!.dataset.diagramSize).toBe("actual");
    expect(blocks[1]!.dataset.diagramSize).toBe("fit");
  });

  test("renders newly streamed diagrams without downloading Mermaid for ordinary Markdown", async () => {
    const c = client(state("No diagram yet"));
    await c.flush();
    expect(c.loads).not.toHaveBeenCalled();
    c.update(diagram());
    await c.flush();
    expect(c.block().querySelector("svg")).not.toBeNull();
  });

  test("renders completed previews without an SSE connection and keeps each block independent", async () => {
    const input = state();
    input.status = "completed";
    input.finalResponse = diagram() + "\n\n" + diagram("flowchart TD\nX --> Y\n");
    input.assistantText = "";
    const c = client(input);
    await c.flush();
    const blocks = c.document.querySelectorAll<HTMLElement>("[data-diagram]");
    expect(blocks).toHaveLength(2);
    expect(c.render).toHaveBeenCalledTimes(2);
    expect(c.loads).toHaveBeenCalledOnce();
    c.click("source");
    expect(blocks[0]!.querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(false);
    expect(blocks[1]!.querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(true);
  });

  test("falls back for partial or invalid Mermaid and retries changed content", async () => {
    const render = vi.fn(async (_id: string, _source: string) => ({ svg: '<svg viewBox="0 0 200 80"></svg>' }));
    render.mockRejectedValueOnce(new Error("Syntax error"));
    const c = client(state(diagram('flowchart LR\nA --> [\n')), render);
    await c.flush();
    expect(c.block().querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(false);
    expect(c.block().querySelector(".diagram-notice")!.textContent).toContain("已显示源码");
    c.update(diagram());
    await c.flush();
    expect(c.block().querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(true);
    expect(c.block().querySelector("svg")).not.toBeNull();
  });

  test("retains source when the local renderer fails to load", async () => {
    const c = client(state(), undefined, true);
    await c.flush();
    expect(c.block().querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(false);
    expect(c.block().querySelector(".diagram-source code")!.textContent).toBe(flow);
    expect(c.render).not.toHaveBeenCalled();
  });

  test.each(['%%{init: {"securityLevel":"loose"}}%%\n' + flow, '---\nconfig:\n  securityLevel: loose\n---\n' + flow, flow + ' '.repeat(50_000)])("rejects unsafe renderer configuration and oversized input", async (source) => {
    const c = client(state(diagram(source)));
    await c.flush();
    expect(c.render).not.toHaveBeenCalled();
    expect(c.block().querySelector<HTMLElement>(".diagram-source")!.hidden).toBe(false);
  });

  test("does not insert obsolete render results after SSE changes", async () => {
    let resolve: (result: { svg: string }) => void = () => {};
    const render = vi.fn((_id: string, _source: string) => new Promise<{ svg: string }>((done) => { resolve = done; }));
    const c = client(state(), render);
    await c.flush();
    const finishFirst = resolve;
    c.update(diagram('flowchart LR\nX --> Y\n'));
    await c.flush();
    finishFirst({ svg: '<svg><text>Old</text></svg>' });
    await c.flush();
    expect(c.block().textContent).not.toContain("Old");
    resolve({ svg: '<svg><text>New</text></svg>' });
    await c.flush();
    expect(c.block().querySelector("svg")!.textContent).toBe("New");
  });

  test("removes active SVG content and external links as defense in depth", async () => {
    const render = vi.fn(async (_id: string, _source: string) => ({ svg: '<svg><script>alert(1)</script><foreignObject>HTML</foreignObject><image href="https://evil.test/x"/><a href="javascript:alert(1)" onclick="evil()"><text>Safe</text></a></svg>' }));
    const c = client(state(), render);
    await c.flush();
    const svg = c.block().querySelector("svg")!;
    expect(svg.querySelector("script,foreignObject,image,[onclick],[href]")).toBeNull();
    expect(svg.textContent).toBe("Safe");
  });

  test("serves bundled Mermaid from the viewer base path without exposing arbitrary packages", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-diagram-"));
    directories.push(directory);
    const server = new LocalFileViewerServer({ stateDirectory: directory, host: "127.0.0.1", port: 0,
      publicBaseUrl: "http://viewer.test/bot", getTurnSnapshot: () => state() });
    servers.push(server);
    await server.start();
    const url = new URL(server.createTurnPreviewUrl("t")!);
    // The public URL can contain a reverse proxy prefix; connect directly to the actual listener.
    const port = fs.readFileSync(path.join(directory, "port"), "utf8").trim();
    const local = new URL(url.pathname + url.search, `http://127.0.0.1:${port}`);
    const response = await fetch(local);
    const page = await response.text();
    expect(page).toContain('data-diagram-script="/bot/assets/mermaid.js"');
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    const asset = new URL("/bot/assets/mermaid.js", local);
    const library = await fetch(asset);
    expect(library.headers.get("Content-Type")).toContain("javascript");
    expect((await library.text()).length).toBeGreaterThan(100_000);
    expect((await fetch(asset, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(new URL("/bot/assets/package.json", local))).status).toBe(404);
  });
});
