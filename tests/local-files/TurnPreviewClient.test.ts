/// <reference lib="dom" />
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, test, vi } from "vitest";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";
import {
  renderTurnPreviewPage,
  renderTurnPreviewSnapshot,
  renderTurnPreviewPatch,
  renderTurnPreviewDetail,
  TURN_PREVIEW_CLIENT_SCRIPT,
} from "../../src/local-files/TurnPreviewPage.js";

const imagePath = path.resolve("preview/image.png");
const localFileUrl = (filePath: string) => `https://viewer.test/preview/image?path=${encodeURIComponent(filePath)}`;

function initialState(): TurnViewState {
  return {
    sessionId: "session", turnId: "turn", startedAt: 1_000, status: "running",
    prompt: "Inspect this image.", assistantText: "", plan: [],
    completedTools: [], failedTools: [], fileSummary: [],
    activities: [{ kind: "tool", id: "tool:image", tool: {
      id: "tool:image", kind: "image", title: "Screenshot", status: "running", imagePath, startedAt: 1_000,
    } }],
  };
}

function startClient(initial = initialState(), lazy = false, options: {
  clipboard?: { writeText: (text: string) => Promise<void> };
  legacyCopy?: (text: string) => boolean;
  language?: "zh" | "en";
} = {}) {
  let current = initial;
  const { document } = parseHTML(renderTurnPreviewPage({
    state: initial, eventsUrl: "/turn-events", scriptPath: "/client.js", localFileUrl, language: options.language,
  }));
  if (!lazy) document.getElementById("turn-content")!.innerHTML = renderTurnPreviewSnapshot(initial, localFileUrl, options.language).content;
  const requests: Array<{ key: string; signal: AbortSignal }> = [];
  const fetchDetail = vi.fn(async (url: URL, options: { signal: AbortSignal }) => {
    const key = url.searchParams.get("detail")!;
    requests.push({ key, signal: options.signal });
    const detail = renderTurnPreviewDetail(current, key, localFileUrl);
    return { ok: Boolean(detail), status: detail ? 200 : 404, json: async () => detail };
  });
  const listeners = new Map<string, (event: { data: string }) => void>();
  const close = vi.fn();
  class EventSource {
    onerror?: () => void;
    close = close;
    addEventListener(type: string, callback: (event: { data: string }) => void) { listeners.set(type, callback); }
  }
  const frames: Array<() => void> = [];
  const setInterval = vi.fn();
  const scrollTo = vi.fn();
  const window = { location: { href: "https://viewer.test/turn" }, scrollY: 120, innerHeight: 600, scrollTo, addEventListener: vi.fn(),
    navigator: { clipboard: options.clipboard } };
  const blobs = new Map<string, Blob>();
  const createObjectURL = vi.fn((blob: Blob) => {
    const url = "blob:answer-" + blobs.size;
    blobs.set(url, blob);
    return url;
  });
  const revokeObjectURL = vi.fn((url: string) => { blobs.delete(url); });
  class PreviewURL extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  }
  const downloads: Array<{ filename: string; blob?: Blob }> = [];
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const element = createElement(tag);
    if (tag === "a") element.click = () => {
      downloads.push({ filename: element.getAttribute("download") ?? "", blob: blobs.get(element.getAttribute("href") ?? "") });
    };
    if (tag === "textarea") {
      Object.assign(element, { select: vi.fn(), setSelectionRange: vi.fn() });
    }
    return element;
  }) as typeof document.createElement;
  const legacyCopy = vi.fn(() => options.legacyCopy?.(document.querySelector("textarea")?.value ?? "") ?? false);
  Object.assign(document, { execCommand: legacyCopy });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 2_000, configurable: true });
  runInNewContext(TURN_PREVIEW_CLIENT_SCRIPT, {
    document, window, EventSource, setInterval, clearInterval: vi.fn(), setTimeout, clearTimeout, AbortController,
    URL: PreviewURL, Blob, TextDecoder, atob, fetch: fetchDetail,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  const element = <T extends Element = HTMLElement>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing element: ${selector}`);
    return found;
  };
  const update = (state: TurnViewState) => {
    current = state;
    listeners.get("update")!({ data: JSON.stringify(renderTurnPreviewSnapshot(state, localFileUrl, "zh", { deferDetails: lazy })) });
    expect(element("#turn-live").className).toBe(state.status === "completed" ? "live terminal" : "live connected");
  };
  const flushFrames = () => { for (const callback of frames.splice(0)) callback(); };
  const toggle = (selector: string, open: boolean) => {
    const details = element<HTMLDetailsElement>(selector);
    Object.defineProperty(details, "open", { configurable: true, get: () => details.hasAttribute("open") });
    details.toggleAttribute("open", open);
    details.dispatchEvent(new document.defaultView!.Event("toggle", { bubbles: true }));
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return { document, element, update, flushFrames, close, setInterval, scrollTo, window, listeners, requests, fetchDetail, toggle, settle,
    downloads, createObjectURL, revokeObjectURL, legacyCopy };

}

describe("Turn Preview incremental client", () => {
  test.each(["update", "patch"] as const)("retains command approval expansion and scroll during live %s updates", (event) => {
    const initial = initialState();
    initial.status = "waiting_for_approval";
    initial.activities = [];
    initial.approval = { id: "a1", title: "command", command: "Get-Content file.txt", reason: "Read files", options: [] };
    const client = startClient(initial);
    const details = client.element(".approval-details");
    client.toggle(".approval-details", true);
    const command = client.element(".approval-details pre");
    command.scrollLeft = 27;
    command.scrollTop = 42;
    const update = (state: TurnViewState) => {
      if (event === "update") client.update(state);
      else client.listeners.get("patch")!({ data: JSON.stringify(renderTurnPreviewPatch(state, new Set(), new Set(), localFileUrl, "zh")) });
      client.flushFrames();
    };
    update({ ...initial, approval: { ...initial.approval, reason: "Read files before the next step" } });
    expect(client.element(".approval-details")).toBe(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(client.element(".approval-details pre")).toBe(command);
    expect([command.scrollLeft, command.scrollTop]).toEqual([27, 42]);
    update({ ...initial, approval: { ...initial.approval, id: "a2", command: "git status" } });
    expect(client.element(".approval-details").hasAttribute("open")).toBe(false);
    expect(client.element(".approval-details pre").textContent).toBe("git status");
    update({ ...initial, status: "running", approval: undefined });
    expect(client.document.querySelector('[data-preview-key="approval"]')).toBeNull();
  });

  test("copies raw Markdown and downloads an exact UTF-8 .md file from an already completed page", async () => {
    const markdown = '\n# 结果 👋\r\n\r\n**bold**\n|a|b|\n|-|-|\n|1|2|\n[原链接](dir/file.md)\n\n    code\n<script>alert("text")</script>\n';
    const writeText = vi.fn(async () => undefined);
    const client = startClient({ ...initialState(), status: "completed", finalResponse: markdown }, false, { clipboard: { writeText } });
    expect(client.listeners.size).toBe(0);
    client.element<HTMLButtonElement>('[data-answer-action="copy"]').click();
    await client.settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(markdown);
    expect(client.legacyCopy).not.toHaveBeenCalled();
    expect(client.element("[data-answer-feedback]").textContent).toBe("已复制 Markdown");
    client.element('[data-answer-action="download"] path')
      .dispatchEvent(new client.document.defaultView!.Event("click", { bubbles: true }));
    await client.settle();
    expect(client.downloads).toHaveLength(1);
    expect(client.downloads[0]?.filename).toBe("turn-turn.md");
    expect(client.downloads[0]?.blob?.type).toBe("text/markdown;charset=utf-8");
    expect(await client.downloads[0]?.blob?.text()).toBe(markdown);
    expect(client.document.querySelector('a[download]')).toBeNull();
    expect(client.element("[data-answer-feedback]").textContent).toBe("已开始下载");
    await vi.waitFor(() => expect(client.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:answer-0"), { timeout: 3_000 });
  });

  test.each(["unavailable", "denied"])("falls back to legacy copy when clipboard access is %s", async (mode) => {
    const markdown = "**HTTP LAN preview**\r\n中文";
    const legacyCopy = vi.fn(() => true);
    const client = startClient({ ...initialState(), status: "completed", finalResponse: markdown }, false, {
      clipboard: mode === "denied" ? { writeText: vi.fn(async () => { throw new Error("Denied"); }) } : undefined,
      legacyCopy,
    });
    client.element<HTMLButtonElement>('[data-answer-action="copy"]').click();
    await client.settle();
    expect(legacyCopy).toHaveBeenCalledExactlyOnceWith(markdown);
    expect(client.legacyCopy).toHaveBeenCalledExactlyOnceWith("copy");
    expect(client.document.querySelector("textarea")).toBeNull();
    expect(client.element("[data-answer-feedback]").textContent).toBe("已复制 Markdown");
  });

  test("ignores duplicate copy clicks while pending and preserves leading BOMs", async () => {
    const markdown = "\ufeff# Original Markdown\n";
    let resolveCopy: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    const client = startClient({ ...initialState(), status: "completed", finalResponse: markdown }, false, { clipboard: { writeText } });
    const copy = client.element<HTMLButtonElement>('[data-answer-action="copy"]');
    copy.click();
    copy.click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(markdown);
    expect(copy.disabled).toBe(true);
    resolveCopy!();
    await client.settle();
    expect(copy.disabled).toBe(false);
    expect(client.element("[data-answer-feedback]").textContent).toBe("已复制 Markdown");
  });

  test("reports export failures and allows retries without claiming success", async () => {
    const legacyCopy = vi.fn(() => false);
    const client = startClient({ ...initialState(), status: "completed", finalResponse: "# Answer" }, false, { legacyCopy, language: "en" });
    const copy = client.element<HTMLButtonElement>('[data-answer-action="copy"]');
    copy.click();
    await client.settle();
    expect(client.element("[data-answer-feedback]").textContent).toContain("Copy failed");
    expect(copy.disabled).toBe(false);
    expect(client.document.querySelector("textarea")).toBeNull();
    legacyCopy.mockReturnValue(true);
    copy.click();
    await client.settle();
    expect(client.element("[data-answer-feedback]").textContent).toBe("Markdown copied");

    client.createObjectURL.mockImplementationOnce(() => { throw new Error("Download blocked"); });
    const download = client.element<HTMLButtonElement>('[data-answer-action="download"]');
    download.click();
    await client.settle();
    expect(client.element("[data-answer-feedback]").textContent).toContain("Download failed");
    expect(download.disabled).toBe(false);
    expect(client.downloads).toHaveLength(0);
  });

  test.each(["update", "patch"] as const)("exports the latest final Markdown after a live %s without rebinding buttons", async (event) => {
    const initial = initialState();
    initial.assistantText = "Draft";
    const writeText = vi.fn(async () => undefined);
    const client = startClient(initial, false, { clipboard: { writeText } });
    expect(client.document.querySelector("[data-answer-action]")).toBeNull();
    const update = (finalResponse: string) => {
      const next = { ...initial, status: "completed" as const, finalResponse };
      if (event === "update") client.update(next);
      else client.listeners.get("patch")!({ data: JSON.stringify(renderTurnPreviewPatch(next, new Set(), new Set(), localFileUrl, "zh")) });
    };
    update("**First answer**");
    const copy = client.element<HTMLButtonElement>('[data-answer-action="copy"]');
    copy.click();
    await client.settle();
    expect(writeText).toHaveBeenLastCalledWith("**First answer**");
    update("# Corrected answer\n中文");
    expect(client.element('[data-answer-action="copy"]')).toBe(copy);
    copy.click();
    await client.settle();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("# Corrected answer\n中文");
    expect(client.document.querySelectorAll("[data-answer-action]")).toHaveLength(2);
    client.element<HTMLButtonElement>('[data-answer-action="download"]').click();
    await client.settle();
    expect(await client.downloads[0]?.blob?.text()).toBe("# Corrected answer\n中文");
  });

  test.each(["update", "patch"] as const)("keeps a generic processing header across tool transitions via %s", (event) => {
    const initial = initialState();
    const client = startClient(initial);
    const header = client.element("#turn-status");
    expect(header.textContent).toBe("正在处理");
    for (const status of ["tool_running", "running", "tool_running", "completed"] as const) {
      const next = { ...initial, status };
      if (event === "update") {
        client.update(next);
      } else {
        const patch = renderTurnPreviewPatch(next, new Set(), new Set(), localFileUrl, "zh");
        client.listeners.get("patch")!({ data: JSON.stringify(patch) });
      }
      client.flushFrames();
      expect(client.element("#turn-status")).toBe(header);
      expect(header.textContent).toBe(status === "completed" ? "已完成" : "正在处理");
      expect(header.classList.contains(status)).toBe(true);
    }
    expect(client.close).toHaveBeenCalled();
  });

  test("journal patches retain unchanged blocks, images and disclosures and append final sections once", async () => {
    const state = initialState();
    state.activities.unshift({ kind: "assistant", id: "commentary:old", text: "Old commentary" });
    const client = startClient(state, true);
    client.toggle(".tool-step", true);
    await client.settle();
    const old = client.element('[data-activity="commentary:old"]');
    const image = client.element(".tool-image img");
    const next = structuredClone(state);
    next.activities.push({ kind: "assistant", id: "commentary:new", text: "New commentary" });
    next.fileSummary = [{ path: "changed.ts" }];
    next.finalResponse = "Final answer";
    next.status = "completed";
    const patch = renderTurnPreviewPatch(next, new Set(["commentary:new"]), new Set(), localFileUrl, "zh");
    client.listeners.get("patch")!({ data: JSON.stringify(patch) });
    expect(client.element('[data-activity="commentary:old"]')).toBe(old);
    expect(client.element(".tool-image img")).toBe(image);
    expect(client.element(".tool-step").hasAttribute("open")).toBe(true);
    expect(client.element('[data-preview-key="result"]').textContent).toContain("Final answer");
    expect(client.element(".files-summary")).toBeDefined();
    client.listeners.get("patch")!({ data: JSON.stringify(patch) });
    expect(client.document.querySelectorAll('[data-activity="commentary:new"]')).toHaveLength(1);
    expect(client.document.querySelectorAll('[data-preview-key="result"]')).toHaveLength(1);
    expect(client.close).toHaveBeenCalled();
  });


  test("appends streamed output without replacing the loaded command/image DOM", async () => {
    const state = initialState();
    state.activities = [{ kind: "tool", id: "cmd", tool: { id: "cmd", kind: "command", title: "run", command: "run", status: "running", output: "first", previewRevision: 1 } }];
    const client = startClient(state, true);
    client.toggle(".tool-step", true);
    await client.settle();
    const output = client.element(".tool-output");
    const command = client.element(".command-block");
    client.fetchDetail.mockResolvedValueOnce({ ok: true, status: 200,
      json: async () => ({ key: "tool:cmd", revision: "2", content: "", outputAppend: "\nsecond", footer: "metadata" }) });
    const next = structuredClone(state);
    if (next.activities[0]?.kind === "tool") next.activities[0].tool.previewRevision = 2;
    client.listeners.get("patch")!({ data: JSON.stringify(renderTurnPreviewPatch(next, new Set(["cmd"]), new Set(), localFileUrl, "zh")) });
    await client.settle();
    expect(client.element(".tool-output")).toBe(output);
    expect(client.element(".command-block")).toBe(command);
    expect(output.textContent).toBe("first\nsecond");
  });

  test("lazy loads reasoning and keeps its expansion and tool images across streamed updates", async () => {
    const input = initialState();
    input.reasoningItems = [{ itemId: "r1", summary: ["**Understanding API Implementation**\n\nSummary"], content: ["Body"] }];
    const client = startClient(input, true);
    expect(client.requests).toHaveLength(0);
    expect(client.element(".reasoning-header").textContent).toBe("💭 Understanding API Implementation");
    client.toggle(".reasoning-step", true);
    await client.settle();
    const panel = client.element(".reasoning-step");
    expect(panel.textContent).toContain("Body");
    expect(client.requests).toHaveLength(1);
    client.toggle(".tool-step", true);
    await client.settle();
    const image = client.element(".tool-image img");
    const next = structuredClone(input);
    next.reasoningItems![0]!.summary[0] = "## Verifying the implementation\n\nSummary";
    next.reasoningItems![0]!.content[0] += " more";
    client.update(next);
    await client.settle();
    expect(client.element(".reasoning-step")).toBe(panel);
    expect(panel.hasAttribute("open")).toBe(true);
    expect(panel.textContent).toContain("Body more");
    expect(client.element(".reasoning-header").textContent).toBe("💭 Verifying the implementation");
    expect(client.element(".reasoning-section").textContent).not.toContain("Verifying the implementation");
    expect(client.element(".tool-image img")).toBe(image);
    expect(client.requests).toHaveLength(3);
    client.toggle(".reasoning-step", false);
    next.reasoningItems![0]!.content[0] += " closed";
    next.reasoningItems![0]!.summary[0] = "**Finishing verification**\n\nSummary";
    client.update(next);
    await client.settle();
    expect(client.requests).toHaveLength(3);
    expect(client.element(".reasoning-header").textContent).toBe("💭 Finishing verification");
    client.toggle(".reasoning-step", true);
    await client.settle();
    expect(panel.textContent).toContain("closed");
    expect(client.requests).toHaveLength(4);
  });

  test("moves a completed streamed heading into the header without losing the open body or image", async () => {
    const input = initialState();
    input.reasoningItems = [{ itemId: "r1", summary: ["**Understanding API"], content: [`![Reference](${imagePath})`] }];
    const client = startClient(input, true);
    client.toggle(".reasoning-step", true);
    await client.settle();
    const panel = client.element(".reasoning-step");
    const header = client.element(".reasoning-header");
    const image = client.element(".reasoning-part img");
    const attrs = vi.spyOn(image, "setAttribute");
    expect(header.textContent).toBe("💭 思考");
    expect(panel.textContent).toContain("**Understanding API");
    const next = structuredClone(input);
    next.reasoningItems![0]!.summary[0] += " Implementation**\n\nRead the implementation.";
    client.update(next);
    await client.settle();
    expect(client.element(".reasoning-step")).toBe(panel);
    expect(panel.hasAttribute("open")).toBe(true);
    expect(client.element(".reasoning-header")).toBe(header);
    expect(header.textContent).toBe("💭 Understanding API Implementation");
    expect(client.element('[data-reasoning-field="summary"]').textContent?.trim()).toBe("Read the implementation.");
    expect(client.element(".reasoning-part img")).toBe(image);
    expect(attrs).not.toHaveBeenCalled();
  });

  test.each(["summary", "content"] as const)("retains %s images when a streamed title-only part moves into the header", async (imageField) => {
    const input = initialState();
    input.reasoningItems = [{ itemId: "r1", summary: ["**Inspecting image"], content: [] }];
    input.reasoningItems[0]![imageField].push(`![Reference](${imagePath})`);
    const client = startClient(input, true);
    client.toggle(".reasoning-step", true);
    await client.settle();
    const image = client.element(".reasoning-part img");
    const next = structuredClone(input);
    next.reasoningItems![0]!.summary[0] += "**";
    client.update(next);
    await client.settle();
    expect(client.element(".reasoning-header").textContent).toBe("💭 Inspecting image");
    expect(client.element(".reasoning-part img")).toBe(image);
    expect(client.document.querySelector('[data-reasoning-field="summary"] [data-reasoning-part="0"]')).toBeNull();
  });

  test("removes the waiting placeholder when an answer arrives and reveals later progress in place", () => {
    const input = { ...initialState(), activities: [] };
    const client = startClient(input, true);
    const timeline = client.element(".timeline");
    expect(client.element(".empty").textContent).toContain("正在等待");
    client.update({ ...input, assistantText: "Streaming answer" });
    expect(client.element(".timeline")).toBe(timeline);
    expect(timeline.hasAttribute("hidden")).toBe(true);
    expect(client.document.querySelector(".empty")).toBeNull();
    client.update({ ...initialState(), assistantText: "Streaming answer" });
    expect(client.element(".timeline")).toBe(timeline);
    expect(timeline.hasAttribute("hidden")).toBe(false);
    expect(client.element(".activity.tool")).toBeDefined();
    client.update({ ...input, status: "completed", finalResponse: "The final answer." });
    expect(client.element(".timeline")).toBe(timeline);
    expect(timeline.hasAttribute("hidden")).toBe(true);
    expect(client.document.querySelector(".empty")).toBeNull();
    expect(client.element(".final-result").textContent).toContain("The final answer.");
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("adds appended user images on SSE updates and keeps loaded attachments across updates", () => {
    const input = initialState();
    const c = startClient(input);
    const next = structuredClone(input);
    next.activities.push({ kind: "user", id: "steer:image", text: "Look here", localImagePaths: [imagePath] });
    c.update(next);
    const image = c.element<HTMLImageElement>('[data-activity="steer:image"] img');
    expect(new URL(image.src).searchParams.get("raw")).toBe("1");
    const attrs = vi.spyOn(image, "setAttribute");
    c.update({ ...next, assistantText: "Continuing" });
    expect(c.element('[data-activity="steer:image"] img')).toBe(image);
    expect(attrs).not.toHaveBeenCalled();
  });

  test("preserves highlighted code and its scroll position while streaming new content", () => {
    const input = initialState();
    input.assistantText = '```ts\nconst value: string = "<safe>";\n```';
    const c = startClient(input);
    const block = c.element(".result pre");
    const keyword = c.element(".result .hljs-keyword");
    block.scrollLeft = 37;
    block.scrollTop = 12;
    c.update({ ...input, assistantText: input.assistantText + "\n\nMore details." });
    c.flushFrames();
    expect(c.element(".result pre")).toBe(block);
    expect(c.element(".result .hljs-keyword")).toBe(keyword);
    expect([block.scrollLeft, block.scrollTop]).toEqual([37, 12]);
    const next = { ...input, assistantText: '```ts\nconst value: number = 42;\n```' };
    c.update(next);
    expect(c.element(".result code").textContent).toBe("const value: number = 42;\n");
    expect(c.element(".result .hljs-number").textContent).toBe("42");
    expect(c.document.querySelector(".result code span span span")).toBeNull();
  });

  test("retains the loaded image and open disclosure even for the initial SSE snapshot", () => {
    const input = initialState();
    const client = startClient(input);
    const image = client.element(".tool-image img");
    const block = client.element("details");
    const article = client.element(".activity.tool");
    block.setAttribute("open", "");
    const imageAttributes = vi.spyOn(image, "setAttribute");
    const insert = vi.spyOn(article.parentNode!, "insertBefore");
    const scroller = client.element(".tool-content");
    scroller.scrollLeft = 61;
    scroller.scrollTop = 43;

    client.update(input);
    client.flushFrames();

    expect(client.element(".tool-image img")).toBe(image);
    expect(client.element("details")).toBe(block);
    expect(block.hasAttribute("open")).toBe(true);
    expect(client.element(".tool-content")).toBe(scroller);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([61, 43]);
    expect(imageAttributes).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(client.scrollTo).toHaveBeenLastCalledWith(0, 120);
  });

  test("appends activities and patches tool output/status without replacing existing images", () => {
    const input = initialState();
    const client = startClient(input);
    const image = client.element(".tool-image img");
    const details = client.element("details");
    const body = client.element(".tool-content");
    const footer = client.element(".tool-footer");
    details.setAttribute("open", "");
    const imageAttributes = vi.spyOn(image, "setAttribute");
    const next = structuredClone(input);
    const activity = next.activities[0]!;
    if (activity.kind !== "tool") throw new Error("Expected tool");
    activity.tool.output = "Screenshot loaded";
    activity.tool.status = "completed";
    activity.tool.completedAt = 3_000;
    next.activities.push({ kind: "assistant", id: "commentary:next", text: "Inspecting the result." });
    client.update(next);

    expect(client.element(".tool-image img")).toBe(image);
    expect(client.element("details")).toBe(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.getAttribute("data-tool-status")).toBe("completed");
    expect(client.element(".tool-content")).toBe(body);
    expect(client.element(".tool-footer")).toBe(footer);
    expect(body.textContent).toContain("Screenshot loaded");
    expect(footer.textContent).toContain("成功");
    expect(imageAttributes).not.toHaveBeenCalled();
    const outputText = client.element(".tool-output").firstChild;
    activity.tool.output += "\nMore information";
    client.update(next);
    expect(client.element(".tool-output").firstChild).toBe(outputText);
    expect(outputText?.textContent).toContain("More information");
  });

  test.each(["update", "patch"] as const)("metadata-only and duplicate %s events do not touch the content DOM or reset scroll", (event) => {
    const input = initialState();
    const tool = input.activities[0];
    if (tool?.kind === "tool") { tool.tool.status = "completed"; tool.tool.completedAt = 2_000; }
    const client = startClient(input);
    const update = (state: TurnViewState) => {
      if (event === "update") client.update(state);
      else client.listeners.get("patch")!({ data: JSON.stringify(renderTurnPreviewPatch(state, new Set(), new Set(), localFileUrl, "zh")) });
    };
    update(input);
    client.flushFrames();
    const content = client.element("#turn-content");
    const details = client.element("details");
    details.setAttribute("open", "");
    const before = content.innerHTML;
    const insert = vi.spyOn(content, "insertBefore");
    const images = client.element(".tool-image img");
    const imageAttributes = vi.spyOn(images, "setAttribute");
    client.scrollTo.mockClear();
    const next = { ...input, totalTokens: 3, totalTokensIncludingCache: 103, cachedInputTokens: 100, modelCallCount: 1 };
    update(next);
    client.flushFrames();
    expect(content.innerHTML).toBe(before);
    expect(insert).not.toHaveBeenCalled();
    expect(imageAttributes).not.toHaveBeenCalled();
    expect(client.element("#turn-metadata").textContent).toContain("非缓存 3 tokens");
    expect(client.element("#turn-metadata").textContent).toContain("总计 103 tokens");
    expect(client.element("#turn-metadata").textContent).toContain("模型调用 1 次");
    expect(client.element("#turn-metadata").textContent).not.toContain("缓存命中");
    update({ ...next, modelProvider: "azure", model: "gpt-test" });
    client.flushFrames();
    const metadata = client.element("#turn-metadata");
    for (const modelCallCount of [2, 2, 3]) {
      update({ ...next, modelProvider: "azure", model: "gpt-test", modelCallCount });
      client.flushFrames();
      expect(metadata.textContent).toContain(`模型调用 ${modelCallCount} 次`);
    }
    expect(metadata.textContent).not.toContain("Provider:");
    expect(Array.from(metadata.querySelectorAll("span"), (span) => span.textContent).slice(1, 3))
      .toEqual(["azure", "gpt-test"]);
    for (const [latestContextTokens, expected] of [[128_456, "128.5K"], [32_000, "32K"], [0, "0"]] as const) {
      update({ ...next, modelProvider: "azure", model: "gpt-test", latestContextTokens,
        totalToolCount: latestContextTokens === 0 ? 0 : 2,
        contextCompactionBeforeTokens: 128_456, contextCompactionAfterTokens: 32_000 });
      client.flushFrames();
      expect(metadata.textContent).toContain(`上下文 ${expected} tokens`);
      const context = Array.from(metadata.children).find((field) => field.textContent === `上下文 ${expected} tokens`);
      expect(context?.nextElementSibling?.textContent).toBe("模型调用 1 次");
      expect(metadata.innerHTML).not.toContain("压缩");
      expect(metadata.textContent).not.toContain("→");
      expect(metadata.textContent).toContain("总计 103 tokens");
      expect(metadata.textContent).toContain("非缓存 3 tokens");
    }
    expect(content.innerHTML).toBe(before);
    expect(client.element("details")).toBe(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(insert).not.toHaveBeenCalled();
    expect(imageAttributes).not.toHaveBeenCalled();
    expect(client.scrollTo).not.toHaveBeenCalled();
  });

  test("inserts and removes sections and activity IDs without detaching the retained image block", () => {
    const input = initialState();
    input.activities.unshift({ kind: "assistant", id: "commentary:old", text: "Earlier thought" });
    const client = startClient(input);
    const timeline = client.element(".timeline");
    const article = client.element(".activity.tool");
    const image = client.element(".tool-image img");
    const next = structuredClone(input);
    next.plan = [{ text: "Read image", status: "in_progress" }];
    next.activitiesTruncated = true;
    next.activities.splice(1, 0, { kind: "assistant", id: "commentary:inserted", text: "Inserted thought" });
    next.assistantText = "Partial answer";
    client.update(next);
    expect(client.element(".timeline")).toBe(timeline);
    expect(client.element(".activity.tool")).toBe(article);
    expect(client.element(".tool-image img")).toBe(image);
    expect(Array.from(timeline.children, (node) => node.getAttribute("data-activity")))
      .toEqual(["commentary:old", "commentary:inserted", "tool:image"]);
    const move = vi.spyOn(timeline, "insertBefore");
    next.plan = [];
    next.activities = next.activities.filter((activity) => activity.id === "tool:image");
    client.update(next);
    expect(timeline.children).toHaveLength(1);
    expect(move).not.toHaveBeenCalled();
    expect(client.element(".tool-image img")).toBe(image);
    expect(client.document.querySelector(".plan")).toBeNull();
  });

  test("reorders existing activities by ID rather than reusing another activity's DOM", () => {
    const input = initialState();
    input.activities.push({ kind: "user", id: "user:extra", text: "Follow-up" });
    const client = startClient(input);
    const article = client.element(".activity.tool");
    const user = client.element('[data-activity="user:extra"]');
    const image = client.element(".tool-image img");
    client.update({ ...input, activities: [...input.activities].reverse() });
    expect(Array.from(client.element(".timeline").children)).toEqual([user, article]);
    expect(client.element(".tool-image img")).toBe(image);
  });

  test("updates only the image whose URL changed and removes images no longer in the snapshot", () => {
    const input = initialState();
    input.prompt = `![Prompt](<${imagePath}>)`;
    const client = startClient(input);
    const promptImage = client.element(".prompt img");
    const oldImage = client.element(".tool-image img");
    const next = structuredClone(input);
    const activity = next.activities[0]!;
    if (activity.kind !== "tool") throw new Error("Expected tool");
    activity.tool.imagePath = path.resolve("preview/new.png");
    client.update(next);
    const newImage = client.element(".tool-image img");
    expect(newImage).not.toBe(oldImage);
    expect(newImage.getAttribute("src")).toContain("new.png");
    expect(oldImage.isConnected).toBe(false);
    expect(client.element(".prompt img")).toBe(promptImage);
    activity.tool.imagePath = undefined;
    client.update(next);
    expect(client.document.querySelector(".tool-image")).toBeNull();
    expect(client.element(".prompt img")).toBe(promptImage);
  });

  test("preserves Markdown images as surrounding text grows and a draft becomes the final answer", () => {
    const input = initialState();
    const markdown = `![Report](<${imagePath}>)`;
    input.assistantText = markdown;
    const client = startClient(input);
    const result = client.element(".result");
    const image = client.element(".result img");
    const paragraph = image.parentNode;
    const imageAttributes = vi.spyOn(image, "setAttribute");
    const next = { ...input, assistantText: `## Report\n\nDescription\n\n${markdown}\n\nAfter image` };
    client.update(next);
    expect(client.element(".result img")).toBe(image);
    expect(image.parentNode).toBe(paragraph);
    client.update({ ...next, status: "completed", completedAt: 4_000, finalResponse: next.assistantText });
    expect(client.element(".result")).toBe(result);
    expect(client.element(".result img")).toBe(image);
    expect(result.classList.contains("final-result")).toBe(true);
    expect(imageAttributes).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("retains expanded file summaries as files change and clears obsolete sections", () => {
    const input = initialState();
    input.fileSummary = [{ path: "one.ts", additions: 1 }];
    input.error = "Temporary error";
    const client = startClient(input);
    const summary = client.element(".files-summary");
    summary.setAttribute("open", "");
    client.update({ ...input, error: undefined, fileSummary: [...input.fileSummary, { path: "two.ts", deletions: 2 }] });
    expect(client.element(".files-summary")).toBe(summary);
    expect(summary.hasAttribute("open")).toBe(true);
    expect(summary.querySelectorAll("li")).toHaveLength(2);
    expect(client.document.querySelector(".error-result")).toBeNull();
    client.update({ ...input, error: undefined, fileSummary: [] });
    expect(client.document.querySelector(".files-summary")).toBeNull();
  });

  test("keeps elapsed timers working and stops live tool timing when the tool completes", () => {
    const input = initialState();
    const client = startClient(input);
    expect(client.setInterval).toHaveBeenCalledWith(expect.any(Function), 1_000);
    const tick = client.setInterval.mock.calls[0]![0] as () => void;
    const duration = client.element("[data-live-tool-duration]");
    tick();
    expect(duration.textContent).toBeTruthy();
    const next = structuredClone(input);
    const activity = next.activities[0]!;
    if (activity.kind !== "tool") throw new Error("Expected tool");
    activity.tool.status = "completed";
    activity.tool.completedAt = 4_000;
    client.update(next);
    expect(client.element(".tool-header-timing")).toBe(duration);
    expect(duration.hasAttribute("data-live-tool-duration")).toBe(false);
    expect(duration.textContent).toBe("3s");
    tick();
    expect(duration.textContent).toBe("3s");
    client.listeners.get("unavailable")!({ data: "" });
    expect(client.element("#turn-live").textContent).toBe("暂时不可用");
  });

  test("keeps a collapsed step collapsed, handles empty timelines, and follows the bottom only when appropriate", () => {
    const input = initialState();
    const client = startClient({ ...input, activities: [] });
    const timeline = client.element(".timeline");
    client.window.scrollY = 1_400;
    client.update(input);
    client.flushFrames();
    expect(client.element(".timeline")).toBe(timeline);
    expect(client.document.querySelector(".empty")).toBeNull();
    expect(client.element("details").hasAttribute("open")).toBe(false);
    expect(client.scrollTo).toHaveBeenLastCalledWith(0, 1_400);
    client.update({ ...input, activities: [] });
    expect(client.element(".timeline")).toBe(timeline);
    expect(client.document.querySelector(".activity.tool")).toBeNull();
    expect(client.element(".empty").textContent).toContain("正在等待");
  });
});

describe("Turn Preview lazy details", () => {
  test("does not request collapsed contents and loads only the expanded tool, preserving it on reopen", async () => {
    const input = initialState();
    const client = startClient(input, true);
    expect(client.document.querySelector(".tool-image")).toBeNull();
    expect(client.requests).toHaveLength(0);
    client.update(input);
    await client.settle();
    expect(client.requests).toHaveLength(0);
    client.toggle("details", true);
    expect(client.element("[data-detail-message]").textContent).toContain("正在加载");
    await client.settle();
    expect(client.requests.map((request) => request.key)).toEqual(["tool:tool:image"]);
    const image = client.element(".tool-image img");
    client.toggle("details", false);
    client.toggle("details", true);
    await client.settle();
    expect(client.requests).toHaveLength(1);
    expect(client.element(".tool-image img")).toBe(image);
  });

  test("loads changed open details but does not fetch for metadata, other activities, or collapsed updates", async () => {
    const input = initialState();
    const client = startClient(input, true);
    client.toggle("details", true);
    await client.settle();
    const image = client.element(".tool-image img");
    client.update({ ...input, totalTokens: 5, activities: [...input.activities, { kind: "assistant", id: "next", text: "Next" }] });
    await client.settle();
    expect(client.requests).toHaveLength(1);
    const next = structuredClone(input);
    const activity = next.activities[0]!;
    if (activity.kind !== "tool") throw new Error("Expected tool");
    activity.tool.output = "A new output";
    client.update(next);
    await client.settle();
    expect(client.requests).toHaveLength(2);
    expect(client.element(".tool-output").textContent).toBe("A new output");
    expect(client.element(".tool-image img")).toBe(image);
    client.toggle("details", false);
    activity.tool.output = "Closed update";
    client.update(next);
    await client.settle();
    expect(client.requests).toHaveLength(2);
    client.toggle("details", true);
    await client.settle();
    expect(client.requests).toHaveLength(3);
    expect(client.element(".tool-output").textContent).toBe("Closed update");
    expect(client.element(".tool-image img")).toBe(image);
  });

  test.each(["completed", "failed", "cancelled"] as const)("keeps %s pages static while permitting detail requests", async (status) => {
    const client = startClient({ ...initialState(), status }, true);
    expect(client.listeners.size).toBe(0);
    expect(client.setInterval).not.toHaveBeenCalled();
    expect(client.requests).toHaveLength(0);
    client.toggle("details", true);
    await client.settle();
    expect(client.requests).toHaveLength(1);
    expect(client.element(".tool-image img")).toBeDefined();
  });

  test("fetches file summaries independently of tool details", async () => {
    const input = { ...initialState(), fileSummary: [{ path: "changed.ts", additions: 5 }] };
    const client = startClient(input, true);
    expect(client.document.querySelector(".file-link")).toBeNull();
    client.toggle(".files-summary", true);
    await client.settle();
    expect(client.requests.map((request) => request.key)).toEqual(["files"]);
    expect(client.element(".files-summary").textContent).toContain("changed.ts");
    expect(client.document.querySelector(".tool-image")).toBeNull();
  });

  test("shows a retry action on failure without repeatedly fetching unchanged failed details", async () => {
    const input = initialState();
    const client = startClient(input, true);
    client.fetchDetail.mockRejectedValueOnce(new Error("offline"));
    client.toggle("details", true);
    await client.settle();
    expect(client.element("[data-detail-message]").textContent).toContain("加载失败");
    expect(client.element("[data-detail-body]").hasAttribute("aria-busy")).toBe(false);
    client.update({ ...input, totalTokens: 50 });
    await client.settle();
    expect(client.fetchDetail).toHaveBeenCalledTimes(1);
    client.element<HTMLButtonElement>("[data-detail-message] button").click();
    await client.settle();
    expect(client.fetchDetail).toHaveBeenCalledTimes(2);
    expect(client.element(".tool-image img")).toBeDefined();
    expect(client.element("[data-detail-message]").textContent).toBe("");
  });

  test("discards an older response and fetches the latest revision after a concurrent update", async () => {
    const input = initialState();
    const client = startClient(input, true);
    const old = renderTurnPreviewDetail(input, "tool:tool:image", localFileUrl)!;
    let resolve!: (value: { ok: boolean; status: number; json: () => Promise<typeof old> }) => void;
    client.fetchDetail.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    client.toggle("details", true);
    const next = structuredClone(input);
    const activity = next.activities[0]!;
    if (activity.kind !== "tool") throw new Error("Expected tool");
    activity.tool.output = "Latest output";
    client.update(next);
    expect(client.fetchDetail).toHaveBeenCalledTimes(1);
    resolve({ ok: true, status: 200, json: async () => old });
    await client.settle();
    expect(client.fetchDetail).toHaveBeenCalledTimes(2);
    expect(client.element(".tool-output").textContent).toBe("Latest output");
  });

  test("aborts a collapsed request and does not insert its images if the response arrives late", async () => {
    const input = initialState();
    const client = startClient(input, true);
    const detail = renderTurnPreviewDetail(input, "tool:tool:image", localFileUrl)!;
    let resolve!: (value: { ok: boolean; status: number; json: () => Promise<typeof detail> }) => void;
    let signal!: AbortSignal;
    client.fetchDetail.mockImplementationOnce((_url, options) => {
      signal = options.signal;
      return new Promise((done) => { resolve = done; });
    });
    client.toggle("details", true);
    client.toggle("details", false);
    expect(signal.aborted).toBe(true);
    resolve({ ok: true, status: 200, json: async () => detail });
    await client.settle();
    expect(client.document.querySelector(".tool-image")).toBeNull();
    client.toggle("details", true);
    await client.settle();
    expect(client.element(".tool-image img")).toBeDefined();
  });
});
