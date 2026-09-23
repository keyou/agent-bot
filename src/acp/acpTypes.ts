export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonValue;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ContentBlockText {
  type: "text";
  text: string;
}

export type ContentBlock = ContentBlockText | Record<string, JsonValue>;

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, JsonValue>;
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  authMethods?: Array<{
    id: string;
    name?: string;
    description?: string;
    type?: string;
  }>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: JsonValue;
}

export interface AcpPromptResult {
  stopReason: string;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: Record<string, JsonValue>;
}

export interface AcpPermissionRequestParams {
  sessionId: string;
  toolCall: Record<string, JsonValue>;
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}
