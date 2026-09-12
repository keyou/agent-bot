import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Token } from "markdown-it";

export function isFileUrl(value: string): boolean {
  return /^file:/iu.test(value);
}

export function rewriteMarkdownFileLinks(
  tokens: Token[],
  markdownPath: string | undefined,
  createPreviewUrl: (filePath: string) => URL | undefined,
): void {
  for (const token of tokens) {
    const attribute = token.type === "link_open" ? "href" : token.type === "image" ? "src" : undefined;
    const target = attribute ? token.attrGet(attribute) : null;
    if (attribute && typeof target === "string" && target) {
      const local = resolveLocalTarget(target, markdownPath);
      if (local) {
        const url = createPreviewUrl(local.filePath);
        if (url) {
          url.hash = local.hash;
          if (token.type === "image") url.searchParams.set("raw", "1");
          token.attrSet(attribute, url.toString());
        } else {
          token.attrs = token.attrs?.filter(([name]) => name !== attribute) ?? null;
        }
      } else if (isFileUrl(target)) {
        // File URLs are accepted by the parser only to convert them to signed HTTP URLs.
        token.attrs = token.attrs?.filter(([name]) => name !== attribute) ?? null;
      }
    }
    if (token.children) rewriteMarkdownFileLinks(token.children, markdownPath, createPreviewUrl);
  }
}

function resolveLocalTarget(target: string, markdownPath: string | undefined): { filePath: string; hash: string } | undefined {
  if (/^(?:#|\?|\/\/)/u.test(target)) return undefined;
  const windows = process.platform === "win32";
  const normalized = windows ? target.replace(/%5c/giu, "/").replaceAll("\\", "/") : target;
  const drivePath = /^\/?[a-z]:\//iu.test(normalized);
  const relativeFileWithLine = /^[^:/]+\.[^:/]+:\d+(?::\d+)?(?:#.*)?$/u.test(normalized);
  if (!drivePath && !isFileUrl(normalized) && !relativeFileWithLine && /^[a-z][a-z\d+.-]*:/iu.test(normalized)) return undefined;
  const pathEnd = normalized.search(/[?#]/u);
  const pathTarget = pathEnd < 0 ? normalized : normalized.slice(0, pathEnd);
  const reference = /:(\d+)(?::\d+)?$/u.exec(pathTarget);
  const withoutReference = reference
    ? normalized.slice(0, reference.index) + normalized.slice(reference.index + reference[0].length)
    : normalized;
  if (drivePath && !windows) return undefined;
  if (!markdownPath && !drivePath && !isFileUrl(normalized) && !path.isAbsolute(normalized)) return undefined;

  try {
    const url = drivePath
      ? new URL(`file:///${withoutReference.replace(/^\//u, "")}`)
      : new URL(withoutReference, markdownPath ? pathToFileURL(markdownPath) : "file:///");
    if (url.protocol !== "file:") return undefined;
    const filePath = fileURLToPath(url);
    if (!path.isAbsolute(filePath) || /[\x00-\x1f\x7f]/u.test(filePath)) return undefined;
    const line = /^#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/u.exec(url.hash)?.[1]
      ?? (url.hash ? undefined : reference?.[1]);
    const hash = line && Number.isSafeInteger(Number(line)) && Number(line) > 0
      ? `#L${Number(line)}`
      : url.hash;
    return { filePath: path.resolve(filePath), hash };
  } catch {
    return undefined;
  }
}
