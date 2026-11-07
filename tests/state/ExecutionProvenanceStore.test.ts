import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";

const directories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-provenance-"));
  directories.push(dir);
  const file = path.join(dir, "state.sqlite");
  const store = new StateStore(file);
  stores.push(store);
  return { store, file };
}
const settings = { agentName: "codex", modelProvider: "openai", model: "test-model",
  reasoningEffort: "high", permissionMode: "confirm" as const, cwd: "/project" };

test("persists only allowlisted execution metadata and keeps immutable turn bindings", () => {
  const { store, file } = fixture();
  const record = store.provenance.recordSubmission({ attemptId: "attempt", localSessionId: "task", instructionId: "message",
    trigger: "user", settings: { ...settings, ...{ apiKey: "secret", prompt: "private" } } });
  store.provenance.bindTurn(record.submissionId, "turn");
  store.provenance.bindTurn(record.submissionId, "different-turn");
  const reopened = new StateStore(file);
  stores.push(reopened);
  expect(reopened.provenance.forTurn("turn", "task")).toMatchObject({ instructionId: "message", trigger: "user", settings });
  expect(reopened.provenance.forTurn("turn", "other-task")).toBeUndefined();
  expect(reopened.provenance.forTurn("different-turn", "task")).toBeUndefined();
  expect(JSON.stringify(reopened.provenance.listForAttempt("attempt"))).not.toMatch(/secret|private|apiKey|prompt/);
});

test("continuations inherit logical instruction identity, while independent queue work does not", () => {
  const { store } = fixture();
  const original = store.provenance.recordSubmission({ attemptId: "scheduled", localSessionId: "task", instructionId: "run",
    trigger: "schedule", scheduledFor: 123, settings });
  store.provenance.bindTurn(original.submissionId, "plan");
  const child = store.provenance.recordSubmission({ attemptId: "child", localSessionId: "task", trigger: "plan_handoff",
    parentSourceTurnId: "plan", settings: { ...settings, modelProvider: "new-provider" } });
  expect(child).toMatchObject({ instructionId: "run", scheduledFor: 123, settings: { modelProvider: "new-provider" } });
  const retry = store.provenance.recordSubmission({ attemptId: "child", localSessionId: "task", trigger: "retry", settings });
  expect(retry.instructionId).toBe("run");
  const queued = store.provenance.recordSubmission({ attemptId: "next", instructionId: "queued-message", localSessionId: "task",
    trigger: "queue", parentSourceTurnId: "plan", settings });
  expect(queued.instructionId).toBe("queued-message");
  expect(queued.scheduledFor).toBeUndefined();
});
