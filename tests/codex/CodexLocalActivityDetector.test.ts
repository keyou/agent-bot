import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexLocalActivityDetector } from "../../src/codex/CodexLocalActivityDetector.js";

const temporaryDirectories: string[] = [];
const reads = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const file = await original.open(...args);
    const read = file.read.bind(file);
    file.read = ((...input: unknown[]) => {
      if (typeof input[2] === "number") reads.bytes += input[2];
      return Reflect.apply(read, file, input);
    }) as typeof file.read;
    return file;
  } };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexLocalActivityDetector", () => {
  test("reuses unchanged rollouts and scans only appended bytes without losing active state", async () => {
    const home = await createCodexHome();
    const rollout = path.join(home, "sessions", "incremental.jsonl");
    await writeFile(rollout, `${event("task_started")}\n${"x".repeat(300_000)}\n`);
    createStateDatabase(home, [{ id: "incremental", rolloutPath: rollout }]);
    const detector = new CodexLocalActivityDetector(home, async () => true);
    expect((await detector.activeThreadIds(["incremental"])).has("incremental")).toBe(true);
    reads.bytes = 0;
    expect((await detector.activeThreadIds(["incremental"])).has("incremental")).toBe(true);
    expect(reads.bytes).toBe(0);
    await appendFile(rollout, `${"y".repeat(2_000)}\n`);
    expect((await detector.activeThreadIds(["incremental"])).has("incremental")).toBe(true);
    expect(reads.bytes).toBeLessThan(10_000);
    await appendFile(rollout, `${event("task_complete")}\n`);
    expect((await detector.activeThreadIds(["incremental"])).size).toBe(0);
    await writeFile(rollout, `${event("task_started")}\n`);
    expect((await detector.activeThreadIds(["incremental"])).has("incremental")).toBe(true);
    await rm(rollout);
    expect((await detector.activeThreadIds(["incremental"])).size).toBe(0);
    await writeFile(rollout, `${event("task_complete")}\n`);
    expect((await detector.activeThreadIds(["incremental"])).size).toBe(0);
  });

  test("detects an unpaired task_started event without modifying Codex state", async () => {
    const home = await createCodexHome();
    const activeRollout = await createRollout(home, "active", ["task_complete", "task_started"]);
    const idleRollout = await createRollout(home, "idle", ["task_started", "task_complete"]);
    const interruptedRollout = await createRollout(home, "interrupted", ["task_started", "turn_aborted"]);
    createStateDatabase(home, [
      { id: "active", rolloutPath: activeRollout },
      { id: "idle", rolloutPath: idleRollout },
      { id: "interrupted", rolloutPath: interruptedRollout },
    ]);

    const active = await new CodexLocalActivityDetector(home, async () => true).activeThreads([
      "active",
      "idle",
      "interrupted",
      "missing",
    ]);

    expect([...active]).toEqual([["active", "turn-active"]]);
  });

  test("finds lifecycle events across read chunk boundaries and large tool output", async () => {
    const home = await createCodexHome();
    const rollout = path.join(home, "sessions", "large.jsonl");
    await writeFile(rollout, [
      event("task_started"),
      JSON.stringify({ type: "response_item", payload: { type: "tool_output", output: "x".repeat(200_000) } }),
      "",
    ].join("\n"));
    createStateDatabase(home, [{ id: "large", rolloutPath: rollout }]);

    const active = await new CodexLocalActivityDetector(home, async () => true).activeThreadIds(["large"]);

    expect(active.has("large")).toBe(true);
  });

  test("reads model, reasoning effort, and permission mode without loading the thread", async () => {
    const home = await createCodexHome();
    const rollout = await createRollout(home, "settings", []);
    createStateDatabase(home, [{
      id: "settings",
      rolloutPath: rollout,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      approvalMode: "never",
    }, {
      id: "confirm",
      rolloutPath: rollout,
      model: "gpt-5.5",
      reasoningEffort: "high",
      approvalMode: "on-request",
    }]);

    const settings = await new CodexLocalActivityDetector(home).threadSettings(["settings", "confirm", "missing"]);

    expect(settings.get("settings")).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "auto",
    });
    expect(settings.get("confirm")).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      permissionMode: "confirm",
    });
    expect(settings.has("missing")).toBe(false);
  });

  test("ignores an unfinished crash rollout when no writer exists, even if the lock file remains", async () => {
    const home = await createCodexHome();
    const id = "00000000-0000-4000-8000-000000000001";
    const rolloutPath = await createRollout(home, "crashed", ["task_started"]);
    createStateDatabase(home, [{ id, rolloutPath }]);
    const detector = new CodexLocalActivityDetector(home);
    expect(await detector.activeThreads([id])).toEqual(new Map());
    const hasWriter = vi.fn(async () => false);
    await mkdir(path.join(home, "thread-writer-locks"));
    await writeFile(path.join(home, "thread-writer-locks", `${id}.lock`), "");
    expect(await new CodexLocalActivityDetector(home, hasWriter).activeThreads([id])).toEqual(new Map());
    expect(hasWriter).toHaveBeenCalledWith(id);
  });

  test("rechecks live writers independently of cached rollout bytes and shares concurrent checks", async () => {
    const home = await createCodexHome();
    const rolloutPath = await createRollout(home, "unchanged", ["task_started"]);
    createStateDatabase(home, [{ id: "unchanged", rolloutPath }]);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const hasWriter = vi.fn(async () => true);
    const detector = new CodexLocalActivityDetector(home, hasWriter);
    await Promise.all([detector.activeThreads(["unchanged"]), detector.activeThreads(["unchanged"])]);
    expect(hasWriter).toHaveBeenCalledTimes(1);
    now += 5_001;
    hasWriter.mockResolvedValue(false);
    expect(await detector.activeThreads(["unchanged"])).toEqual(new Map());
    expect(hasWriter).toHaveBeenCalledTimes(2);
    now += 5_001;
    hasWriter.mockResolvedValue(true);
    expect(await detector.activeThreads(["unchanged"])).toEqual(new Map([["unchanged", "turn-active"]]));
  });

  test("does not turn a failed process inspection into evidence that a task is idle", async () => {
    const home = await createCodexHome();
    const rolloutPath = await createRollout(home, "unknown", ["task_started"]);
    createStateDatabase(home, [{ id: "unknown", rolloutPath }]);
    const hasWriter = vi.fn(async () => { throw new Error("permission denied"); });
    const detector = new CodexLocalActivityDetector(home, hasWriter);
    await expect(detector.activeThreads(["unknown"])).rejects.toThrow("无法确认任务");
    await expect(detector.activeThreads(["unknown"])).rejects.toThrow("无法确认任务");
    expect(hasWriter).toHaveBeenCalledTimes(2);
  });
});

async function createCodexHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-bot-codex-state-"));
  temporaryDirectories.push(home);
  await mkdir(path.join(home, "sessions"), { recursive: true });
  return home;
}

async function createRollout(home: string, id: string, lifecycle: string[]): Promise<string> {
  const rollout = path.join(home, "sessions", `${id}.jsonl`);
  await writeFile(rollout, `${lifecycle.map(event).join("\n")}\n`);
  return rollout;
}

function createStateDatabase(home: string, rows: Array<{
  id: string;
  rolloutPath: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
}>): void {
  const database = new Database(path.join(home, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT,
      approval_mode TEXT
    )
  `);
  const insert = database.prepare(
    "INSERT INTO threads (id, rollout_path, model, reasoning_effort, approval_mode) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.rolloutPath,
      row.model ?? null,
      row.reasoningEffort ?? null,
      row.approvalMode ?? null,
    );
  }
  database.close();
}

function event(type: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type, ...(type === "task_started" ? { turn_id: "turn-active" } : {}) },
  });
}
