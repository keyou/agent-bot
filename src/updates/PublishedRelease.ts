import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AGENT_BOT_PACKAGE_NAME } from "../cli/SelfUpdater.js";

export const stableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);

export async function readLatestStableVersion(): Promise<string> {
  const text = await fetchText(`https://registry.npmjs.org/${encodeURIComponent(AGENT_BOT_PACKAGE_NAME)}/latest`, 256_000);
  return z.object({ version: stableVersionSchema }).parse(JSON.parse(text)).version;
}

export const publishedVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/u);

export interface PublishedRelease {
  channel: "latest" | "alpha";
  version?: string;
  notes?: string;
  error?: string;
}

export async function readPublishedReleases(): Promise<PublishedRelease[]> {
  return Promise.all((["latest", "alpha"] as const).map(async (channel): Promise<PublishedRelease> => {
    let version: string;
    try {
      const text = await fetchText(`https://registry.npmjs.org/${encodeURIComponent(AGENT_BOT_PACKAGE_NAME)}/${channel}`, 256_000);
      version = z.object({ version: channel === "latest" ? stableVersionSchema : publishedVersionSchema }).parse(JSON.parse(text)).version;
      if (channel === "alpha" && !version.includes("-alpha.")) throw new Error("The alpha tag does not point to an Alpha release.");
    } catch (error) {
      return { channel, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      return { channel, version, notes: await readReleaseNotes(version) };
    } catch {
      return { channel, version, notes: `更新简介暂时无法读取。[查看更新日志](https://github.com/keyou/agent-bot/releases/tag/v${version})` };
    }
  }));
}

export async function readReleaseNotes(version: string): Promise<string> {
  publishedVersionSchema.parse(version);
  // Published tags are immutable; bundled translations can cover older releases.
  const bundled = await readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8").catch(() => "");
  const chinese = chineseReleaseNotes(releaseNotesSection(bundled, version) ?? "");
  if (chinese) return boundReleaseNotes(chinese, version);
  const changelog = await fetchText(
    `https://raw.githubusercontent.com/keyou/agent-bot/v${version}/CHANGELOG.md`, 2_000_000,
  );
  return extractReleaseNotes(changelog, version);
}

export function extractReleaseNotes(changelog: string, version: string): string {
  const notes = releaseNotesSection(changelog, version);
  if (!notes) throw new Error(`Release notes are unavailable for Agent Bot ${version}.`);
  return boundReleaseNotes(chineseReleaseNotes(notes) ?? notes, version);
}

function releaseNotesSection(changelog: string, version: string): string | undefined {
  const sections = changelog.split(/^## /mu).slice(1);
  const section = sections.find((value) => value.split(/\r?\n/u, 1)[0]?.startsWith(`[${version}]`));
  return section?.includes("\n") ? section.slice(section.indexOf("\n") + 1).trim() : undefined;
}

function chineseReleaseNotes(notes: string): string | undefined {
  const sections = notes.split(/^###\s+/mu).slice(1);
  const section = sections.find((value) => /^(?:中文|简体中文|Chinese|zh-CN)\s*$/iu.test(value.split(/\r?\n/u, 1)[0] ?? ""));
  return section?.includes("\n") ? section.slice(section.indexOf("\n") + 1).trim() || undefined : undefined;
}

function boundReleaseNotes(notes: string, version: string): string {
  return notes.length > 4_000 ? `${notes.slice(0, 3_900)}\n\n[完整更新日志](https://github.com/keyou/agent-bot/releases/tag/v${version})` : notes;
}

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error(`Release request failed: HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Release response exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
}
