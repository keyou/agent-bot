import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { prepareTerminalHelper } from "../../src/terminal/TerminalProcess.js";

test.each(["build/Release", "build/Debug", "prebuilds/darwin-arm64"])("restores executable bits on %s spawn-helper only", (directory) => {
  const root = path.resolve("node_modules/node-pty");
  const helper = path.join(root, directory, "spawn-helper");
  const filesystem = {
    existsSync: vi.fn((file) => file === helper),
    statSync: vi.fn(() => ({ mode: 0o100644, isFile: () => true })) as unknown as typeof fs.statSync,
    chmodSync: vi.fn(),
  };
  prepareTerminalHelper(root, "arm64", filesystem);
  expect(filesystem.chmodSync).toHaveBeenCalledExactlyOnceWith(helper, 0o755);
  expect(filesystem.existsSync).toHaveBeenCalledTimes(3);
});

test("leaves executable helpers and absent build directories unchanged", () => {
  const filesystem = {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ mode: 0o100755, isFile: () => true })) as unknown as typeof fs.statSync,
    chmodSync: vi.fn(),
  };
  prepareTerminalHelper("node-pty", "x64", filesystem);
  expect(filesystem.chmodSync).not.toHaveBeenCalled();
  filesystem.existsSync.mockReturnValue(false);
  vi.mocked(filesystem.statSync).mockClear();
  prepareTerminalHelper("node-pty", "x64", filesystem);
  expect(filesystem.statSync).not.toHaveBeenCalled();
});

test("reports an actionable error if helper permissions cannot be repaired", () => {
  const cause = new Error("EACCES");
  const filesystem = {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ mode: 0o100644, isFile: () => true })) as unknown as typeof fs.statSync,
    chmodSync: vi.fn(() => { throw cause; }),
  };
  expect(() => prepareTerminalHelper("node-pty", "x64", filesystem)).toThrow("restore its executable permission");
  expect(filesystem.chmodSync).toHaveBeenCalledOnce();
});
