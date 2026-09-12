import type { ModelOption, ReasoningEffortOption } from "../runtime/types.js";

const PROVIDER_MODEL_LIST_TIMEOUT_MS = 10_000;

export interface ProviderModelConfig {
  base_url?: unknown;
  env_key?: unknown;
  experimental_bearer_token?: unknown;
  query_params?: unknown;
  http_headers?: unknown;
  env_http_headers?: unknown;
  default_model?: unknown;
  model?: unknown;
}

export async function fetchProviderModels(input: {
  providerId: string;
  config: ProviderModelConfig;
  catalog: ModelOption[];
  configuredDefaultModel?: string;
  environmentValue: (name: string) => string | undefined;
}): Promise<ModelOption[]> {
  const baseUrl = stringValue(input.config.base_url)?.trim();
  if (!baseUrl) {
    throw new Error(`Provider ${input.providerId} 没有配置 base_url，无法读取模型列表。`);
  }

  const url = providerModelsUrl(baseUrl, input.config.query_params, input.providerId);
  const headers = providerModelHeaders(input.config, input.environmentValue);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROVIDER_MODEL_LIST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`无法连接 Provider ${input.providerId} 的模型列表，请检查 Provider 服务和网络。`);
  }
  if (!response.ok) {
    throw new Error(`Provider ${input.providerId} 的模型列表请求失败（HTTP ${response.status}）。`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Provider ${input.providerId} 返回了无效的模型列表。`);
  }
  const models = normalizeProviderModels(payload, input.catalog, {
    configuredDefaultModel: input.configuredDefaultModel,
    providerDefaultModel: stringValue(input.config.default_model)?.trim()
      ?? stringValue(input.config.model)?.trim(),
  });
  if (models.length === 0) {
    throw new Error(`Provider ${input.providerId} 没有返回可用模型。`);
  }
  return models;
}

function providerModelsUrl(baseUrl: string, queryParams: unknown, providerId: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Provider ${providerId} 的 base_url 无效，无法读取模型列表。`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Provider ${providerId} 的 base_url 不支持模型发现。`);
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (!/\/models$/iu.test(path)) url.pathname = `${path}/models`;
  if (isRecord(queryParams)) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (!key || value === null || value === undefined || typeof value === "object") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function providerModelHeaders(
  config: ProviderModelConfig,
  environmentValue: (name: string) => string | undefined,
): Headers {
  const headers = new Headers({ Accept: "application/json" });
  appendHeaderValues(headers, config.http_headers, (value) => value);
  appendHeaderValues(headers, config.env_http_headers, environmentValue);
  if (!headers.has("authorization")) {
    const envKey = stringValue(config.env_key)?.trim();
    const token = (envKey ? environmentValue(envKey) : undefined)
      ?? stringValue(config.experimental_bearer_token)?.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function appendHeaderValues(
  headers: Headers,
  values: unknown,
  resolve: (value: string) => string | undefined,
): void {
  if (!isRecord(values)) return;
  for (const [name, rawValue] of Object.entries(values)) {
    const value = stringValue(rawValue)?.trim();
    const resolved = value ? resolve(value)?.trim() : undefined;
    if (name.trim() && resolved) headers.set(name, resolved);
  }
}

function normalizeProviderModels(
  payload: unknown,
  catalog: ModelOption[],
  defaults: { configuredDefaultModel?: string; providerDefaultModel?: string },
): ModelOption[] {
  const root = isRecord(payload) ? payload : undefined;
  const entries = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : Array.isArray(payload)
        ? payload
        : [];
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const normalized = new Map<string, ModelOption>();
  let itemDefaultModel: string | undefined;

  for (const entry of entries) {
    const record = isRecord(entry) ? entry : undefined;
    const id = (typeof entry === "string"
      ? entry
      : stringValue(record?.id) ?? stringValue(record?.model) ?? stringValue(record?.name))?.trim();
    if (!id || normalized.has(id)) continue;
    const catalogModel = catalogById.get(id);
    const efforts = reasoningEfforts(record) ?? catalogModel?.supportedReasoningEfforts ?? [];
    const defaultEffort = stringValue(record?.defaultReasoningEffort)?.trim()
      ?? stringValue(record?.default_reasoning_effort)?.trim()
      ?? catalogModel?.defaultReasoningEffort;
    const displayName = stringValue(record?.displayName)?.trim()
      ?? stringValue(record?.display_name)?.trim()
      ?? (stringValue(record?.name)?.trim() !== id ? stringValue(record?.name)?.trim() : undefined)
      ?? catalogModel?.displayName;
    if (!itemDefaultModel && (record?.isDefault === true || record?.is_default === true || record?.default === true)) {
      itemDefaultModel = id;
    }
    normalized.set(id, {
      id,
      ...(displayName ? { displayName } : {}),
      supportedReasoningEfforts: efforts,
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    });
  }

  const rootDefaultModel = stringValue(root?.defaultModel)?.trim()
    ?? stringValue(root?.default_model)?.trim();
  const defaultModel = [rootDefaultModel, itemDefaultModel, defaults.providerDefaultModel, defaults.configuredDefaultModel]
    .find((candidate) => candidate && normalized.has(candidate));
  if (defaultModel) normalized.set(defaultModel, { ...normalized.get(defaultModel)!, isDefault: true });
  return [...normalized.values()];
}

function reasoningEfforts(record: Record<string, unknown> | undefined): ReasoningEffortOption[] | undefined {
  if (!record) return undefined;
  const raw = record.supportedReasoningEfforts ?? record.supported_reasoning_efforts;
  if (!Array.isArray(raw)) return undefined;
  const efforts = raw.flatMap((entry): ReasoningEffortOption[] => {
    if (typeof entry === "string" && entry.trim()) return [{ value: entry.trim() }];
    if (!isRecord(entry)) return [];
    const value = stringValue(entry.value)?.trim()
      ?? stringValue(entry.reasoningEffort)?.trim()
      ?? stringValue(entry.reasoning_effort)?.trim();
    if (!value) return [];
    const description = stringValue(entry.description)?.trim();
    return [{ value, ...(description ? { description } : {}) }];
  });
  return efforts.length > 0 ? efforts : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
