import { afterEach, describe, expect, test, vi } from "vitest";
import { extractReleaseNotes, readLatestStableVersion, readReleaseNotes } from "../../src/updates/PublishedRelease.js";

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
