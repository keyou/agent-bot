import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";

export type TerminalProcess = Pick<IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
export type TerminalSpawner = (cwd: string, cols: number, rows: number) => Promise<TerminalProcess>;

export function terminalShell(
  platform = process.platform, env = process.env, exists = fs.existsSync, loginShell = os.userInfo().shell,
): { file: string; args: string[] } {
  if (platform === "win32") {
    const directories = (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
    const pwsh = directories.map((dir) => path.win32.join(dir, "pwsh.exe")).find(exists);
    if (pwsh) return { file: pwsh, args: ["-NoLogo"] };
    const windows = env.SystemRoot ?? "C:/Windows";
    const powershell = path.win32.join(windows, "System32/WindowsPowerShell/v1.0/powershell.exe");
    return exists(powershell) ? { file: powershell, args: ["-NoLogo"] }
      : { file: path.win32.join(windows, "System32/cmd.exe"), args: [] };
  }
  const file = [env.SHELL, loginShell, platform === "darwin" ? "/bin/zsh" : "/bin/bash", "/bin/sh"]
    .find((candidate): candidate is string => Boolean(candidate && path.posix.isAbsolute(candidate) && exists(candidate)));
  if (!file) throw new Error("No interactive Shell is available.");
  return { file, args: ["-i"] };
}

export function terminalEnvironment(env = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^(FEISHU_|AGENT_BOT(?:_|$)|NODE_OPTIONS$)/i.test(key))),
    TERM: "xterm-256color", COLORTERM: "truecolor",
  };
}

export function prepareTerminalHelper(
  packageRoot: string, arch = process.arch, filesystem: Pick<typeof fs, "existsSync" | "statSync" | "chmodSync"> = fs,
): void {
  // node-pty 1.1.0 ships macOS spawn-helper binaries without executable bits.
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${arch}`]) {
    const helper = path.join(packageRoot, directory, "spawn-helper");
    if (!filesystem.existsSync(helper)) continue;
    const stat = filesystem.statSync(helper);
    if (!stat.isFile()) throw new Error(`Invalid terminal helper: ${helper}`);
    if ((stat.mode & 0o111) === 0o111) continue;
    try { filesystem.chmodSync(helper, (stat.mode & 0o777) | 0o111); } catch (cause) {
      throw new Error(`Terminal helper is not executable: ${helper}. Reinstall node-pty or restore its executable permission.`, { cause });
    }
  }
}

export const spawnTerminal: TerminalSpawner = async (cwd, cols, rows) => {
  if (process.platform === "win32" && Number(os.release().split(".")[2] ?? 0) < 18309) {
    throw new Error("网页终端需要支持 ConPTY 的 Windows 10 1903 / Windows Server 2022 或更新系统。");
  }
  if (!fs.statSync(cwd).isDirectory()) throw new Error("Terminal working directory is not a directory.");
  let pty: typeof import("node-pty");
  try { pty = await import("node-pty"); } catch {
    throw new Error("交互终端组件 node-pty 不可用，请重新安装 AgentBot 的可选依赖（可能需要本机编译工具）。");
  }
  if (process.platform === "darwin") {
    const require = createRequire(import.meta.url);
    prepareTerminalHelper(path.dirname(require.resolve("node-pty/package.json")));
  }
  const shell = terminalShell();
  return pty.spawn(shell.file, shell.args, {
    cwd, cols, rows, name: "xterm-256color", env: terminalEnvironment(), useConpty: true,
    // The bundled ConPTY closes via its input pipe, avoiding node-pty's console-list helper on kill.
    useConptyDll: process.platform === "win32",
  });
};
