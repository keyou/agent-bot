import { AppServerRequestError } from "./AppServerConnection.js";
import type { RuntimeExecutionSettings } from "../runtime/types.js";

export const PROVIDER_SWITCH_BUSY = "当前任务正在执行，暂时不能切换 Provider。请等待任务完成，或停止任务后重试。";

export function isMissingRolloutError(error: unknown): boolean {
  if (error instanceof AppServerRequestError && error.method !== "thread/resume") return false;
  const message = error instanceof AppServerRequestError ? error.serverMessage
    : error instanceof Error ? error.message : String(error);
  if (/paginated history lineage|missing source rollout/iu.test(message)) return false;
  return /no rollout found|rollout[^\n]*(?:not found|missing)/iu.test(message);
}

export function assertProviderSettingsApplied(
  actual: { modelProvider?: string; model?: string },
  requested: Pick<RuntimeExecutionSettings, "modelProvider" | "model">,
): void {
  if (actual.modelProvider !== requested.modelProvider) {
    throw new Error(`Provider 未生效：请求 ${requested.modelProvider}，实际返回 ${actual.modelProvider ?? "未知"}。`);
  }
  if (actual.model !== requested.model) {
    throw new Error(`模型未生效：请求 ${requested.model}，实际返回 ${actual.model ?? "未知"}。请确认目标 Provider 支持该模型。`);
  }
}

export function providerSwitchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/active writer/iu.test(message)) return "任务被另一个 App Server 占用。请在原客户端释放任务后重试。";
  if (/model[^\n]*(?:unsupported|not supported|not found|unavailable|does not exist)|unknown model/iu.test(message)) {
    return `目标 Provider 不支持当前模型，请选择兼容的模型后重试。${message}`;
  }
  if (/unauthorized|forbidden|auth(?:entication|orization)|api.?key|provider[^\n]*(?:not found|unknown|not configured)/iu.test(message)) {
    return `请检查目标 Provider 的配置和认证信息。${message}`;
  }
  return message;
}
