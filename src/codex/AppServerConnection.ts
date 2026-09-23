import { ProtocolLineWarning } from "../utils/ProtocolLineWarning.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "pino";
import {
  isNotification,
  isRequest,
  isResponse,
  type AppServerMessage,
  type AppServerRequestId,
  type AppServerResponse,
} from "./protocol.js";

type ServerRequestHandler = (
  params: unknown,
  id: AppServerRequestId,
  method: string,
) => Promise<unknown>;
type NotificationListener = (method: string, params: unknown) => void;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AppServerRequestError extends Error {
  readonly data: unknown;

  constructor(
    readonly method: string,
    readonly code: number,
    readonly serverMessage: string,
    data?: unknown,
  ) {
    super(`${method} failed: ${serverMessage}`);
    this.name = "AppServerRequestError";
    this.data = data;
  }
}

export class AppServerConnection {
  private readonly invalidLineWarning = new ProtocolLineWarning();
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();
  private readonly notificationListeners = new Set<NotificationListener>();

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
  ) {
    this.bindOutput();
    this.process.once("close", () => this.close());
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot send App Server request after connection closed: ${method}`));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`App Server request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
    });
    this.write({ id, method, ...(params === undefined ? {} : { params }) });
    return promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  registerRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(new Error("App Server connection closed."));
    }
    this.pending.clear();
    this.notificationListeners.clear();
  }

  private bindOutput(): void {
    const reader = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    reader.on("line", (line) => {
      if (!line.trim()) return;
      let message: AppServerMessage;
      try {
        message = JSON.parse(line) as AppServerMessage;
      } catch (error) {
        this.invalidLineWarning.warn(this.logger, line, "Ignoring non-JSON App Server stdout line.");
        return;
      }
      this.handleMessage(message);
    });
  }

  private handleMessage(message: AppServerMessage): void {
    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (isRequest(message)) {
      void this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (isNotification(message)) {
      for (const listener of this.notificationListeners) listener(message.method, message.params);
      return;
    }
    this.logger.warn({ message }, "Ignoring unknown App Server message shape.");
  }

  private handleResponse(message: AppServerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger.warn(
        {
          responseId: message.id,
          responseKind: "error" in message ? "error" : "result",
        },
        "Received App Server response for unknown request.",
      );
      return;
    }
    this.pending.delete(message.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if ("error" in message) {
      pending.reject(new AppServerRequestError(
        pending.method,
        message.error.code,
        message.error.message,
        message.error.data,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleServerRequest(id: AppServerRequestId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `Client method is not implemented: ${method}` } });
      return;
    }
    try {
      this.write({ id, result: await handler(params, id, method) });
    } catch (error) {
      this.write({
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private write(message: AppServerMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }
}
