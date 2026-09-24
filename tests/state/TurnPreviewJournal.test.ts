import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TurnPreviewJournal, TurnPreviewProjection } from "../../src/state/TurnPreviewJournal.js";
import { createTurnViewState, reduceTurnEvent } from "../../src/presentation/TurnStateReducer.js";
import type { AgentEvent } from "../../src/runtime/types.js";

const directories: string[] = [];
const journals: TurnPreviewJournal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) { try { journal.close(); } catch {} }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const identity = { sessionId: "s", turnId: "t" };
const tool = { id: "cmd", kind: "command", title: "test", command: "run", status: "running" as const };
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-journal-"));
  directories.push(dir);
  const journal = new TurnPreviewJournal(dir);
  journals.push(journal);
  journal.seed(createTurnViewState("s", "t", 1000, undefined, undefined, dir, "prompt", undefined, "model", ["initial.png"]));
  journal.event({ ...identity, type: "tool_started", tool });
  return journal;
}

test("uses a single hash-sharded path and creates only the required buckets on write", () => {
  const journal = setup();
  expect(fs.readdirSync(journal.directory)).toEqual([]);
  const ids = ["t", "second-turn", "../../profile/escape", "轮次"];
  for (const id of ids) {
    const hash = createHash("sha256").update(id).digest("hex");
    expect(journal.file(id)).toBe(path.join(journal.directory, hash.slice(0, 2), `${hash}.jsonl`));
    if (id !== "t") journal.seed(createTurnViewState("s", id, 123));
  }
  journal.close();
  const reopened = new TurnPreviewJournal(journal.directory);
  journals.push(reopened);
  for (const id of ids) {
    expect(reopened.has(id)).toBe(true);
    expect(reopened.load(id)?.turnId).toBe(id);
    reopened.user(id, "followup", "after reopening");
    expect(reopened.load(id)?.activities.at(-1)).toMatchObject({ id: "followup", text: "after reopening" });
  }
  const entries = fs.readdirSync(journal.directory, { withFileTypes: true });
  expect(entries.every((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/u.test(entry.name))).toBe(true);
  expect(entries).toHaveLength(new Set(ids.map((id) => path.basename(path.dirname(journal.file(id))))).size);
});

test("writes 1 MiB of chunked output linearly, including repeated cumulative values", () => {
  const journal = setup();
  const delta = "x".repeat(8192);
  let output = "";
  for (let i = 0; i < 128; i++) {
    output += delta;
    journal.event({ ...identity, type: "tool_output_delta", toolId: tool.id, delta });
    journal.event({ ...identity, type: "tool_updated", tool: { ...tool, output } });
  }
  journal.event({ ...identity, type: "tool_updated", tool: { ...tool, status: "completed", output } });
  journal.flush("t", true);
  const bytes = fs.statSync(journal.file("t")).size;
  expect(bytes).toBeLessThan(1.3 * 1024 * 1024);
  expect(journal.load("t")?.fullToolOutputs?.cmd).toBe(output);
  expect(journal.load("t", false)?.fullToolOutputs?.cmd?.length).toBeLessThanOrEqual(6000);
  expect(journal.load("t", "tool:cmd")?.fullToolOutputs?.cmd).toBe(output);
  console.log("Journal benchmark bytes:", bytes);
});

test("append A+B followed by AB is not ABAB, replacement and restart work", () => {
  const journal = setup();
  for (const delta of ["A", "B"]) journal.event({ ...identity, type: "tool_output_delta", toolId: "cmd", delta });
  journal.event({ ...identity, type: "tool_updated", tool: { ...tool, output: "AB" } });
  journal.close();
  const reopened = new TurnPreviewJournal(journal.directory);
  journals.push(reopened);
  reopened.event({ ...identity, type: "tool_updated", tool: { ...tool, output: "ABC" } });
  expect(reopened.load("t")?.fullToolOutputs?.cmd).toBe("ABC");
  reopened.event({ ...identity, type: "tool_updated", tool: { ...tool, output: "replacement", status: "completed" } });
  expect(reopened.load("t")?.fullToolOutputs?.cmd).toBe("replacement");
});

test("preserves long commands, outputs, reasoning, commentary, messages, images and final answer", () => {
  const journal = setup();
  const long = "你好\n".repeat(5000);
  journal.event({ ...identity, type: "tool_updated", tool: { ...tool, command: long, output: long, error: "error " + long, status: "completed", imagePath: "result.png" } });
  journal.event({ ...identity, type: "progress", text: long, activityId: "commentary:c" });
  journal.event({ ...identity, type: "reasoning_delta", itemId: "r", contentIndex: 0, text: long });
  journal.event({ ...identity, type: "reasoning_completed", itemId: "r", summary: [long], content: [long] });
  journal.user("t", "u", long, ["followup.png"]);
  journal.event({ ...identity, type: "agent_text_delta", text: long });
  journal.event({ ...identity, type: "turn_completed", finalResponse: long, durationMs: 1000 });
  const state = journal.load("t")!;
  expect(state.activities.find((a) => a.kind === "tool" && a.tool.command === long)).toBeDefined();
  expect(state.fullToolOutputs?.cmd).toBe(long);
  expect(state.reasoningItems?.[0]?.content).toEqual([long]);
  expect(state.activities).toContainEqual({ kind: "assistant", id: "commentary:c", text: long });
  expect(state.activities).toContainEqual({ kind: "user", id: "u", text: long, localImagePaths: ["followup.png"] });
  expect(state.promptImagePaths).toEqual(["initial.png"]);
  expect(state.finalResponse).toBe(long);
  expect(state.assistantText).toBe(long);
});

test("persists model call counts and usage baselines without double-counting state patches or replayed events", () => {
  const journal = setup();
  let state = createTurnViewState("s", "t", 1_000);
  const first: AgentEvent = { ...identity, type: "token_usage_updated", lastTokens: 10, cumulativeTokens: 100,
    lastTotalTokens: 50, cumulativeTotalTokens: 500 };
  state = reduceTurnEvent(state, first);
  journal.event(first);
  journal.state(state);
  expect(journal.load("t")?.modelCallCount).toBe(1);
  journal.close();
  const reopened = new TurnPreviewJournal(journal.directory);
  journals.push(reopened);
  reopened.event(first);
  reopened.event({ ...first, lastTokens: 0, lastTotalTokens: 50, cumulativeTotalTokens: 550 });
  const completed: AgentEvent = { ...identity, type: "turn_completed", finalResponse: "Done" };
  reopened.event(completed);
  const restored = reopened.load("t")!;
  expect(restored).toMatchObject({ modelCallCount: 2, status: "completed",
    modelCallTokenBaseline: { nonCached: 100, total: 550 } });
  const saved = JSON.parse(JSON.stringify(restored)) as typeof restored;
  expect(reduceTurnEvent(saved, first).modelCallCount).toBe(2);
  expect(reduceTurnEvent(saved, { ...first, lastTokens: 20, cumulativeTokens: 120, cumulativeTotalTokens: 600 })
    .modelCallCount).toBe(3);
});

test("derives calls from saved usage events but does not invent calls for old summary seeds", () => {
  const journal = setup();
  const first: AgentEvent = { ...identity, type: "token_usage_updated", lastTokens: 10, cumulativeTokens: 100 };
  journal.event(first);
  // Old state records do not contain the new counter, so replay retains the observed count.
  journal.state({ ...createTurnViewState("s", "t", 1_000), totalTokens: 10, tokenUsageCumulative: 100 });
  journal.event(first);
  journal.event({ ...first, cumulativeTokens: 110 });
  expect(journal.load("t")?.modelCallCount).toBe(2);
  journal.seed({ ...createTurnViewState("s", "old", 1_000), totalTokens: 10, tokenUsageCumulative: 100 });
  journal.event({ ...first, turnId: "old", cumulativeTokens: 110 });
  expect(journal.load("old")?.modelCallCount).toBeUndefined();
});

test("ignores incomplete UTF-8 tail and repairs it before the next append", () => {
  const journal = setup();
  journal.flush();
  const validSize = fs.statSync(journal.file("t")).size;
  journal.close();
  fs.appendFileSync(journal.file("t"), '{"kind":"event","text":"未完成');
  const reopened = new TurnPreviewJournal(journal.directory);
  journals.push(reopened);
  expect(reopened.load("t")?.previewCursor).toBe(validSize);
  reopened.user("t", "u", "after restart");
  expect(reopened.load("t")?.activities.at(-1)).toMatchObject({ id: "u", text: "after restart" });
  expect(fs.readFileSync(reopened.file("t"), "utf8")).not.toContain("未完成");
});

test("byte cursor batches have no missing or duplicate records and no parse work at EOF", () => {
  const journal = setup();
  for (let i = 0; i < 150; i++) journal.user("t", String(i), "界".repeat(1024));
  journal.flush();
  let offset = 0;
  const projection = new TurnPreviewProjection();
  for (;;) {
    const batch = journal.read("t", offset, 32768);
    for (const record of batch.records) projection.apply(record, ++projection.revision);
    offset = batch.offset;
    if (batch.end) break;
  }
  expect(projection.state?.activities.filter((a) => a.kind === "user")).toHaveLength(150);
  const parse = vi.spyOn(JSON, "parse");
  expect(journal.read("t", offset).records).toEqual([]);
  expect(parse).not.toHaveBeenCalled();
});

test("fails closed on disk failure instead of accumulating an unbounded retry queue", () => {
  const journal = setup();
  const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("disk full"); });
  expect(() => journal.flush()).toThrow("disk full");
  write.mockRestore();
  expect(() => journal.user("t", "u", "not silently accepted")).toThrow("disk full");
});


test("recovers a torn initial seed without skipping creation and isolates arbitrary turn IDs", () => {
  const journal = setup();
  const other = "../../profile/escape";
  expect(path.dirname(path.dirname(journal.file(other)))).toBe(journal.directory);
  fs.mkdirSync(path.dirname(journal.file(other)), { recursive: true });
  fs.writeFileSync(journal.file(other), '{"kind":"seed"');
  const state = createTurnViewState("s", other, 123);
  journal.seed(state);
  expect(journal.load(other)?.turnId).toBe(other);
  expect(journal.load("t")?.turnId).toBe("t");
});

test("full seeded history stays available and repeated detail reads do not rescan", () => {
  const journal = setup();
  const state = createTurnViewState("s", "legacy", 1);
  state.activities = [{ kind: "tool", id: "old", tool: { ...tool, id: "old", output: "short", status: "completed" } }];
  state.fullToolOutputs = { old: "full".repeat(10000) };
  journal.seed(state);
  expect(journal.load("legacy", "tool:old")?.fullToolOutputs?.old).toBe(state.fullToolOutputs.old);
  const first = journal.load("legacy", "tool:old")!;
  const parse = vi.spyOn(JSON, "parse");
  expect(journal.load("legacy", "tool:old")?.previewCursor).toBe(first.previewCursor);
  expect(parse).not.toHaveBeenCalled();
});


test("flushes batched records and fsyncs already-written data at a critical boundary", async () => {
  vi.useFakeTimers();
  const journal = setup();
  const sync = vi.spyOn(fs, "fsyncSync");
  try {
    expect(fs.existsSync(journal.file("t"))).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(fs.existsSync(journal.file("t"))).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    journal.flush("t", true);
    expect(sync).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
