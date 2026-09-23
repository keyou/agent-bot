import { ProtocolLineWarning } from "../utils/ProtocolLineWarning.js";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type JsonValue,
} from "./acpTypes.js";

type ClientMethodHandler = (params: JsonValue | undefined) => Promise<JsonValue>;

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  method: string;
}

export interface AcpJsonRpcConnectionEvents {
  notification: [method: string, params: JsonValue | undefined];
  request: [method: string, params: JsonValue | undefined];
  close: [];
}

export class AcpJsonRpcConnection extends EventEmitter {
  private readonly invalidLineWarning = new ProtocolLineWarning();
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly handlers = new Map<string, ClientMethodHandler>();
  private closed = false;

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
  ) {
    super();
    this.bindOutput();
  }

  on<K extends keyof AcpJsonRpcConnectionEvents>(
    eventName: K,
    listener: (...args: AcpJsonRpcConnectionEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  registerHandler(method: string, handler: ClientMethodHandler): void {
    this.handlers.set(method, handler);
  }

  async request<T = JsonValue>(
    method: string,
    params?: JsonValue,
    timeoutMs = 0,
  ): Promise<T> {
    if (this.closed) {
      throw new Error(`Cannot send ACP request after connection closed: ${method}`);
    }

    const id = this.nextId++;
    const responsePromise = new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });

    this.write({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    if (timeoutMs <= 0) {
      return (await responsePromise) as T;
    }

    return (await Promise.race([
      responsePromise,
      new Promise<JsonValue>((_resolve, reject) => {
        setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs);
      }),
    ])) as T;
  }

  notify(method: string, params?: JsonValue): void {
    if (this.closed) {
      return;
    }

    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("ACP connection closed."));
    }
    this.pending.clear();
    this.emit("close");
  }

  private bindOutput(): void {
    const reader = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    reader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      this.handleLine(line);
    });

    this.process.once("close", () => this.close());
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.invalidLineWarning.warn(this.logger, line, "Ignoring non-JSON ACP stdout line.");
      return;
    }

    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isJsonRpcRequest(message)) {
      void this.handleRequest(message.id, message.method, message.params);
      return;
    }

    if (isJsonRpcNotification(message)) {
      this.emit("notification", message.method, message.params);
      return;
    }

    this.logger.warn({ message }, "Ignoring unknown ACP message shape.");
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger.warn({ message }, "Received ACP response for unknown request.");
      return;
    }

    this.pending.delete(message.id);
    if ("error" in message) {
      pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleRequest(
    id: string | number,
    method: string,
    params: JsonValue | undefined,
  ): Promise<void> {
    this.emit("request", method, params);
    const handler = this.handlers.get(method);
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Client method is not implemented by Agent Bot: ${method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(params);
      this.write({
        jsonrpc: "2.0",
        id,
        result,
      });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private write(message: JsonRpcMessage): void {
    const serialized = JSON.stringify(message);
    this.process.stdin.write(`${serialized}\n`, "utf8");
  }
}
