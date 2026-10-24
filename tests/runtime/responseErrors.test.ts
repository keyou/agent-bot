import { describe, expect, test } from "vitest";
import { displayRuntimeError, isResponseContinuationError, sameRuntimeError } from "../../src/runtime/responseErrors.js";

const error = { type: "error", status: 400, error: { message: "Persisted response cannot be replayed.",
  type: "invalid_request_error", param: "previous_response_id", code: "unsupported_persisted_item_context" } };

describe("Responses errors", () => {
  test("recognizes only the exact structured continuation rejection", () => {
    expect(isResponseContinuationError(JSON.stringify(error))).toBe(true);
    for (const value of [
      error.error.message, "unsupported_persisted_item_context", "{invalid JSON}",
      JSON.stringify({ ...error, status: 401 }),
      JSON.stringify({ ...error, error: { ...error.error, param: "input" } }),
      JSON.stringify({ ...error, error: { ...error.error, code: "invalid_api_key" } }),
      JSON.stringify({ ...error, error: { ...error.error, type: "authentication_error" } }),
      JSON.stringify(error) + "\n\nOther detail",
    ]) expect(isResponseContinuationError(value)).toBe(false);
  });

  test("extracts the message and diagnostic identifiers, retaining the recovery notice", () => {
    const notice = "\n\n模型续接状态失效，正在恢复连接并继续（1/1）。";
    expect(displayRuntimeError(JSON.stringify(error) + notice)).toBe(
      "Persisted response cannot be replayed.\nHTTP 400 · unsupported_persisted_item_context · previous_response_id" + notice);
    const prefix = "运行请求失败，等待 Agent 返回最终状态：";
    expect(displayRuntimeError(prefix + JSON.stringify(error))).toBe(prefix + displayRuntimeError(JSON.stringify(error)));
    expect(displayRuntimeError("Failure\n\nDetails")).toBe("Failure\n\nDetails");
    expect(displayRuntimeError(JSON.stringify({ status: 400, error: "not a Responses envelope" })))
      .toBe(JSON.stringify({ status: 400, error: "not a Responses envelope" }));
  });

  test("compares complete errors without discarding different upstream details", () => {
    const text = JSON.stringify(error);
    expect(sameRuntimeError(text, text + "\n\n模型续接状态失效，正在恢复连接并继续（1/1）。")).toBe(true);
    expect(sameRuntimeError(text, text + "\n\nA different upstream failure")).toBe(false);
    expect(sameRuntimeError("Failure", "Failure\n\n检测到临时模型服务错误，正在自动重试（1/3）。")).toBe(true);
    expect(sameRuntimeError("Failure", "Failure\n\nNew cause")).toBe(false);
    expect(sameRuntimeError(text, JSON.stringify({ ...error, error: { ...error.error, message: "Different failure" } }))).toBe(false);
    expect(sameRuntimeError(text, JSON.stringify({ ...error, error: { ...error.error, request_id: "different" } }))).toBe(false);
  });
});
