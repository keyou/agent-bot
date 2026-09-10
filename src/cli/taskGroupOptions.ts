import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";

export interface TaskNewGroupOptions {
  reference: string;
  title?: string;
  cwd?: string;
  agentName?: string;
  projectless: boolean;
  sessionId?: string;
  json: boolean;
}

export type TaskNewOptions = Omit<TaskNewGroupOptions, "sessionId">;

export interface TaskForkGroupOptions {
  reference: string;
  title?: string;
  json: boolean;
}

export function parseTaskNewGroupOptions(
  input: string[],
  language: CliLanguage = cliLanguage,
): TaskNewGroupOptions {
  return parseTaskCreationOptions(input, "newgroup", language);
}

export function parseTaskNewOptions(
  input: string[],
  action: "new" | "newgroup" = "new",
  language: CliLanguage = cliLanguage,
): TaskNewOptions {
  const { sessionId: _sessionId, ...options } = parseTaskCreationOptions(
    input,
    action,
    language,
  );
  return options;
}

function parseTaskCreationOptions(
  input: string[],
  action: "new" | "newgroup",
  language: CliLanguage,
): TaskNewGroupOptions {
  const positionals: string[] = [];
  let cwd: string | undefined;
  let agentName: string | undefined;
  let projectless = false;
  let sessionId: string | undefined;
  let json = false;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--nodir") {
      if (projectless) throw optionError(action, "--nodir", language);
      if (cwd !== undefined) throw conflictingProjectOptions(action, language);
      projectless = true;
      continue;
    }
    if (argument === "--dir") {
      if (projectless) throw conflictingProjectOptions(action, language);
      if (cwd !== undefined) throw optionError(action, "--dir", language);
      const directory = input[index + 1];
      if (!directory || directory.startsWith("--")) {
        throw new Error(cliText(
          `task ${action} requires a project directory after --dir.`,
          `task ${action} 需要在 --dir 后指定项目目录。`,
          language,
        ));
      }
      cwd = directory;
      index += 1;
      continue;
    }
    if (argument === "--agent") {
      if (agentName !== undefined) throw optionError(action, "--agent", language);
      const name = input[index + 1];
      if (!name?.trim() || name.startsWith("--")) {
        throw new Error(cliText(
          `task ${action} requires an Agent standard name after --agent.`,
          `task ${action} 需要在 --agent 后指定 Agent 标准名。`,
          language,
        ));
      }
      agentName = name.trim();
      index += 1;
      continue;
    }
    if (argument === "--session" && action === "newgroup") {
      if (sessionId !== undefined) throw optionError(action, "--session", language);
      const reference = input[index + 1];
      if (!reference || reference.startsWith("--")) {
        throw new Error(cliText(
          "task newgroup requires an App Server Session ID after --session.",
          "task newgroup 需要在 --session 后指定 App Server Session ID。",
          language,
        ));
      }
      sessionId = reference;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw unsupportedOption(action, argument, language);
    positionals.push(argument);
  }
  const [reference, ...titleParts] = positionals;
  requireTaskReference(action, reference, language);
  if (sessionId && (cwd !== undefined || projectless)) {
    throw new Error(cliText(
      "task newgroup cannot combine --session with --dir or --nodir.",
      "task newgroup 的 --session 不能和 --dir 或 --nodir 一起使用。",
      language,
    ));
  }
  return {
    reference,
    title: titleParts.join(" ").trim() || undefined,
    cwd,
    ...(agentName ? { agentName } : {}),
    projectless,
    ...(sessionId ? { sessionId } : {}),
    json,
  };
}

export function parseTaskForkGroupOptions(
  input: string[],
  language: CliLanguage = cliLanguage,
): TaskForkGroupOptions {
  const positionals: string[] = [];
  let json = false;
  for (const argument of input) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument.startsWith("--")) throw unsupportedOption("forkgroup", argument, language);
    positionals.push(argument);
  }
  const [reference, ...titleParts] = positionals;
  requireTaskReference("forkgroup", reference, language);
  return {
    reference,
    title: titleParts.join(" ").trim() || undefined,
    json,
  };
}

function requireTaskReference(
  action: "new" | "newgroup" | "forkgroup",
  reference: string | undefined,
  language: CliLanguage,
): asserts reference is string {
  if (reference && !reference.startsWith("--")) return;
  throw new Error(cliText(
    `task ${action} requires a source task number or task ID.`,
    `task ${action} 需要源任务序号或任务 ID。`,
    language,
  ));
}

function optionError(
  action: "new" | "newgroup",
  option: "--agent" | "--dir" | "--nodir" | "--session",
  language: CliLanguage,
): Error {
  return new Error(cliText(
    `task ${action} accepts ${option} only once.`,
    `task ${action} 只能指定一次 ${option}。`,
    language,
  ));
}

function conflictingProjectOptions(action: "new" | "newgroup", language: CliLanguage): Error {
  return new Error(cliText(
    `task ${action} cannot combine --dir and --nodir.`,
    `task ${action} 的 --dir 和 --nodir 不能同时使用。`,
    language,
  ));
}

function unsupportedOption(
  action: "new" | "newgroup" | "forkgroup",
  option: string,
  language: CliLanguage,
): Error {
  return new Error(cliText(
    `task ${action} does not support option: ${option}.`,
    `task ${action} 不支持参数：${option}。`,
    language,
  ));
}
