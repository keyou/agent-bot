import type { Command } from "./commandTypes.js";

export const COMMAND_NAMES = [
  "agent",
  "archive",
  "dir",
  "dismiss",
  "file",
  "fork",
  "forkgroup",
  "goal",
  "help",
  "model",
  "mute",
  "new",
  "newgroup",
  "nosteer",
  "permissions",
  "provider",
  "queue",
  "release",
  "restart",
  "sessions",
  "status",
  "stop",
  "switch",
  "thinking",
  "title",
  "turns",
] as const;

type CommandName = (typeof COMMAND_NAMES)[number];

const COMMAND_INITIALISMS: Partial<Record<CommandName, string>> = {
  dir: "di",
  forkgroup: "fg",
  newgroup: "ng",
  nosteer: "ns",
};

const DISABLED_COMMAND_NAMES = new Set(["mode", "modes"]);

export class CommandRouter {
  parse(text: string): Command {
    const trimmed = text.trim();
    if (trimmed.startsWith("!") || trimmed.startsWith("！")) {
      const command = trimmed.slice(1).trim();
      if (!command) throw new Error("请输入要执行的命令，例如：! ls 或 ！ls");
      return { type: "shell", command };
    }
    if (!trimmed.startsWith("/")) {
      return { type: "prompt", text };
    }

    const [rawCommand, ...args] = splitArgs(trimmed);
    const command = resolveCommandName(rawCommand);

    switch (command) {
      case "dir":
        return { type: "dir", directory: args.join(" ").trim() || undefined };
      case "file": {
        const filePath = args.join(" ").trim();
        if (!filePath) throw new Error("请输入文件路径，例如：/file ./report.pdf。");
        return { type: "file", filePath };
      }
      case "new":
        return parseNewCommand(args);
      case "newgroup":
        return parseNewGroupCommand(args);
      case "forkgroup":
        return parseForkGroupCommand(args);
      case "fork":
        return parseForkCommand(args);
      case "title":
        if (args.length === 0) throw new Error("请输入新标题，例如：/title 修复会话列表。");
        return { type: "title", title: args.join(" ") };
      case "queue":
      case "nosteer": {
        const prompt = trimmed.slice(rawCommand.length).trim();
        if (!prompt) throw new Error(`请输入要排队的 Prompt，例如：/${command} 完成后再运行全部测试。`);
        return { type: "nosteer", text: prompt };
      }
      case "sessions":
        return { type: "sessions", searchTerm: trimmed.slice(rawCommand.length).trim() || undefined };
      case "switch":
        return args[0] ? { type: "switch", sessionId: args[0] } : { type: "switch" };
      case "agent":
        return args[0] ? { type: "agent", agent: args[0] } : { type: "agent" };
      case "archive":
        rejectOptions("/archive", args);
        if (args.length > 1) throw new Error("/archive 只接受一个可选的任务序号或任务 ID。");
        return args[0] ? { type: "archive", sessionId: args[0] } : { type: "archive" };
      case "dismiss":
        if (args.length > 0) throw new Error("/dismiss 不接受参数，请在确认卡片中完成操作。");
        return { type: "dismiss" };
      case "stop":
        return { type: "stop" };
      case "status":
        return args[0] ? { type: "status", sessionId: args[0] } : { type: "status" };
      case "goal": {
        if (args.length === 0) return { type: "goal", action: "show" };
        const action = args[0]!.toLowerCase();
        if (action === "pause" || action === "resume" || action === "clear") {
          if (args.length > 1) throw new Error(`/goal ${action} 不接受额外参数。`);
          return { type: "goal", action };
        }
        if (action === "edit") {
          const objective = args.slice(1).join(" ").trim();
          if (!objective) throw new Error("请输入修改后的 Goal，例如：/goal edit 完成迁移并通过全部测试。");
          return { type: "goal", action: "edit", objective };
        }
        return { type: "goal", action: "set", objective: args.join(" ") };
      }
      case "restart":
        if (args.length === 0) return { type: "restart" };
        if (args.length === 1 && args[0] === "--force") return { type: "restart", force: true };
        throw new Error("/restart 只接受一个可选的 --force 参数。");
      case "release":
        if (args.length > 0) throw new Error("/release 不接受参数。");
        return { type: "release" };
      case "mute": {
        if (args.length === 0 || (args.length === 1 && args[0]!.toLowerCase() === "on")) {
          return { type: "mute", enabled: true };
        }
        if (args.length === 1 && args[0]!.toLowerCase() === "off") {
          return { type: "mute", enabled: false };
        }
        throw new Error("/mute 只接受 on 或 off；不传参数等同于 /mute on。");
      }
      case "turns":
        rejectOptions("/turn", args);
        if (args.length > 1) throw new Error("/turn 只接受一个可选的 Turn ID 或序号。");
        if (args[0] && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(args[0])
          && (!/^\d+$/.test(args[0]) || !Number.isSafeInteger(Number(args[0])) || Number(args[0]) < 1)) {
          throw new Error("Turn 序号必须是从 1 开始的正整数。");
        }
        return args[0] ? { type: "turns", turnReference: args[0] } : { type: "turns" };
      case "model":
        return settingsCommand("/model", args, { type: "model" });
      case "provider":
        return settingsCommand("/provider", args, { type: "provider" });
      case "thinking":
        return settingsCommand("/thinking", args, { type: "thinking" });
      case "permissions":
        return settingsCommand("/permissions", args, { type: "permissions" });
      case "help":
        return { type: "help" };
    }
  }
}

function resolveCommandName(rawCommand: string): CommandName {
  const input = rawCommand.slice(1).toLowerCase();
  if (!input) throw unknownCommand(rawCommand);
  if (DISABLED_COMMAND_NAMES.has(input)) throw unknownCommand(rawCommand);

  const exact = COMMAND_NAMES.find((command) => command === input);
  if (exact) return exact;

  const initialism = COMMAND_NAMES.find((command) => COMMAND_INITIALISMS[command] === input);
  if (initialism) return initialism;

  const matches = COMMAND_NAMES.filter(
    (command) => command.startsWith(input) || COMMAND_INITIALISMS[command] === input,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `命令前缀 ${rawCommand} 不唯一，可匹配：${matches.map((command) => `/${command}`).join("、")}。请输入更长的命令前缀。`,
    );
  }
  throw unknownCommand(rawCommand);
}

function unknownCommand(rawCommand: string): Error {
  return new Error(`未知命令：${rawCommand}。发送 /help 查看可用命令。`);
}

function settingsCommand<T extends Command>(name: string, args: string[], command: T): T {
  if (args.length > 0) {
    throw new Error(`${name} 不接受参数，请在设置卡片中完成选择。`);
  }
  return command;
}

function parseNewCommand(args: string[]): Extract<Command, { type: "new" }> {
  const options = parseNewTaskOptions("/new", args, "工作目录", "D:\\dev\\project");
  return {
    type: "new",
    title: options.title,
    cwd: options.cwd,
    ...(options.projectless ? { projectless: true } : {}),
  };
}

function parseNewGroupCommand(args: string[]): Extract<Command, { type: "newgroup" }> {
  const options = parseNewTaskOptions("/newgroup", args, "项目目录", "~/dev/project");
  return {
    type: "newgroup",
    title: options.title,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.projectless ? { projectless: true } : {}),
  };
}

function parseNewTaskOptions(
  commandName: "/new" | "/newgroup",
  args: string[],
  directoryLabel: string,
  exampleDirectory: string,
): { title?: string; cwd?: string; projectless: boolean } {
  const titleParts: string[] = [];
  let cwd: string | undefined;
  let projectless = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--nodir") {
      if (projectless) throw new Error(`${commandName} 只能指定一次 --nodir。`);
      if (cwd !== undefined) throw new Error(`${commandName} 的 --dir 和 --nodir 不能同时使用。`);
      projectless = true;
      continue;
    }
    if (argument !== "--dir") {
      titleParts.push(argument);
      continue;
    }
    if (projectless) throw new Error(`${commandName} 的 --dir 和 --nodir 不能同时使用。`);
    if (cwd !== undefined) throw new Error(`${commandName} 只能指定一次 --dir。`);
    const directory = args[index + 1];
    if (!directory || directory === "--dir" || directory === "--nodir") {
      throw new Error(
        `请在 --dir 后指定${directoryLabel}，例如：${commandName} 修复会话列表 --dir ${exampleDirectory}。`,
      );
    }
    cwd = directory;
    index += 1;
  }
  return {
    title: titleParts.join(" ").trim() || undefined,
    cwd,
    projectless,
  };
}

function parseForkCommand(args: string[]): Extract<Command, { type: "fork" }> {
  rejectOptions("/fork", args);
  if (args.length > 1) throw new Error("/fork 只接受一个可选的任务序号或任务 ID。");
  return {
    type: "fork",
    ...(args[0] ? { sessionId: args[0] } : {}),
  };
}

function parseForkGroupCommand(args: string[]): Extract<Command, { type: "forkgroup" }> {
  rejectOptions("/forkgroup", args);
  return {
    type: "forkgroup",
    title: args.join(" ").trim() || undefined,
  };
}

function rejectOptions(command: string, args: string[]): void {
  for (const argument of args) {
    if (argument.startsWith("--")) throw new Error(`${command} 不支持参数：${argument}。`);
  }
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}
