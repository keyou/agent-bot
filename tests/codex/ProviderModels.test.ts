import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchProviderModels } from "../../src/codex/ProviderModels.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProviderModels", () => {
  test("reads an OpenAI-compatible Provider model list with configured authentication and metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "shared-model", display_name: "Shared from Provider" },
        {
          id: "provider-default",
          display_name: "Provider Default",
          is_default: true,
          supported_reasoning_efforts: ["low", { reasoning_effort: "high", description: "Deep" }],
          default_reasoning_effort: "high",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchProviderModels({
      providerId: "custom",
      config: {
        base_url: "https://provider.example/v1?existing=yes",
        env_key: "PROVIDER_TOKEN",
        experimental_bearer_token: "fallback-token",
        query_params: { "api-version": "2026-09-10" },
        http_headers: { "X-Static": "static-value" },
        env_http_headers: { "X-Environment": "PROVIDER_HEADER" },
      },
      catalog: [{
        id: "shared-model",
        displayName: "Shared Catalog Model",
        supportedReasoningEfforts: [{ value: "medium" }],
        defaultReasoningEffort: "medium",
      }],
      environmentValue: (name) => ({
        PROVIDER_TOKEN: "environment-token",
        PROVIDER_HEADER: "environment-value",
      })[name],
    });

    const [requestedUrl, request] = (fetchMock.mock.calls as unknown as Array<[URL, RequestInit?]>)[0]!;
    expect(String(requestedUrl)).toBe("https://provider.example/v1/models?existing=yes&api-version=2026-09-10");
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBe("Bearer environment-token");
    expect(headers.get("x-static")).toBe("static-value");
    expect(headers.get("x-environment")).toBe("environment-value");
    expect(models).toEqual([
      {
        id: "shared-model",
        displayName: "Shared from Provider",
        supportedReasoningEfforts: [{ value: "medium" }],
        defaultReasoningEffort: "medium",
      },
      {
        id: "provider-default",
        displayName: "Provider Default",
        isDefault: true,
        supportedReasoningEfforts: [{ value: "low" }, { value: "high", description: "Deep" }],
        defaultReasoningEffort: "high",
      },
    ]);
  });

  test("uses a configured default only when the Provider returns it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "first" }, { id: "configured" }],
    }), { status: 200 })));

    await expect(fetchProviderModels({
      providerId: "custom",
      config: { base_url: "https://provider.example/v1" },
      catalog: [],
      configuredDefaultModel: "configured",
      environmentValue: () => undefined,
    })).resolves.toEqual([
      { id: "first", supportedReasoningEfforts: [] },
      { id: "configured", isDefault: true, supportedReasoningEfforts: [] },
    ]);
  });

  test("does not replace a failed Provider lookup with the global catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchProviderModels({
      providerId: "custom",
      config: { base_url: "https://provider.example/v1", experimental_bearer_token: "secret" },
      catalog: [{ id: "openai-model", supportedReasoningEfforts: [] }],
      environmentValue: () => undefined,
    })).rejects.toThrow("Provider custom 的模型列表请求失败（HTTP 404）");
  });
});
