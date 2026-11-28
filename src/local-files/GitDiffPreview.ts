import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_DIFF_LINES = 10_000;
const MAX_MERGED_LINES = 20_000;

export async function readGitFileDiff(filePath: string): Promise<string | undefined> {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.size > 2 * 1024 * 1024)) return undefined;
    let cwd = path.dirname(filePath);
    while (!fs.existsSync(cwd)) {
      const parent = path.dirname(cwd);
      if (parent === cwd) return undefined;
      cwd = parent;
    }
    const signal = AbortSignal.timeout(4000);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    for (const name of Object.keys(env)) {
      if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/u.test(name)) delete env[name];
    }
    const args = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"];
    const git = async (command: string[]): Promise<{ stdout: string; code: number }> => {
      try {
        const result = await runFile("git", [...args, ...command], { cwd, env, signal, windowsHide: true, maxBuffer: MAX_DIFF_BYTES, encoding: "buffer" });
        return { stdout: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout), code: 0 };
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: Buffer };
        if (typeof failure.code === "number") return { stdout: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(failure.stdout), code: failure.code };
        throw error;
      }
    };
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code !== 0 && head.code !== 1) return undefined;
    // Diff must not execute repository clean/process filters or filesystem monitors.
    const filters = await git(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"]);
    if (filters.code !== 0 && filters.code !== 1) return undefined;
    const names = filters.stdout.split("\0").filter(Boolean);
    if (names.length > 128 || names.some((name) => !/^filter\.[^\r\n]+\.(?:clean|process|required)$/u.test(name))) return undefined;
    for (const name of names) args.push("-c", `${name}=${name.endsWith(".required") ? "false" : ""}`);
    const relative = path.relative(cwd, filePath).split(path.sep).join("/");
    const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3"];
    const result = head.code === 0
      ? await git([...options, "HEAD", "--", relative])
      : stat ? await git([...options, "--no-index", "--", "/dev/null", relative]) : undefined;
    if (!result || result.code > 1 || !result.stdout.startsWith("diff --git ")) return undefined;
    if (result.stdout.includes("\0") || /^Binary files /mu.test(result.stdout) || result.stdout.split("\n").length > MAX_DIFF_LINES) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

type DiffLine = { kind: "context" | "addition" | "deletion"; text: string; oldNumber?: number; newNumber?: number };

export function renderGitFileDiff(diff: string, currentText: string): string | undefined {
  const source = splitLines(currentText.replace(/^\uFEFF/u, ""));
  if (source.length > MAX_MERGED_LINES) return undefined;
  const lines = splitLines(diff);
  if (!lines[0]?.startsWith("diff --git ")) return undefined;
  const rows: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let inHunks = false;
  const append = (kind: DiffLine["kind"], text: string): boolean => {
    if (kind !== "deletion") {
      if (newLine === 1) text = text.replace(/^\uFEFF/u, "");
      if (source[newLine - 1] !== text) return false;
    }
    rows.push({ kind, text, ...(kind !== "addition" ? { oldNumber: oldLine++ } : {}),
      ...(kind !== "deletion" ? { newNumber: newLine++ } : {}) });
    return rows.length <= MAX_MERGED_LINES;
  };
  // Git identifies edits; fill the gaps from the complete current file, checking hunk coordinates and text.
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
    if (!hunk) {
      if (line === "\\ No newline at end of file") continue;
      if (inHunks || line.startsWith("@@") || line.startsWith("diff --git ") || line === "GIT binary patch") return undefined;
      continue;
    }
    inHunks = true;
    let oldRemaining = Number(hunk[2] ?? 1);
    let newRemaining = Number(hunk[4] ?? 1);
    const oldStart = Number(hunk[1]) + (oldRemaining === 0 ? 1 : 0);
    const newStart = Number(hunk[3]) + (newRemaining === 0 ? 1 : 0);
    if (![oldStart, newStart, oldRemaining, newRemaining].every(Number.isSafeInteger)
      || oldStart < oldLine || newStart < newLine || newStart > source.length + 1
      || oldStart - oldLine !== newStart - newLine) return undefined;
    while (newLine < newStart) if (!append("context", source[newLine - 1]!)) return undefined;
    while (oldRemaining > 0 || newRemaining > 0) {
      const entry = lines[++index];
      if (entry === "\\ No newline at end of file") continue;
      if (entry === undefined) return undefined;
      const marker = entry[0];
      if (marker !== " " && marker !== "+" && marker !== "-") return undefined;
      if (marker !== "+" && --oldRemaining < 0) return undefined;
      if (marker !== "-" && --newRemaining < 0) return undefined;
      if (!append(marker === "+" ? "addition" : marker === "-" ? "deletion" : "context", entry.slice(1))) return undefined;
    }
  }
  while (newLine <= source.length) if (!append("context", source[newLine - 1]!)) return undefined;
  const content = rows.map((row) => {
    const id = row.newNumber !== undefined ? `L${row.newNumber}` : `D${row.oldNumber}`;
    const oldNumber = `<span class="diff-number" aria-hidden="true">${row.oldNumber ?? ""}</span>`;
    const newNumber = row.newNumber !== undefined
      ? `<a class="diff-number" href="#${id}" aria-label="Line ${row.newNumber}">${row.newNumber}</a>`
      : '<span class="diff-number" aria-hidden="true"></span>';
    const marker = row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : " ";
    return `<span class="line diff-${row.kind}" id="${id}">${oldNumber}${newNumber}<span class="diff-marker" aria-hidden="true">${marker}</span><span class="diff-text">${escapeHtml(row.text)}</span></span>`;
  }).join("");
  return `<pre class="code git-diff" aria-label="Git diff"><code>${content}</code></pre>`;
}

function splitLines(value: string): string[] {
  return value === "" ? [] : value.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export const GIT_DIFF_PREVIEW_CSS = `
.git-diff .line { display:flex; width:max-content; min-width:100%; padding-right:16px; }
.git-diff .diff-number { display:inline-block; flex:0 0 4.5em; width:4.5em; padding:0 10px; text-align:right; color:#6e7781; border-right:1px solid #d8dee4; text-decoration:none; user-select:none; }
.git-diff .diff-marker { flex:0 0 2em; width:2em; text-align:center; user-select:none; }
.git-diff .diff-text { white-space:pre; }
.git-diff .diff-addition { background:#dafbe1; color:#116329; }
.git-diff .diff-deletion { background:#ffebe9; color:#a40e26; }
@media (max-width:640px) { .git-diff .diff-number { flex-basis:3.5em; width:3.5em; padding:0 6px; } }
@media (prefers-color-scheme:dark) {
  .git-diff .diff-number { color:#8b949e; border-color:#3a3b3d; }
  .git-diff .diff-addition { background:#033a16; color:#aff5b4; }
  .git-diff .diff-deletion { background:#67060c; color:#ffdcd7; }
}
`;
