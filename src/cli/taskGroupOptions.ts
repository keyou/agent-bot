import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";

export interface TaskNewGroupOptions {
  reference: string;
  title?: string;
  cwd?: string;
  agentName?: string;
  projectless: boolean;
  json: boolean;
}

export type TaskNewOptions = TaskNewGroupOptions;

export interface TaskForkGroupOptions {
  reference: string;
  title?: string;
  json: boolean;
}

export function parseTaskNewGroupOptions(
  input: string[],
  language: CliLanguage = cliLanguage,
): TaskNewGroupOptions {
  return parseTaskNewOptions(input, "newgroup", language);
}

export function parseTaskNewOptions(
  input: string[],
  action: "new" | "newgroup" = "new",
  language: CliLanguage = cliLanguage,
): TaskNewOptions {
  const positionals: string[] = [];
  let cwd: string | undefined;
  let agentName: string | undefined;
  let projectless = false;
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
    if (argument.startsWith("--")) throw unsupportedOption(action, argument, language);
    positionals.push(argument);
  }
  const [reference, ...titleParts] = positionals;
  requireTaskReference(action, reference, language);
  return {
    reference,
    title: titleParts.join(" ").trim() || undefined,
    cwd,
    ...(agentName ? { agentName } : {}),
    projectless,
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

export function parseTaskCloneOptions(
  input: string[],
  action: "clone" | "clonegroup",
  language: CliLanguage = cliLanguage,
): TaskForkGroupOptions & { agentName?: string } {
  const positionals: string[] = [];
  let agentName: string | undefined;
  let json = false;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument === "--json") {
      json = true;
    } else if (argument === "--agent") {
      if (agentName !== undefined) throw optionError(action, "--agent", language);
      const name = input[++index];
      if (!name?.trim() || name.startsWith("--")) throw new Error(cliText(
        `task ${action} requires an Agent name after --agent.`,
        `task ${action} 需要在 --agent 后指定 Agent 名称。`, language,
      ));
      agentName = name.trim();
    } else {
      if (argument.startsWith("--")) throw unsupportedOption(action, argument, language);
      positionals.push(argument);
    }
  }
  const [reference, ...title] = positionals;
  requireTaskReference(action, reference, language);
  return { reference, title: title.join(" ").trim() || undefined, agentName, json };
}

function requireTaskReference(
  action: "new" | "newgroup" | "forkgroup" | "clone" | "clonegroup",
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
  action: "new" | "newgroup" | "clone" | "clonegroup",
  option: "--agent" | "--dir" | "--nodir",
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
  action: "new" | "newgroup" | "forkgroup" | "clone" | "clonegroup",
  option: string,
  language: CliLanguage,
): Error {
  return new Error(cliText(
    `task ${action} does not support option: ${option}.`,
    `task ${action} 不支持参数：${option}。`,
    language,
  ));
}
