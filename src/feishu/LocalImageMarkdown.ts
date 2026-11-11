import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const MARKDOWN_LINK = /(!?)\[([^\]\r\n]*)\]\((<[^>\r\n]+>|[^)\r\n]+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\)/g;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp", ".ico"]);
const markdownParser = new MarkdownIt();

export async function renderMarkdownWithLocalImages(
  markdown: string,
  uploadImage: (filePath: string) => Promise<string>,
  onUploadError: (error: unknown, filePath: string) => void,
): Promise<Array<Record<string, unknown>>> {
  const elements: Array<Record<string, unknown>> = [];
  const uploads = new Map<string, Promise<string>>();
  const protectedRanges = markdown.includes("[") ? markdownCodeRanges(markdown) : [];
  let cursor = 0;

  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const matchIndex = match.index;
    const rawTarget = match[3];
    if (matchIndex === undefined || rawTarget === undefined
      || escapedAt(markdown, matchIndex)
      || protectedRanges.some(([start, end]) => matchIndex >= start && matchIndex < end)) continue;
    const target = markdownTarget(rawTarget);
    const filePath = localImagePath(target);
    const imageSyntax = match[1] === "!";
    if (imageSyntax && /^img_[a-z\d_-]+$/iu.test(target)) continue;
    const label = match[2]?.trim() || path.basename(unwrapTarget(target.trim()));
    if (!filePath) {
      if (!imageSyntax) continue;
      appendMarkdown(elements, markdown.slice(cursor, matchIndex));
      appendMarkdown(elements, unsupportedImageFallback(label, target));
      cursor = matchIndex + match[0].length;
      continue;
    }

    appendMarkdown(elements, markdownBeforeLocalImage(markdown, cursor, matchIndex, matchIndex + match[0].length));
    try {
      let upload = uploads.get(filePath);
      if (!upload) {
        upload = uploadImage(filePath);
        uploads.set(filePath, upload);
      }
      const imageKey = await upload;
      elements.push({
        tag: "img",
        img_key: imageKey,
        alt: { tag: "plain_text", content: label },
        title: { tag: "plain_text", content: label },
        mode: "fit_horizontal",
        preview: true,
      });
    } catch (error) {
      onUploadError(error, filePath);
      appendMarkdown(elements, `图片上传失败：${label}`);
    }
    cursor = matchIndex + match[0].length;
  }

  appendMarkdown(elements, markdown.slice(cursor));
  return elements;
}

function markdownCodeRanges(markdown: string): Array<[number, number]> {
  const lineOffsets = [0, ...[...markdown.matchAll(/\r?\n/gu)].map(match => match.index + match[0].length)];
  const ranges: Array<[number, number]> = [];
  for (const token of markdownParser.parse(markdown, {})) {
    if (!token.map) continue;
    const start = lineOffsets[token.map[0]] ?? markdown.length;
    const end = lineOffsets[token.map[1]] ?? markdown.length;
    if (token.type === "fence" || token.type === "code_block") {
      ranges.push([start, end]);
    } else if (token.type === "inline") {
      const text = markdown.slice(start, end);
      const runs = [...text.matchAll(/`+/gu)];
      for (let index = 0; index < runs.length; index += 1) {
        const opener = runs[index]!;
        if (escapedAt(text, opener.index)) continue;
        const closing = runs.findIndex((run, candidate) => candidate > index && run[0].length === opener[0].length);
        if (closing < 0) continue;
        const closer = runs[closing]!;
        ranges.push([start + opener.index, start + closer.index + closer[0].length]);
        index = closing;
      }
    }
  }
  return ranges;
}

function escapedAt(text: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && text[--offset] === "\\") slashes += 1;
  return slashes % 2 !== 0;
}

function markdownTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  const parsed = markdownParser.helpers.parseLinkDestination(target, 0, target.length);
  if (parsed.ok) {
    const suffix = target.slice(parsed.pos).trim();
    if (!suffix) return parsed.str;
    const title = markdownParser.helpers.parseLinkTitle(suffix, 0, suffix.length);
    if (title.ok && title.pos === suffix.length) return parsed.str;
  }
  return unwrapTarget(target);
}

function localImagePath(rawTarget: string): string | undefined {
  const target = unwrapTarget(rawTarget.trim());
  let candidate: string;
  try {
    candidate = target.startsWith("file://") ? fileURLToPath(target) : decodeURIComponent(target);
  } catch {
    return undefined;
  }
  if (/^\/[a-z]:[\\/]/i.test(candidate)) candidate = candidate.slice(1);
  if (!path.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) return undefined;
  const resolved = path.resolve(candidate);
  if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return undefined;
  try {
    return fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function unwrapTarget(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function unsupportedImageFallback(label: string, rawTarget: string): string {
  const target = unwrapTarget(rawTarget.trim());
  return /^https?:\/\//i.test(target)
    ? `[${label || "图片"}](${target})`
    : `图片不可用：${label || "本地图片"}`;
}

function markdownBeforeLocalImage(
  markdown: string,
  cursor: number,
  matchStart: number,
  matchEnd: number,
): string {
  const lineStart = markdown.lastIndexOf("\n", matchStart - 1) + 1;
  if (lineStart < cursor) return markdown.slice(cursor, matchStart);

  const lineEndIndex = markdown.indexOf("\n", matchEnd);
  const lineEnd = lineEndIndex === -1 ? markdown.length : lineEndIndex;
  const beforeLink = markdown.slice(lineStart, matchStart);
  const afterLink = markdown.slice(matchEnd, lineEnd);
  const standaloneListMarker = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+$/u.test(beforeLink);
  if (!standaloneListMarker || !/^[ \t]*\r?$/u.test(afterLink)) {
    return markdown.slice(cursor, matchStart);
  }

  return markdown.slice(cursor, lineStart);
}

function appendMarkdown(elements: Array<Record<string, unknown>>, content: string): void {
  if (!content.trim()) return;
  elements.push({ tag: "markdown", content });
}
