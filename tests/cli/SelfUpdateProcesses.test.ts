import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runNpmCommand, validateInstalledPackage } from "../../src/cli/SelfUpdateRunner.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const cwd = path.resolve("update work directory");
const npmCli = path.join(cwd, "npm", "bin", "npm-cli.js");

beforeEach(() => {
  vi.mocked(spawnSync).mockReset().mockReturnValue({
    pid: 123, status: 0, signal: null, output: [null, "command output", "command warning"],
    stdout: "command output", stderr: "command warning",
  });
  vi.stubEnv("npm_execpath", npmCli);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("hidden self-update commands", () => {
  test.each([
    ["view", "@keyou007/agent-bot@latest", "version", "--json"],
    ["install", "--global", path.join(cwd, "candidate package.tgz")],
    ["pack", "--ignore-scripts", path.join(cwd, "backup package")],
  ])("hides npm through its Node entry point for %s", (...args) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => candidate === npmCli);

    expect(runNpmCommand(args, cwd)).toEqual({
      status: 0, stdout: "command output", stderr: "command warning",
    });
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(process.execPath, [npmCli, ...args], {
      cwd, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
  });

  test.each(["win32", "linux"] as const)("hides the npm fallback on %s without changing shell selection", (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const args = ["root", "--global"];

    runNpmCommand(args, cwd);

    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, shell: platform === "win32",
    });
  });

  test("hides both package-validation probes and retains their captured output", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ name: "@keyou007/agent-bot", version: "1.2.3" }));
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ pid: 123, status: 0, signal: null, output: [], stdout: "1.2.3\n", stderr: "" })
      .mockReturnValueOnce({ pid: 124, status: 0, signal: null, output: [], stdout: "agentbot --help", stderr: "" });

    expect(() => validateInstalledPackage(cwd, "@keyou007/agent-bot", "1.2.3")).not.toThrow();

    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const [index, flag] of ["--version", "--help"].entries()) {
      expect(spawnSync).toHaveBeenNthCalledWith(index + 1, process.execPath, [path.join(cwd, "dist", "cli.js"), flag], {
        cwd, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
      });
    }
  });

  test.each([true, false])("preserves spawn failures when npm has a JS entry: %s", (hasEntry) => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => hasEntry && candidate === npmCli);
    const error = new Error("spawn failed");
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0, status: null, signal: null, output: [], stdout: "", stderr: "permission denied", error,
    });

    expect(runNpmCommand(["install", "--global", "candidate.tgz"], cwd)).toEqual({
      status: 1, stdout: "", stderr: "permission denied", error,
    });
    expect(spawnSync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ windowsHide: true }));
  });
});
