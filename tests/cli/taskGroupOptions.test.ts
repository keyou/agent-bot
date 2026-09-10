import { describe, expect, test } from "vitest";
import {
  parseTaskForkGroupOptions,
  parseTaskNewOptions,
  parseTaskNewGroupOptions,
} from "../../src/cli/taskGroupOptions.js";

describe("task group CLI options", () => {
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

  test("parses newgroup Session IDs and titles", () => {
    expect(parseTaskNewGroupOptions([
      "source-task",
      "Existing",
      "task",
      "--session",
      "codex://threads/019f-thread",
      "--json",
    ], "en")).toEqual({
      reference: "source-task",
      sessionId: "codex://threads/019f-thread",
      title: "Existing task",
      cwd: undefined,
      projectless: false,
      json: true,
    });
    expect(() => parseTaskNewGroupOptions(["source-task", "--session"], "en"))
      .toThrow("requires an App Server Session ID after --session");
    expect(() => parseTaskNewGroupOptions(["source-task", "--session", "019f-thread", "--move"], "en"))
      .toThrow("does not support option: --move");
    expect(parseTaskNewGroupOptions([
      "source-task",
      "--session",
      "019f-thread",
      "--agent",
      "traex",
    ], "en")).toMatchObject({
      sessionId: "019f-thread",
      agentName: "traex",
    });
    for (const option of ["--dir", "--nodir"] as const) {
      const value = option === "--nodir" ? [] : ["~/project"];
      expect(() => parseTaskNewGroupOptions([
        "source-task",
        "--session",
        "019f-thread",
        option,
        ...value,
      ], "en")).toThrow("cannot combine --session with --dir or --nodir");
    }
  });
});
