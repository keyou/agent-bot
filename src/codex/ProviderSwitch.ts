import type { RuntimeExecutionSettings } from "../runtime/types.js";

export const PROVIDER_SWITCH_BUSY = "当前任务正在执行，暂时不能切换 Provider。请等待任务完成，或停止任务后重试。";
export const PROVIDER_SWITCH_EMPTY = "无法确认此会话不包含历史、分支或 Goal，未替换任务。请检查原会话状态后重试。";

export class ProviderSwitchError extends Error {
  constructor(message: string, readonly previousSettingsRestored: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderSwitchError";
  }
}

export function assertProviderSettingsApplied(
  actual: { modelProvider?: string; model?: string },
  requested: Partial<Pick<RuntimeExecutionSettings, "modelProvider" | "model">>,
): void {
  if (requested.modelProvider !== undefined && actual.modelProvider !== requested.modelProvider) {
    throw new Error(`Provider 未生效：请求 ${requested.modelProvider}，实际返回 ${actual.modelProvider ?? "未知"}。App Server 未应用设置，请稍后重试；不会自动 Fork 或更改历史。`);
  }
  if (requested.model !== undefined && actual.model !== requested.model) {
    throw new Error(`模型未生效：请求 ${requested.model}，实际返回 ${actual.model ?? "未知"}。请确认目标 Provider 支持该模型。`);
  }
}

export function providerSwitchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/active writer/iu.test(message)) return "任务被另一个 App Server 占用。请在原客户端释放任务后重试。";
  if (/model[^\n]*(?:unsupported|not supported|not found|unavailable|does not exist)|unknown model/iu.test(message)) {
    return `目标 Provider 不支持当前模型，请选择兼容的模型后重试。${message}`;
  }
  if (/unauthorized|forbidden|auth(?:enticat(?:e|ion)|orization)|api.?key|provider[^\n]*(?:not found|unknown|not configured)/iu.test(message)) {
    return `请检查目标 Provider 的配置和认证信息。${message}`;
  }
  return message;
}
