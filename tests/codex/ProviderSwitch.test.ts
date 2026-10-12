import { describe, expect, test } from "vitest";
import { AppServerRequestError } from "../../src/codex/AppServerConnection.js";
import {
  assertProviderSettingsApplied,
  ProviderSwitchError,
  providerSwitchFailure,
} from "../../src/codex/ProviderSwitch.js";

describe("assertProviderSettingsApplied", () => {
  test.each([
    [{ modelProvider: "azure", model: "gpt-test" }, { modelProvider: "azure", model: "gpt-test" }],
    [{ modelProvider: "azure", model: "old-model" }, { modelProvider: "azure" }],
    [{ modelProvider: "observed", model: "gpt-test" }, { model: "gpt-test" }],
    [{ modelProvider: "observed", model: "observed-model" }, {}],
    [{}, { modelProvider: undefined, model: undefined }],
  ])("accepts matching known settings and leaves unspecified fields unconstrained (%j, %j)", (actual, requested) => {
    expect(() => assertProviderSettingsApplied(actual, requested)).not.toThrow();
  });

  test.each([
    [{ modelProvider: "openai", model: "gpt-test" }, { modelProvider: "azure", model: "gpt-test" }],
    [{ modelProvider: "openai" }, { modelProvider: "azure" }],
    [{ model: "gpt-test" }, { modelProvider: "azure", model: "gpt-test" }],
  ])("rejects a missing or mismatched known Provider independently of model (%j, %j)", (actual, requested) => {
    expect(() => assertProviderSettingsApplied(actual, requested)).toThrow("Provider 未生效");
    expect(() => assertProviderSettingsApplied(actual, requested)).toThrow("安全重启");
    expect(() => assertProviderSettingsApplied(actual, requested)).toThrow("不会自动 Fork 或更改历史");
  });

  test.each([
    [{ modelProvider: "azure", model: "wrong" }, { modelProvider: "azure", model: "gpt-test" }],
    [{ model: "wrong" }, { model: "gpt-test" }],
    [{}, { model: "gpt-test" }],
  ])("rejects a missing or mismatched known model independently of Provider (%j, %j)", (actual, requested) => {
    expect(() => assertProviderSettingsApplied(actual, requested)).toThrow("模型未生效");
  });
});

describe("providerSwitchFailure", () => {
  test.each([
    "unauthorized", "forbidden", "authentication failed", "failed to authenticate",
    "authorization denied", "missing API key", "provider not configured", "provider unknown",
  ])("explains configuration and authentication failures: %s", (message) => {
    expect(providerSwitchFailure(new Error(message))).toBe(`请检查目标 Provider 的配置和认证信息。${message}`);
  });

  test.each(["unknown model", "model x is unsupported", "model x not found"])("explains unsupported models: %s", (message) => {
    expect(providerSwitchFailure(new Error(message))).toBe(`目标 Provider 不支持当前模型，请选择兼容的模型后重试。${message}`);
  });

  test("distinguishes active writer conflicts without claiming ownership from unsubscribe status", () => {
    expect(providerSwitchFailure(new AppServerRequestError("thread/resume", -1, "thread already has an active writer")))
      .toBe("任务被另一个 App Server 占用。请在原客户端释放任务后重试。");
    expect(providerSwitchFailure(new Error("notSubscribed"))).toBe("notSubscribed");
    expect(providerSwitchFailure("connection closed")).toBe("connection closed");
  });
});

describe("ProviderSwitchError", () => {
  test.each([true, false])("preserves explicit recovery status %s and cause", (previousSettingsRestored) => {
    const cause = new Error("upstream failure");
    const error = new ProviderSwitchError("switch rejected", previousSettingsRestored, { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ProviderSwitchError", message: "switch rejected", previousSettingsRestored });
    expect(error.cause).toBe(cause);
  });
});
