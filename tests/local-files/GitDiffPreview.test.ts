import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import { readGitFileDiff, renderGitFileDiff } from "../../src/local-files/GitDiffPreview.js";
import * as gitDiffPreview from "../../src/local-files/GitDiffPreview.js";
import { LocalFileViewerServer } from "../../src/local-files/LocalFileViewerServer.js";
import { createTurnViewState } from "../../src/presentation/TurnStateReducer.js";

const directories: string[] = [];
const servers: LocalFileViewerServer[] = [];
const gitConfigs = new Map<string, string>();
const readOriginal = readGitFileDiff;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  gitConfigs.clear();
});

function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-git-preview-"));
  directories.push(root); return root;
}
function git(cwd: string, ...args: string[]): string {
  let global = gitConfigs.get(cwd);
  if (!global) {
    global = path.join(directory(), "global-config"); fs.writeFileSync(global, ""); gitConfigs.set(cwd, global);
  }
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" },
  });
}
function repository(commit = true): string {
  const root = directory();
  git(root, "init"); git(root, "config", "user.name", "Preview Test"); git(root, "config", "user.email", "preview@example.invalid");
  if (commit) {
    fs.writeFileSync(path.join(root, "file.ts"), "const value = 1;\nkeep();\n");
    git(root, "add", "."); git(root, "commit", "-m", "initial");
  }
  return root;
}
async function viewer(root: string) {
  const state = createTurnViewState("session", "turn", Date.now());
  state.projectCwd = root;
  const server = new LocalFileViewerServer({ host: "127.0.0.1", port: 0,
    stateDirectory: path.join(directory(), "viewer"), getTurnSnapshot: () => state });
  servers.push(server); await server.start();
  return { server, state };
}

test("compares HEAD with the worktree including both staged and unstaged changes", async () => {
  const root = repository(); const file = path.join(root, "file.ts");
  fs.writeFileSync(file, "const value = 2;\nkeep();\n"); git(root, "add", "file.ts");
  fs.writeFileSync(file, "const value = 3;\nkeep();\n");
  const diff = await readGitFileDiff(file);
  expect(diff).toContain("-const value = 1;"); expect(diff).toContain("+const value = 3;");
  expect(diff).not.toContain("const value = 2;");
  expect(git(root, "show", ":file.ts")).toContain("const value = 2;");
});

test("uses literal single-file paths and supports nested working directories", async () => {
  const root = repository(); const sub = path.join(root, "src"); fs.mkdirSync(sub);
  const file = path.join(sub, "中文 [x]& file.ts");
  fs.writeFileSync(file, "before\n"); fs.writeFileSync(path.join(sub, "other.ts"), "other before\n");
  git(root, "add", "."); git(root, "commit", "-m", "nested files");
  fs.writeFileSync(file, "after\n"); fs.writeFileSync(path.join(sub, "other.ts"), "other after\n");
  const diff = await readGitFileDiff(file);
  expect(diff).toContain("+after"); expect(diff).not.toContain("other after");
});

test("previews tracked deletions even when their containing directory has disappeared", async () => {
  const root = repository(); const sub = path.join(root, "gone"); fs.mkdirSync(sub);
  const file = path.join(sub, "deleted.ts"); fs.writeFileSync(file, "removed();\n");
  git(root, "add", "."); git(root, "commit", "-m", "add deletion fixture");
  fs.rmSync(sub, { recursive: true });
  expect(await readGitFileDiff(file)).toContain("-removed();");
  const { server } = await viewer(root);
  expect(server.createFileUrl(file)).toBeUndefined();
  const response = await fetch(server.createFileUrl(file, undefined, { diff: true })!);
  expect(response.status).toBe(200);
  const { document } = parseHTML(await response.text());
  expect(document.querySelector(".diff-deletion")?.textContent).toContain("removed();");
  expect(document.querySelector(".actions")).toBeNull();
});

test("supports newly staged files before the first commit without writing a Git object", async () => {
  const root = repository(false); const file = path.join(root, "new.ts"); fs.writeFileSync(file, "newFile();\n");
  git(root, "add", "new.ts");
  expect(await readGitFileDiff(file)).toContain("+newFile();");
});

test("does not execute external diff, text conversion, clean/process filters or filesystem monitors", async () => {
  const root = repository(); const file = path.join(root, "file.ts");
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.ts filter=preview diff=preview\n");
  git(root, "add", ".gitattributes"); git(root, "commit", "-m", "attributes");
  const marker = path.join(root, "executed");
  const executable = path.join(root, "unexpected.cjs");
  fs.writeFileSync(executable, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${executable.replaceAll("\\", "/")}"`;
  for (const key of ["filter.preview.clean", "filter.preview.process", "diff.preview.command", "diff.preview.textconv", "core.fsmonitor"]) {
    git(root, "config", key, command);
  }
  git(root, "config", "filter.preview.required", "true");
  fs.writeFileSync(file, "changed();\n");
  expect(await readGitFileDiff(file)).toContain("+changed();");
  expect(fs.existsSync(marker)).toBe(false);
});

test("falls back for unchanged, untracked, non-repository, binary, oversized and missing files", async () => {
  const root = repository(); expect(await readGitFileDiff(path.join(root, "file.ts"))).toBeUndefined();
  const untracked = path.join(root, "untracked.ts"); fs.writeFileSync(untracked, "new\n");
  expect(await readGitFileDiff(untracked)).toBeUndefined();
  const outside = path.join(directory(), "outside.ts"); fs.writeFileSync(outside, "outside\n");
  expect(await readGitFileDiff(outside)).toBeUndefined();
  const binary = path.join(root, "binary.png"); fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  git(root, "add", "binary.png"); git(root, "commit", "-m", "binary");
  fs.writeFileSync(binary, Buffer.from([0, 4, 5, 6])); expect(await readGitFileDiff(binary)).toBeUndefined();
  fs.writeFileSync(untracked, "x".repeat(2 * 1024 * 1024 + 1)); expect(await readGitFileDiff(untracked)).toBeUndefined();
  expect(await readGitFileDiff(path.join(root, "absent.ts"))).toBeUndefined();
});

test("missing Git degrades to an ordinary file preview", async () => {
  const root = repository(); const file = path.join(root, "file.ts"); fs.writeFileSync(file, "fallback();\n");
  const { server } = await viewer(root); vi.stubEnv("PATH", directory());
  const response = await fetch(server.createFileUrl(file, undefined, { diff: true })!);
  expect(response.status).toBe(200); const { document } = parseHTML(await response.text());
  expect(document.querySelector(".git-diff")).toBeNull(); expect(document.querySelector(".code")?.textContent).toContain("fallback");
});

test("merges highlighted edits into the entire file with correct numbers, anchors and escaped content", () => {
  const patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -8,2 +8,2 @@\n-<script>bad()</script>\n+<img onerror="bad()">\n keep();\n\\ No newline at end of file\n';
  const prefix = Array.from({ length: 7 }, (_, index) => `unchanged ${index + 1}`);
  const { document } = parseHTML(renderGitFileDiff(patch, [...prefix, '<img onerror="bad()">', "keep();", "tail"].join("\n"))!);
  expect(document.querySelector("script, img")).toBeNull();
  expect(document.querySelector(".diff-deletion .diff-text")?.textContent).toBe("<script>bad()</script>");
  expect([...document.querySelectorAll(".diff-deletion .diff-number")].map((n) => n.textContent)).toEqual(["8", ""]);
  expect([...document.querySelectorAll(".diff-addition .diff-number")].map((n) => n.textContent)).toEqual(["", "8"]);
  expect([...document.querySelectorAll("#L9 .diff-number")].map((n) => n.textContent)).toEqual(["9", "9"]);
  expect(document.querySelector("#L8 a")?.getAttribute("href")).toBe("#L8");
  expect(document.querySelector("#L1 .diff-text")?.textContent).toBe(prefix[0]);
  expect(document.querySelector("#L10 .diff-text")?.textContent).toBe("tail");
  expect(document.querySelectorAll(".diff-hunk, .diff-meta")).toHaveLength(0);
});

test("retains unchanged leading, trailing and inter-hunk context and reconstructs both file versions", async () => {
  const root = repository(); const file = path.join(root, "file.ts");
  const before = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  fs.writeFileSync(file, `${before.join("\n")}\n`); git(root, "add", "."); git(root, "commit", "-m", "long source");
  const after = [...before]; after.splice(44, 2, "replacement", "second", "third"); after.splice(9, 0, "inserted");
  fs.writeFileSync(file, `${after.join("\n")}\n`);
  const patch = (await readGitFileDiff(file))!;
  expect(patch.match(/^@@ /gmu)).toHaveLength(2);
  const { document } = parseHTML(renderGitFileDiff(patch, fs.readFileSync(file, "utf8"))!);
  const text = (selector: string) => [...document.querySelectorAll(selector)].map((row) => row.querySelector(".diff-text")!.textContent);
  expect(text(".line:not(.diff-addition)")).toEqual(before);
  expect(text(".line:not(.diff-deletion)")).toEqual(after);
  for (let index = 1; index <= after.length; index += 1) expect(document.getElementById(`L${index}`)).not.toBeNull();
  const { server } = await viewer(root);
  const page = parseHTML(await (await fetch(server.createFileUrl(file, undefined, { diff: true })!)).text()).document;
  expect(page.querySelector("#L1 .diff-text")?.textContent).toBe("line 1");
  expect(page.querySelector(`#L${after.length} .diff-text`)?.textContent).toBe("line 60");
  expect(page.querySelectorAll(".diff-context")).toHaveLength(58);
});

test.each([
  ["start insertion", "@@ -0,0 +1 @@\n+first", "first\nlast\n", ["first", "last"], ["last"]],
  ["end insertion", "@@ -1,0 +2 @@\n+last", "first\nlast", ["first", "last"], ["first"]],
  ["end deletion", "@@ -2 +1,0 @@\n-last", "first\n", ["first"], ["first", "last"]],
  ["whole deletion", "@@ -1,2 +0,0 @@\n-first\n-last", "", [], ["first", "last"]],
  ["new file", "@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file", "first\nlast", ["first", "last"], []],
  ["CRLF and empty lines", "@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n \r\n", "new\r\n\r\n", ["new", ""], ["old", ""]],
  ["UTF-8 BOM", "@@ -1 +1 @@\n-\uFEFFold\n+\uFEFFnew", "new\n", ["new"], ["\uFEFFold"]],
] as const)("handles %s", (_name, hunk, source, after, before) => {
  const { document } = parseHTML(renderGitFileDiff(`diff --git a/file b/file\n${hunk.replace(/\r?\n$/u, "")}\n`, source)!);
  const text = (selector: string) => [...document.querySelectorAll(selector)].map((row) => row.querySelector(".diff-text")!.textContent);
  expect(text(".line:not(.diff-deletion)")).toEqual(after);
  expect(text(".line:not(.diff-addition)")).toEqual(before);
  expect([...document.querySelectorAll(".line:not(.diff-deletion)")].map((row) => row.id)).toEqual(after.map((_, index) => `L${index + 1}`));
});

test("handles mode-only changes without hiding any source", () => {
  const { document } = parseHTML(renderGitFileDiff("diff --git a/file b/file\nold mode 100644\nnew mode 100755\n", "first\nlast\n")!);
  expect([...document.querySelectorAll(".diff-text")].map((row) => row.textContent)).toEqual(["first", "last"]);
});

test.each([
  ["@@ -1 +1 @@\n-old\n+new", "different\n"],
  ["@@ -1,2 +1,2 @@\n-old\n+new", "new\n"],
  ["@@ -4 +3 @@\n-old\n+new", "one\ntwo\nnew\n"],
  ["@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new", "new\n"],
  ["@@ invalid @@\n-old\n+new", "new\n"],
  ["@@ -1 +1 @@\n-old\n+new\ndiff --git a/other b/other", "new\n"],
] as const)("rejects stale or malformed patches instead of displaying misplaced changes: %s", (hunk, source) => {
  expect(renderGitFileDiff(`diff --git a/file b/file\n${hunk}\n`, source)).toBeUndefined();
});

test("bounds the complete file and combined deletion rows", () => {
  const source = "context\n".repeat(20_001);
  expect(renderGitFileDiff("diff --git a/file b/file\nold mode 100644\nnew mode 100755\n", source)).toBeUndefined();
  expect(renderGitFileDiff("diff --git a/file b/file\n@@ -1,2 +1 @@\n-removed\n context\n", "context\n".repeat(20_000))).toBeUndefined();
});

test("falls back if the file changes while Git is reading, even outside the diff hunks", async () => {
  const root = repository(); const file = path.join(root, "file.ts"); fs.writeFileSync(file, "updated();\nkeep();\n");
  const { server } = await viewer(root);
  vi.spyOn(gitDiffPreview, "readGitFileDiff").mockImplementation(async (target) => {
    const diff = await readOriginal(target);
    fs.appendFileSync(file, "arrived during diff\n");
    return diff;
  });
  const response = await fetch(server.createFileUrl(file, undefined, { diff: true })!);
  expect(response.status).toBe(200);
  const { document } = parseHTML(await response.text());
  expect(document.querySelector(".git-diff")).toBeNull();
  expect(document.querySelector(".code")?.textContent).toContain("arrived during diff");
});

test("non-UTF-8 patches fall back to decoded ordinary previews instead of corrupting source", async () => {
  const root = repository(); const file = path.join(root, "encoded.txt");
  fs.writeFileSync(file, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a])); git(root, "add", "."); git(root, "commit", "-m", "encoded source");
  fs.appendFileSync(file, "added\n");
  const { server } = await viewer(root);
  const { document } = parseHTML(await (await fetch(server.createFileUrl(file, undefined, { diff: true })!)).text());
  expect(document.querySelector(".git-diff")).toBeNull();
  expect(document.querySelector(".code")?.textContent).toContain("你好");
});

test("changed-file links request diffs in both lazy file lists without changing ordinary links or raw downloads", async () => {
  const root = repository(); const file = path.join(root, "file.ts"); fs.writeFileSync(file, "updated();\nkeep();\n");
  const { server, state } = await viewer(root);
  state.fileSummary = [{ path: "file.ts", additions: 1, deletions: 1 }];
  state.activities = [{ kind: "tool", id: "edit", tool: { id: "edit", title: "edit", kind: "file_change", status: "completed", files: state.fileSummary } }];
  const turn = new URL(server.createTurnPreviewUrl("turn")!);
  for (const detail of ["files", "tool:edit"]) {
    turn.searchParams.set("detail", detail);
    const payload = await (await fetch(turn)).json() as { content: string };
    const { document } = parseHTML(payload.content); const url = document.querySelector(".file-link")!.getAttribute("href")!;
    expect(new URL(url).searchParams.get("diff")).toBe("1");
    const page = await fetch(url); expect(page.status).toBe(200);
    const { document: diff } = parseHTML(await page.text());
    expect(diff.querySelector(".diff-addition .diff-text")?.textContent).toBe("updated();");
    const original = [...diff.querySelectorAll(".actions a")].find((a) => a.textContent === "查看文件")!.getAttribute("href")!;
    expect(original).toBe(server.createFileUrl(file));
    expect(parseHTML(await (await fetch(original)).text()).document.querySelector(".git-diff")).toBeNull();
    const raw = new URL(url); raw.searchParams.set("raw", "1");
    expect(await (await fetch(raw)).text()).toBe("updated();\nkeep();\n");
    const tampered = new URL(url); tampered.searchParams.set("path", path.join(root, "another.ts"));
    expect((await fetch(tampered)).status).toBe(403);
  }
});
