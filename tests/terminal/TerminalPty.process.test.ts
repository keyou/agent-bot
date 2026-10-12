import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { spawnTerminal } from "../../src/terminal/TerminalProcess.js";

test("real PTY preserves state, emits ANSI, resizes, interrupts and exits", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-pty-"));
  const pty = await spawnTerminal(cwd, 100, 30);
  let output = ""; let exited = false;
  const data = pty.onData((chunk) => { output += chunk; });
  const exit = pty.onExit(() => { exited = true; });
  const windows = process.platform === "win32";
  try {
    pty.write(windows
      ? "$env:AB_PTY_TEST='persist'; [Console]::WriteLine('PTY_' + 'READY')" + String.fromCharCode(13)
      : "export AB_PTY_TEST=persist; printf 'PTY_%s' READY" + String.fromCharCode(13));
    await vi.waitFor(() => expect(output).toContain("PTY_READY"), { timeout: 15_000 });
    pty.resize(120, 40);
    pty.write(windows
      ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'state.txt'), $env:AB_PTY_TEST); [Console]::Write([char]27 + '[31mPTY_' + 'COLOR' + [char]27 + '[0m'); Start-Sleep -Seconds 60" + String.fromCharCode(13)
      : "printf %s $AB_PTY_TEST > state.txt; printf '\\033[31mPTY_%s\\033[0m' COLOR; sleep 60" + String.fromCharCode(13));
    await vi.waitFor(() => expect(fs.readFileSync(path.join(cwd, "state.txt"), "utf8")).toBe("persist"), { timeout: 10_000 });
    await vi.waitFor(() => expect(output).toContain("PTY_COLOR"));
    expect(output).toContain(String.fromCharCode(27) + "[");
    pty.write(String.fromCharCode(3));
    await new Promise((resolve) => setTimeout(resolve, 500));
    pty.write("exit" + String.fromCharCode(13));
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000 });
  } finally {
    if (!exited) pty.kill();
    data.dispose(); exit.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("closing a real PTY terminates its Shell", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-pty-close-"));
  const pty = await spawnTerminal(cwd, 100, 30);
  let exited = false;
  const exit = pty.onExit(() => { exited = true; });
  try {
    pty.kill();
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000 });
  } finally {
    if (!exited) pty.kill();
    exit.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 15_000);
