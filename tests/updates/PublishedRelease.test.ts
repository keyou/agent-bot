import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { extractReleaseNotes, readLatestStableVersion, readReleaseNotes, readPublishedReleases } from "../../src/updates/PublishedRelease.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
beforeEach(() => vi.mocked(readFile).mockResolvedValue(""));
afterEach(() => vi.unstubAllGlobals());

describe("published stable releases", () => {
  test("queries only the latest tag, without enumerating package history", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: "0.1.23" })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readLatestStableVersion()).resolves.toBe("0.1.23");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://registry.npmjs.org/%40keyou007%2Fagent-bot/latest", { signal: expect.any(AbortSignal) },
    );
  });

  test("rejects a prerelease even if it was mistakenly published under latest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "0.1.23-alpha.1" }))));
    await expect(readLatestStableVersion()).rejects.toThrow();
  });

  test.each(["0.1.23", "0.1.24-alpha.0", "0.1.24-alpha.1", "0.1.24-alpha.2"])("uses bundled Chinese notes for the existing release %s without a network request", async (version) => {
    vi.mocked(readFile).mockResolvedValue(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const notes = await readReleaseNotes(version);
    expect(notes).toMatch(/[\u4e00-\u9fff]/u);
    expect(notes).not.toContain("### English");
    expect(notes).not.toContain("### 中文");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["中文", "简体中文", "Chinese", "zh-CN"])("selects %s before truncating and preserves nested Markdown", (heading) => {
    const chinese = "#### 修复\r\n- 保留 `命令` 和 [链接](https://example.com)。";
    expect(extractReleaseNotes(`## [0.1.24]\r\n### English\r\n${"English notes ".repeat(1000)}\r\n### ${heading}\r\n${chinese}\r\n### English\r\n- Other`, "0.1.24")).toBe(chinese);
  });

  test("falls back to original notes when the Chinese section is empty or absent", () => {
    const notes = "### 中文\n\n### English\n- Fix";
    expect(extractReleaseNotes(`## [0.1.24]\n${notes}`, "0.1.24")).toBe(notes);
    expect(extractReleaseNotes("## [0.1.24]\n- 原有中文说明", "0.1.24")).toBe("- 原有中文说明");
  });

  test("uses exact-tag Chinese notes when bundled translations are missing or unreadable", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("missing bundled changelog"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("## [0.1.24]\n### English\n- English\n### 中文\n- 远程中文")));
    await expect(readReleaseNotes("0.1.24")).resolves.toBe("- 远程中文");
    vi.mocked(readFile).mockResolvedValue("## [0.1.23]\n### 中文\n- 旧版中文\n## [0.1.24]\n- Bundled English");
    await expect(readReleaseNotes("0.1.24")).resolves.toBe("- 远程中文");
  });

  test("reads notes from the exact published tag", async () => {
    const fetchMock = vi.fn(async () => new Response("# Changelog\n\n## [0.1.23]\n\n### Added\n- New feature\n\n## [0.1.22]\n- Old feature"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readReleaseNotes("0.1.23")).resolves.toBe("### Added\n- New feature");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://raw.githubusercontent.com/keyou/agent-bot/v0.1.23/CHANGELOG.md", { signal: expect.any(AbortSignal) },
    );
  });

  test("does not substitute unrelated notes and bounds long notes for Feishu", () => {
    expect(() => extractReleaseNotes("## [0.1.230]\n- Unrelated", "0.1.23")).toThrow("unavailable");
    expect(() => extractReleaseNotes("## [0.1.23]", "0.1.23")).toThrow("unavailable");
    const notes = extractReleaseNotes(`## [0.1.23]\n${"x".repeat(10_000)}`, "0.1.23");
    expect(notes.length).toBeLessThanOrEqual(4_000);
    expect(notes).toContain("/releases/tag/v0.1.23");
  });

  test("rejects failed and oversized responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
    await expect(readLatestStableVersion()).rejects.toThrow("503");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(300_000))));
    await expect(readLatestStableVersion()).rejects.toThrow("size limit");
  });
});


describe("manual release choices", () => {
  test("loads stable and Alpha tags with each exact version's notes", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/latest")) return new Response(JSON.stringify({ version: "0.1.24" }));
      if (url.endsWith("/alpha")) return new Response(JSON.stringify({ version: "0.1.25-alpha.3" }));
      return new Response("## [0.1.25-alpha.3]\n- Alpha feature\n## [0.1.24]\n- Stable fix");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(readPublishedReleases()).resolves.toEqual([
      { channel: "latest", version: "0.1.24", notes: "- Stable fix" },
      { channel: "alpha", version: "0.1.25-alpha.3", notes: "- Alpha feature" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v0.1.25-alpha.3/CHANGELOG.md"), expect.any(Object));
  });

  test("keeps a valid channel when the other fails and missing notes do not block explicit updates", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/latest")
      ? new Response(JSON.stringify({ version: "0.1.24" })) : new Response("unavailable", { status: 404 })));
    const releases = await readPublishedReleases();
    expect(releases[0]).toMatchObject({ channel: "latest", version: "0.1.24", notes: expect.stringContaining("releases/tag/v0.1.24") });
    expect(releases[1]).toMatchObject({ channel: "alpha", error: expect.stringContaining("404") });
  });

  test("rejects wrong-channel and unsafe versions before fetching release notes", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ version: url.endsWith("/latest") ? "0.1.24-alpha.1" : "../../evil" })));
    vi.stubGlobal("fetch", fetchMock);
    const releases = await readPublishedReleases();
    expect(releases.every((release) => release.error && !release.version)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
