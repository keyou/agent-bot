import { expect, test, vi } from "vitest";
import { terminalEnvironment, terminalShell } from "../../src/terminal/TerminalProcess.js";

test("selects Windows PowerShell with interactive PSReadLine support, not a one-shot command", () => {
  const shell = terminalShell("win32", { PATH: "C:/pwsh;C:/other" }, () => true, null);
  expect(shell.file).toMatch(/pwsh.exe$/u); expect(shell.args).toEqual(["-NoLogo"]);
  const fallback = terminalShell("win32", { SystemRoot: "C:/Windows" }, () => true, null);
  expect(fallback.file).toMatch(/powershell.exe$/u);
  expect(terminalShell("win32", {}, () => false, null).file).toMatch(/cmd.exe$/u);
});
test.each(["darwin", "linux"] as const)("respects the login Shell on %s and only accepts existing absolute paths", (platform) => {
  expect(terminalShell(platform, { SHELL: "/usr/bin/fish" }, () => true, "/bin/zsh")).toEqual({ file: "/usr/bin/fish", args: ["-i"] });
  expect(terminalShell(platform, { SHELL: "injected; command" }, () => true, "/bin/zsh").file).toBe("/bin/zsh");
  const exists = vi.fn(() => false);
  expect(() => terminalShell(platform, {}, exists, null)).toThrow("No interactive Shell");
});
test("does not leak internal credentials or AgentBot supervision flags into the terminal", () => {
  const env = terminalEnvironment({ PATH: "/bin", FEISHU_APP_SECRET: "secret", AGENT_BOT: "1", AGENT_BOT_SUPERVISED: "1", NODE_OPTIONS: "--inspect" });
  expect(env).toEqual({ PATH: "/bin", TERM: "xterm-256color", COLORTERM: "truecolor" });
});
