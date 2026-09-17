import { describe, expect, test } from "vitest";
import {
  parseTaskCloneOptions,
  parseTaskForkGroupOptions,
  parseTaskNewOptions,
  parseTaskNewGroupOptions,
} from "../../src/cli/taskGroupOptions.js";

describe("task group CLI options", () => {
  test.each(["clone", "clonegroup"] as const)("parses %s with an Agent and rejects invalid options", (action) => {
    expect(parseTaskCloneOptions(["source", "New", "task", "--agent", "traex", "--json"], action)).toEqual({
      reference: "source", title: "New task", agentName: "traex", json: true,
    });
    expect(() => parseTaskCloneOptions(["source", "--agent"], action)).toThrow("after --agent");
    expect(() => parseTaskCloneOptions(["source", "--agent", "a", "--agent", "b"], action)).toThrow("only once");
    expect(() => parseTaskCloneOptions(["source", "--dir", "x"], action)).toThrow("does not support");
    expect(() => parseTaskCloneOptions(["--json"], action)).toThrow("requires a source task");
  });

  test("parses a source task, title, directory, and JSON output for newgroup", () => {
    expect(parseTaskNewGroupOptions([
      "--json",
      "12",
      "Review",
      "fixes",
      "--dir",
      "~/dev/project",
    ], "en")).toEqual({
      reference: "12",
      title: "Review fixes",
      cwd: "~/dev/project",
      projectless: false,
      json: true,
    });
  });

  test("reuses the task creation options for task new", () => {
    expect(parseTaskNewOptions([
      "task_1",
      "Investigate",
      "timeout",
      "--agent",
      "traex",
      "--dir",
      "~/dev/project",
      "--json",
    ], "new", "en")).toEqual({
      reference: "task_1",
      title: "Investigate timeout",
      cwd: "~/dev/project",
      agentName: "traex",
      projectless: false,
      json: true,
    });
    expect(() => parseTaskNewOptions(["task_1", "--dir", "x", "--nodir"], "new", "en"))
      .toThrow("task new cannot combine --dir and --nodir");
  });

  test("parses a Projectless newgroup and rejects conflicting project options", () => {
    expect(parseTaskNewGroupOptions(["task_1", "Projectless", "--nodir"], "en")).toEqual({
      reference: "task_1",
      title: "Projectless",
      cwd: undefined,
      projectless: true,
      json: false,
    });
    expect(() => parseTaskNewGroupOptions([
      "task_1",
      "--dir",
      "D:\\dev\\project",
      "--nodir",
    ], "en")).toThrow("cannot combine --dir and --nodir");
  });

  test("parses an explicit Agent standard name for newgroup", () => {
    expect(parseTaskNewGroupOptions([
      "--agent",
      "traex",
      "task_1",
      "Review",
      "room",
    ], "en")).toEqual({
      reference: "task_1",
      title: "Review room",
      cwd: undefined,
      agentName: "traex",
      projectless: false,
      json: false,
    });
    expect(() => parseTaskNewGroupOptions(["task_1", "--agent"], "en"))
      .toThrow("requires an Agent standard name after --agent");
    expect(() => parseTaskNewGroupOptions([
      "task_1",
      "--agent",
      "codex",
      "--agent",
      "traex",
    ], "zh")).toThrow("只能指定一次 --agent");
  });

  test("requires a source task and localizes parser errors", () => {
    expect(() => parseTaskNewGroupOptions(["--json"], "en"))
      .toThrow("requires a source task number or task ID");
    expect(() => parseTaskForkGroupOptions(["--json"], "zh"))
      .toThrow("需要源任务序号或任务 ID");
  });

  test("parses forkgroup title and rejects unsupported options", () => {
    expect(parseTaskForkGroupOptions(["task_2", "Parallel", "fix", "--json"], "en")).toEqual({
      reference: "task_2",
      title: "Parallel fix",
      json: true,
    });
    expect(() => parseTaskForkGroupOptions(["task_2", "--nodir"], "en"))
      .toThrow("does not support option: --nodir");
  });
});
