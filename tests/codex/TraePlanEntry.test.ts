import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hasCompletedTraePlanEntry } from "../../src/codex/TraePlanEntry.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const call = { type: "function_call", name: "EnterPlanMode", call_id: "call_1" };
const output = { type: "function_call_output", call_id: "call_1", output: "Entered plan mode. More instructions." };
function record(items: unknown[], turnId = "turn_1", operation = "append"): string {
  return JSON.stringify({ type: "history_mutation", payload: { version: 1, turn_id: turnId, operation, items } }) + "\n";
}
async function check(text: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-plan-entry-"));
  dirs.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, text);
  return hasCompletedTraePlanEntry(file, "turn_1", "call_1");
}

describe("TraeX completed plan entry evidence", () => {
  test("requires the exact call followed by its successful result", async () => {
    expect(await check(record([call]) + record([output]))).toBe(true);
    expect(await check(record([call, output]))).toBe(true);
  });

  test.each([
    record([call]),
    record([output]),
    record([output, call]),
    record([call, { ...output, output: "User rejected EnterPlanMode" }]),
    record([call, { ...output, output: { text: "Entered plan mode." } }]),
    record([{ ...call, name: "ExitPlanMode" }, output]),
    record([call, { ...output, call_id: "another_call" }]),
    record([call, output], "another_turn"),
    record([call]) + record([output], "another_turn"),
    record([call, output], "turn_1", "replace"),
    record([call, output]) + record([], "turn_1", "truncate"),
    record([call, output]) + record([{ ...output, output: "failed" }]),
    record([call]) + record([output]).trimEnd(),
    "not json\n",
  ])("rejects incomplete, unrelated or invalidated evidence (%#)", async (text) => {
    expect(await check(text)).toBe(false);
  });

  test("ignores a truncated first line and reads only recent evidence", async () => {
    const large = JSON.stringify({ type: "unrelated", output: "x".repeat(300 * 1024) }) + "\n";
    expect(await check(large + record([call, output]))).toBe(true);
    expect(await check(record([call, output]) + large)).toBe(false);
    expect(await check(record([call]) + large + record([output]))).toBe(false);
  });
});
