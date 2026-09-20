import path from "node:path";

interface FenceState {
  indent: string;
  marker: "`" | "~";
  length: number;
  normalizeIndent: boolean;
}

const FENCE_OPENER = /^([ \t]*)((?:`{3,})|(?:~{3,}))(.*)$/;
const MARKDOWN_LINK = /(!?)\[([^\]\r\n]*)\]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;
const LOCAL_FILE_LINE_REFERENCE = /(:\d+(?::\d+)?)$/;
const LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".bmp", ".ico"]);

export type LocalFileUrlResolver = (filePath: string, reference?: string) => string | undefined;

export function normalizeFeishuMarkdown(
  markdown: string,
  projectCwd?: string,
  localFileUrl?: LocalFileUrlResolver,
): string {
  const lines = markdown.match(/[^\r\n]*(?:\r\n|\n)|[^\r\n]+$/g) ?? [];
  let fence: FenceState | undefined;

  return lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;

    if (!fence) {
      const opener = FENCE_OPENER.exec(body);
      if (!opener?.[2]) return `${includeLocalFileLineReferences(body, projectCwd, localFileUrl)}${ending}`;

      const indent = opener[1] ?? "";
      const delimiter = opener[2];
      fence = {
        indent,
        marker: delimiter[0] as "`" | "~",
        length: delimiter.length,
        normalizeIndent: indent.length > 0,
      };
      return `${fence.normalizeIndent ? body.slice(indent.length) : body}${ending}`;
    }

    const normalizedBody = fence.normalizeIndent && body.startsWith(fence.indent)
      ? body.slice(fence.indent.length)
      : body;
    if (isFenceCloser(normalizedBody, fence)) fence = undefined;
    return `${normalizedBody}${ending}`;
  }).join("");
}

function includeLocalFileLineReferences(
  markdown: string,
  projectCwd?: string,
  localFileUrl?: LocalFileUrlResolver,
): string {
  const codeSpans = inlineCodeSpans(markdown);
  return markdown.replace(MARKDOWN_LINK, (link, imageMarker: string, label: string, rawTarget: string, offset: number) => {
    if (imageMarker || codeSpans.some(([start, end]) => offset >= start && offset < end)) return link;

    const target = unwrapMarkdownTarget(rawTarget.trim());
    if (!isLocalFileTarget(target)) {
      const relative = resolveRelativeFileTarget(target, projectCwd);
      if (!relative || isLocalImageTarget(relative.filePath)) return link;
      const viewerUrl = localFileUrl?.(relative.filePath, relative.reference);
      if (!viewerUrl) {
        const displayPath = displayAbsolutePath(relative.filePath) + (relative.reference ?? "");
        return label ? `${label}(${inlineCode(displayPath)})` : inlineCode(displayPath);
      }
      const url = new URL(viewerUrl);
      if (relative.hash) url.hash = relative.hash;
      const normalizedLabel = relative.reference && !label.endsWith(relative.reference)
        ? `${label}${relative.reference}` : label;
      return `[${normalizedLabel}](${url.toString()})`;
    }
    if (isLocalImageTarget(target)) return link;

    const reference = LOCAL_FILE_LINE_REFERENCE.exec(target)?.[1];
    const targetWithoutReference = reference ? target.slice(0, -reference.length) : target;
    const filePath = localFilePath(targetWithoutReference);
    const viewerUrl = filePath ? localFileUrl?.(filePath, reference) : undefined;
    const projectPathLabel = projectCwd ? projectFilePathLabel(target, projectCwd, reference) : undefined;
    if (!projectPathLabel) {
      const normalizedLabel = reference && !label.endsWith(reference) ? `${label}${reference}` : label;
      if (viewerUrl) return `[${normalizedLabel}](${viewerUrl})`;
      return normalizedLabel === label ? link : `[${normalizedLabel}](${rawTarget})`;
    }

    if (projectPathLabel === label) return viewerUrl ? `[${label}](${viewerUrl})` : link;
    if (reference && projectPathLabel === `${label}${reference}`) {
      return `[${projectPathLabel}](${viewerUrl ?? rawTarget})`;
    }

    if (!label) return viewerUrl ? `[${projectPathLabel}](${viewerUrl})` : inlineCode(projectPathLabel);
    return viewerUrl
      ? `[${label}](${viewerUrl})(${inlineCode(projectPathLabel)})`
      : `${label}(${inlineCode(projectPathLabel)})`;
  });
}

interface RelativeFileTarget {
  filePath: string;
  reference?: string;
  hash?: string;
}

function resolveRelativeFileTarget(target: string, projectCwd?: string): RelativeFileTarget | undefined {
  if (!projectCwd || !target || /^(?:#|\?|\/\/)/u.test(target)) return undefined;
  const pathApi = usesWindowsPaths(projectCwd) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(projectCwd)) return undefined;
  const suffixStart = target.search(/[?#]/u);
  const pathTarget = suffixStart < 0 ? target : target.slice(0, suffixStart);
  const lineSuffix = LOCAL_FILE_LINE_REFERENCE.exec(pathTarget)?.[1];
  // A basename with a line suffix (report.md:12) is a file, not a URI scheme.
  const fileWithLine = /^[^:/\\]+\.[^:/\\]+:\d+(?::\d+)?$/u.test(pathTarget);
  if (!fileWithLine && /^[a-z][a-z\d+.-]*:/iu.test(target)) return undefined;
  const encodedPath = lineSuffix ? pathTarget.slice(0, -lineSuffix.length) : pathTarget;
  try {
    const decodedPath = decodeURIComponent(encodedPath);
    if (!decodedPath || /[\x00-\x1f\x7f]/u.test(decodedPath)
      || pathApi.isAbsolute(decodedPath) || /^[a-z]:/iu.test(decodedPath)) return undefined;
    const filePath = pathApi.resolve(projectCwd, decodedPath);
    const hashStart = target.indexOf("#");
    const hash = hashStart < 0 ? undefined : new URL(target.slice(hashStart), "http://localhost/").hash;
    const hashLine = /^#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/u.exec(hash ?? "")?.[1];
    const validHashLine = hashLine && Number.isSafeInteger(Number(hashLine)) && Number(hashLine) > 0;
    return {
      filePath,
      reference: validHashLine ? `:${Number(hashLine)}` : hash ? undefined : lineSuffix,
      hash: validHashLine ? `#L${Number(hashLine)}` : hash,
    };
  } catch {
    return undefined;
  }
}

function inlineCodeSpans(markdown: string): Array<[number, number]> {
  const runs = [...markdown.matchAll(/`+/gu)];
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < runs.length; index += 1) {
    const opener = runs[index]!;
    const backslashes = /\\*$/u.exec(markdown.slice(0, opener.index))?.[0].length ?? 0;
    if (backslashes % 2 !== 0) continue;
    const closing = runs.findIndex((run, candidate) => candidate > index && run[0].length === opener[0].length);
    if (closing < 0) continue;
    const closer = runs[closing]!;
    spans.push([opener.index, closer.index + closer[0].length]);
    index = closing;
  }
  return spans;
}

function projectFilePathLabel(
  target: string,
  projectCwd: string,
  reference: string | undefined,
): string | undefined {
  const targetWithoutReference = reference ? target.slice(0, -reference.length) : target;
  const filePath = localFilePath(targetWithoutReference);
  if (!filePath) return undefined;
  if (!isInsideProject(filePath, projectCwd)) {
    return `${displayAbsolutePath(filePath)}${reference ?? ""}`;
  }

  const pathApi = usesWindowsPaths(filePath, projectCwd) ? path.win32 : path.posix;
  const parsed = pathApi.parse(filePath);
  return `${parsed.base}${reference ?? ""}`;
}

function localFilePath(target: string): string | undefined {
  if (!/^file:\/\//i.test(target)) return normalizeWindowsDrivePrefix(target);

  let value = target.slice("file://".length);
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep malformed percent escapes visible instead of dropping the link.
  }
  if (/^\/[a-z]:[\\/]/i.test(value)) return value.slice(1);
  if (value.startsWith("/")) return value;
  return `//${value}`;
}

function normalizeWindowsDrivePrefix(value: string): string {
  return /^\/[a-z]:[\\/]/i.test(value) ? value.slice(1) : value;
}

function isInsideProject(filePath: string, projectCwd: string): boolean {
  const pathApi = usesWindowsPaths(filePath, projectCwd) ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(projectCwd), pathApi.resolve(filePath));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function displayAbsolutePath(filePath: string): string {
  if (!usesWindowsPaths(filePath)) return path.posix.normalize(filePath);
  return path.win32.normalize(filePath);
}

function inlineCode(value: string): string {
  const longestDelimiter = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestDelimiter + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function usesWindowsPaths(...values: string[]): boolean {
  return values.some((value) => /^\/?[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value));
}

function isLocalImageTarget(target: string): boolean {
  const reference = LOCAL_FILE_LINE_REFERENCE.exec(target)?.[1];
  const targetWithoutReference = reference ? target.slice(0, -reference.length) : target;
  const filePath = localFilePath(targetWithoutReference);
  if (!filePath) return false;
  const pathApi = usesWindowsPaths(filePath) ? path.win32 : path.posix;
  return LOCAL_IMAGE_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase());
}

function unwrapMarkdownTarget(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function isLocalFileTarget(target: string): boolean {
  return /^file:\/\//i.test(target)
    || /^\/?[a-z]:[\\/]/i.test(target)
    || /^\\\\/.test(target)
    || /^\/(?!\/)/.test(target);
}

function isFenceCloser(line: string, fence: FenceState): boolean {
  const match = /^[ \t]*(`+|~+)[ \t]*$/.exec(line);
  const delimiter = match?.[1];
  return delimiter !== undefined
    && delimiter[0] === fence.marker
    && delimiter.length >= fence.length;
}
