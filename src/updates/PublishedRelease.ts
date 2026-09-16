import { z } from "zod";
import { AGENT_BOT_PACKAGE_NAME } from "../cli/SelfUpdater.js";

export const stableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);

export async function readLatestStableVersion(): Promise<string> {
  const text = await fetchText(`https://registry.npmjs.org/${encodeURIComponent(AGENT_BOT_PACKAGE_NAME)}/latest`, 256_000);
  return z.object({ version: stableVersionSchema }).parse(JSON.parse(text)).version;
}

export async function readReleaseNotes(version: string): Promise<string> {
  stableVersionSchema.parse(version);
  const changelog = await fetchText(
    `https://raw.githubusercontent.com/keyou/agent-bot/v${version}/CHANGELOG.md`, 2_000_000,
  );
  return extractReleaseNotes(changelog, version);
}

export function extractReleaseNotes(changelog: string, version: string): string {
  const sections = changelog.split(/^## /mu).slice(1);
  const section = sections.find((value) => value.split(/\r?\n/u, 1)[0]?.startsWith(`[${version}]`));
  const notes = section?.includes("\n") ? section.slice(section.indexOf("\n") + 1).trim() : undefined;
  if (!notes) throw new Error(`Release notes are unavailable for Agent Bot ${version}.`);
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
