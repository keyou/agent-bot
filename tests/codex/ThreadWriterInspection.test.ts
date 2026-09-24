import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SystemThreadWriterProcessController } from "../../src/codex/ThreadWriterProcess.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), access: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let replies: Array<{ code?: number | string; stdout?: string; stderr?: string; killed?: boolean }>;
beforeEach(() => {
  replies = [];
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.mocked(access).mockReset().mockResolvedValue(undefined);
  vi.mocked(execFile).mockReset().mockImplementation(((...args: unknown[]) => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected process inspection");
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(reply.code === undefined ? null : Object.assign(new Error("inspection failed"), { code: reply.code, killed: reply.killed }), reply.stdout ?? "", reply.stderr ?? "");
    return {};
  }) as typeof execFile);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

test("a leftover lock with no OS owner is not a live writer", async () => {
  replies.push({ code: 1 });
  expect(await new SystemThreadWriterProcessController().inspect("unused.lock")).toEqual([]);
  expect(execFile).toHaveBeenCalledTimes(1);
});

test("uses fuser when lsof is unavailable", async () => {
  replies.push({ code: "ENOENT" }, { code: 1 });
  expect(await new SystemThreadWriterProcessController().inspect("unused.lock")).toEqual([]);
  expect(vi.mocked(execFile).mock.calls.map((call) => call[0])).toEqual(["lsof", "fuser"]);
});

test.each([
  [{ code: "ENOENT" }, { code: "ENOENT" }],
  [{ code: 1, stderr: "permission denied" }, { code: 1, stderr: "permission denied" }],
  [{ code: 1, killed: true }, { code: 1, killed: true }],
])("does not report idle when both OS inspection methods fail: %j", async (lsof, fuser) => {
  replies.push(lsof, fuser);
  await expect(new SystemThreadWriterProcessController().inspect("unknown.lock")).rejects.toThrow("Cannot inspect thread writers");
});

test("propagates lock access failures rather than pretending the file is absent", async () => {
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("access denied"), { code: "EACCES" }));
  await expect(new SystemThreadWriterProcessController().inspect("unknown.lock")).rejects.toThrow("access denied");
  expect(execFile).not.toHaveBeenCalled();
});

test("an OS-reported PID whose metadata cannot be read is unknown, not idle", async () => {
  replies.push({ stdout: "12345\n" }, ...Array.from({ length: 4 }, () => ({ code: "ENOENT" })));
  await expect(new SystemThreadWriterProcessController().inspect("occupied.lock")).rejects.toThrow("Cannot identify a reported thread writer");
});

test("a missing lock does not spawn a process inspector", async () => {
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  expect(await new SystemThreadWriterProcessController().inspect("missing.lock")).toEqual([]);
  expect(execFile).not.toHaveBeenCalled();
});

test("Windows Restart Manager inspection remains hidden and propagates its failure", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  replies.push({ code: 1, stderr: "RmGetList failed" });
  await expect(new SystemThreadWriterProcessController().inspect("unknown.lock")).rejects.toThrow("RmGetList failed");
  expect(vi.mocked(execFile).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 10_000 });
});
