import { z } from "zod";

export const RUNTIME_WARNING_PREFIXES = ["运行请求失败，等待 Agent 返回最终状态：", "运行请求出错，Agent 正在重试："];

const responseErrorSchema = z.object({
  type: z.literal("error"),
  status: z.number().optional(),
  error: z.object({
    message: z.string().min(1),
    code: z.string().nullish(),
    param: z.string().nullish(),
    type: z.string().nullish(),
  }).passthrough(),
}).passthrough();

function parseResponseError(message: string): { value: z.infer<typeof responseErrorSchema>; notice: string } | undefined {
  // Agent Bot may append a recovery notice after the upstream JSON error.
  const boundary = message.indexOf("\n\n");
  for (const end of [message.length, ...(boundary >= 0 ? [boundary] : [])]) {
    try {
      const parsed = responseErrorSchema.safeParse(JSON.parse(message.slice(0, end)));
      if (parsed.success) return { value: parsed.data, notice: message.slice(end) };
    } catch {
      // Non-JSON runtime errors remain unchanged.
    }
  }
  return undefined;
}

export function isResponseContinuationError(message: string): boolean {
  const parsed = parseResponseError(message);
  return parsed?.value.error.code === "unsupported_persisted_item_context"
    && parsed.value.error.param === "previous_response_id"
    && parsed.value.error.type === "invalid_request_error"
    && parsed.value.status === 400
    && !parsed.notice;
}

export function displayRuntimeError(message: string): string {
  const prefix = RUNTIME_WARNING_PREFIXES.find((value) => message.startsWith(value));
  const parsed = parseResponseError(prefix ? message.slice(prefix.length) : message);
  if (!parsed) return message;
  const { error, status } = parsed.value;
  const details = [status === undefined ? undefined : `HTTP ${status}`, error.code, error.param];
  return (prefix ?? "") + `${error.message}\n${details.filter(Boolean).join(" · ")}${parsed.notice}`.trim();
}

export function sameRuntimeError(warning: string, terminal: string): boolean {
  if (warning.trim() === terminal.trim()) return true;
  const parsed = parseResponseError(terminal);
  if (parsed) {
    const other = parseResponseError(warning);
    return Boolean(other && !other.notice && (!parsed.notice || isRecoveryNotice(parsed.notice))
      && JSON.stringify(other.value) === JSON.stringify(parsed.value));
  }
  const suffix = terminal.slice(warning.trim().length);
  return terminal.startsWith(warning.trim()) && isRecoveryNotice(suffix);
}

function isRecoveryNotice(text: string): boolean {
  return /^\n\n(?:检测到临时模型服务错误，正在自动重试|模型续接状态失效，正在恢复连接并继续|已自动重试)/u.test(text);
}
