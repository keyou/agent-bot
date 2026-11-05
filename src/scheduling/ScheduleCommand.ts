import type {
  ScheduleCommand,
  ScheduleInput,
  ScheduleOperation,
} from "./types.js";

const operations = new Set<ScheduleOperation>([
  "list",
  "add",
  "edit",
  "show",
  "history",
  "pause",
  "resume",
  "run",
  "delete",
]);

export function parseScheduleCommand(args: string[]): ScheduleCommand {
  const [operation = "list", ...rest] = args;
  if (!operations.has(operation as ScheduleOperation))
    throw new Error(
      "定时任务操作：list、add、edit、show、history、pause、resume、run、delete。",
    );
  if (operation === "add" || operation === "edit") {
    const id = operation === "edit" ? rest.shift() : undefined;
    if (operation === "edit" && (!id || id.startsWith("--")))
      throw new Error("请指定计划 ID。");
    const values: Record<string, string> = {};
    const allowed = new Set([
      "--name",
      "--prompt",
      "--cron",
      "--at",
      "--timezone",
      "--max-delay",
      "--catch-up",
    ]);
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index]!;
      const value = rest[index + 1];
      if (
        !allowed.has(key) ||
        value === undefined ||
        value.startsWith("--") ||
        values[key] !== undefined
      ) {
        throw new Error(`无效或重复的定时任务参数：${key}`);
      }
      values[key] = value;
    }
    const input: ScheduleInput = {
      prompt: values["--prompt"] ?? "",
      ...(values["--name"] !== undefined ? { name: values["--name"] } : {}),
      ...(values["--cron"] !== undefined ? { cron: values["--cron"] } : {}),
      ...(values["--at"] !== undefined ? { at: values["--at"] } : {}),
      ...(values["--timezone"] !== undefined
        ? { timeZone: values["--timezone"] }
        : {}),
      ...(values["--max-delay"] !== undefined
        ? { maxDelayMinutes: Number(values["--max-delay"]) }
        : {}),
      ...(values["--catch-up"] !== undefined
        ? { catchUpMinutes: Number(values["--catch-up"]) }
        : {}),
    };
    return { operation, id, input };
  }
  if (operation === "list") {
    if (rest.length) throw new Error("schedule list 不接受位置参数。");
    return { operation };
  }
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--"))
    throw new Error("请指定一个计划 ID。");
  return { operation: operation as ScheduleOperation, id: rest[0] };
}
