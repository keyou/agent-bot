import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { defaultSqlitePath } from "../config/paths.js";
import type { AppConfig } from "../config/schema.js";
import { normalizeFeishuMarkdown } from "./FeishuMarkdown.js";
import { LOCAL_CARD_IMAGE_PATH } from "./LocalCardImage.js";
import { renderMarkdownWithLocalImages } from "./LocalImageMarkdown.js";
import { splitFinalResponseBranding } from "./FinalResponseBranding.js";
import {
  renderMergedForwardPrompt,
  renderReferencedMessage,
  type MergedForwardContent,
  type MergedForwardMessageItem,
  type ReferencedMessageContent,
} from "./MergedForwardMessage.js";
import type {
  CreatedGroup,
  CreateGroupInput,
  FeishuOutbound,
  MessageReplyTarget,
} from "./types.js";

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface SendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id?: string;
  };
  error?: unknown;
}

interface CreateGroupResponse {
  code: number;
  msg: string;
  data?: {
    chat_id?: string;
  };
  error?: unknown;
}

interface DeleteGroupResponse {
  code: number;
  msg: string;
  data?: Record<string, never>;
  error?: unknown;
}

interface UploadImageResponse {
  code: number;
  msg: string;
  data?: {
    image_key?: string;
  };
  error?: unknown;
}

interface UploadFileResponse {
  code: number;
  msg: string;
  data?: {
    file_key?: string;
  };
  error?: unknown;
}

interface ReactionResponse {
  code: number;
  msg: string;
  data?: {
    reaction_id?: string;
  };
  error?: unknown;
}

interface DownloadImageErrorResponse {
  code: number;
  msg: string;
  error?: unknown;
}

interface GetMessageResponse {
  code: number;
  msg: string;
  data?: {
    items?: MergedForwardMessageItem[];
  };
  error?: unknown;
}

export class FeishuMessageClient implements FeishuOutbound {
  private token?: {
    value: string;
    expiresAt: number;
  };
  private readonly sendQueues = new Map<string, Promise<void>>();
  private readonly cardUpdateQueues = new Map<string, Promise<void>>();
  private readonly lastSendAt = new Map<string, number>();
  private readonly imageUploads = new Map<string, { mtimeMs: number; upload: Promise<string> }>();
  private readonly imageDownloads = new Map<string, Promise<string>>();
  private readonly fileDownloads = new Map<string, Promise<string>>();
  private readonly minSendIntervalMs = 1200;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async createGroup(input: CreateGroupInput): Promise<CreatedGroup> {
    try {
      const token = await this.getTenantAccessToken();
      const avatar = input.avatarPng
        ? await this.uploadImageBytes(input.avatarPng, "avatar", "group-avatar.png")
        : undefined;
      const response = await fetch(
        "https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            chat_mode: "group",
            chat_type: "private",
            name: input.name,
            user_id_list: [input.userOpenId],
            ...(avatar ? { avatar } : {}),
          }),
        },
      );
      const payload = (await response.json()) as CreateGroupResponse;
      const chatId = payload.data?.chat_id;
      if (!response.ok || payload.code !== 0 || !chatId) {
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          "create group",
          response.status,
        );
      }
      return { chatId, name: input.name };
    } catch (error) {
      throw normalizeTransportError(error, "create group");
    }
  }

  async deleteGroup(chatId: string): Promise<void> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const payload = (await response.json()) as DeleteGroupResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          "delete group",
          response.status,
        );
      }
    } catch (error) {
      throw normalizeTransportError(error, "delete group");
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        },
      );
      const payload = (await response.json()) as ReactionResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "add reaction", response.status);
      }
      return payload.data?.reaction_id;
    } catch (error) {
      throw normalizeTransportError(error, "add reaction");
    }
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const payload = (await response.json()) as ReactionResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "delete reaction", response.status);
      }
    } catch (error) {
      throw normalizeTransportError(error, "delete reaction");
    }
  }

  async downloadImage(messageId: string, imageKey: string): Promise<string> {
    const cacheKey = `${messageId}:${imageKey}`;
    const cached = this.imageDownloads.get(cacheKey);
    if (cached) return cached;
    const download = this.downloadImageNow(messageId, imageKey).catch((error: unknown) => {
      if (this.imageDownloads.get(cacheKey) === download) this.imageDownloads.delete(cacheKey);
      throw error;
    });
    this.imageDownloads.set(cacheKey, download);
    return download;
  }

  async downloadFile(messageId: string, fileKey: string, fileName: string): Promise<string> {
    const cacheKey = `${messageId}:${fileKey}`;
    const cached = this.fileDownloads.get(cacheKey);
    if (cached) return cached;
    const download = this.downloadFileNow(messageId, fileKey, fileName).catch((error: unknown) => {
      if (this.fileDownloads.get(cacheKey) === download) this.fileDownloads.delete(cacheKey);
      throw error;
    });
    this.fileDownloads.set(cacheKey, download);
    return download;
  }

  async readMergedForward(messageId: string): Promise<MergedForwardContent> {
    const items = await this.readMessageItems(messageId, "read merged forward");
    return renderMergedForwardPrompt(messageId, items);
  }

  async readReferencedMessage(messageId: string): Promise<ReferencedMessageContent> {
    const items = await this.readMessageItems(messageId, "read referenced message");
    return renderReferencedMessage(messageId, items);
  }

  private async readMessageItems(messageId: string, operation: string): Promise<MergedForwardMessageItem[]> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = (await response.json()) as GetMessageResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          operation,
          response.status,
        );
      }
      return payload.data?.items ?? [];
    } catch (error) {
      throw normalizeTransportError(error, operation);
    }
  }

  async sendText(contextKey: string, text: string): Promise<string | undefined> {
    return this.sendMessage(contextKey, "text", { text });
  }

  async sendFile(contextKey: string, filePath: string): Promise<string | undefined> {
    const fileKey = await this.uploadFile(filePath);
    return this.sendMessage(contextKey, "file", { file_key: fileKey });
  }

  async sendMarkdown(contextKey: string, markdown: string, idempotencyKey?: string): Promise<string | undefined> {
    const normalizedMarkdown = normalizeFeishuMarkdown(markdown);
    const elements = await this.renderFinalAnswerElements(normalizedMarkdown);
    return this.sendMessage(
      contextKey,
      "interactive",
      finalAnswerCard(elements),
      idempotencyKey,
      normalizedMarkdown,
    );
  }

  async sendInteractiveCard(
    contextKey: string,
    card: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.sendMessage(contextKey, "interactive", await this.prepareInteractiveCard(card), idempotencyKey);
  }

  async replyText(
    contextKey: string,
    target: MessageReplyTarget,
    text: string,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.replyMessage(contextKey, target, "text", { text }, idempotencyKey);
  }

  async replyFile(
    contextKey: string,
    target: MessageReplyTarget,
    filePath: string,
  ): Promise<string | undefined> {
    const fileKey = await this.uploadFile(filePath);
    return this.replyMessage(contextKey, target, "file", { file_key: fileKey });
  }

  async replyMarkdown(
    contextKey: string,
    target: MessageReplyTarget,
    markdown: string,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    const normalizedMarkdown = normalizeFeishuMarkdown(markdown);
    const elements = await this.renderFinalAnswerElements(normalizedMarkdown);
    return this.replyMessage(
      contextKey,
      target,
      "interactive",
      finalAnswerCard(elements),
      idempotencyKey,
      normalizedMarkdown,
    );
  }

  async replyInteractiveCard(
    contextKey: string,
    target: MessageReplyTarget,
    card: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.replyMessage(
      contextKey,
      target,
      "interactive",
      await this.prepareInteractiveCard(card),
      idempotencyKey,
    );
  }

  private async renderFinalAnswerElements(markdown: string): Promise<Array<Record<string, unknown>>> {
    const { content, branding } = splitFinalResponseBranding(markdown);
    const elements = content
      ? await renderMarkdownWithLocalImages(
        content,
        (filePath) => this.uploadImageCached(filePath),
        (error, filePath) => this.logger.warn({ error, filePath }, "Failed to upload local image to Feishu."),
      )
      : [];
    if (!branding) return elements;
    return [
      ...elements,
      { tag: "hr" },
      { tag: "markdown", content: branding, text_size: "notation" },
    ];
  }

  async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.enqueueCardUpdate(messageId, async () => {
      const preparedCard = await this.prepareInteractiveCard(card);
      await this.updateInteractiveCardNow(messageId, preparedCard);
    });
  }

  private async updateInteractiveCardNow(
    messageId: string,
    card: Record<string, unknown>,
    allowAuditFallback = true,
  ): Promise<void> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      });
      const payload = (await response.json()) as SendMessageResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "update", response.status);
      }
    } catch (error) {
      const normalized = normalizeTransportError(error, "update");
      const fallback = allowAuditFallback && normalized.isEmailAddressAuditFailure
        ? sanitizeEmailAddressesInContent(card)
        : undefined;
      if (fallback) {
        this.logger.warn(
          { code: normalized.code, messageId },
          "Feishu rejected a card update as email-sensitive; retrying with audit-safe text.",
        );
        await this.updateInteractiveCardNow(messageId, fallback, false);
        return;
      }
      throw normalized;
    }
  }

  private async sendMessage(
    contextKey: string,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
    cardTableLimitFallbackText?: string,
  ): Promise<string | undefined> {
    return this.enqueueSend(contextKey, async () => {
      try {
        return await this.sendMessageNow(contextKey, msgType, content, idempotencyKey);
      } catch (error) {
        const normalized = normalizeTransportError(error, "send");
        if (!cardTableLimitFallbackText || !normalized.isCardTableLimitFailure) throw error;
        this.logger.warn(
          { code: normalized.code, contextKey },
          "Feishu rejected a card with too many tables; retrying as text.",
        );
        return this.sendMessageNow(
          contextKey,
          "text",
          { text: cardTableLimitFallbackText },
          idempotencyKey,
        );
      }
    });
  }

  private async replyMessage(
    contextKey: string,
    target: MessageReplyTarget,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
    cardTableLimitFallbackText?: string,
  ): Promise<string | undefined> {
    return this.enqueueSend(contextKey, async () => {
      try {
        return await this.replyMessageNow(target, msgType, content, idempotencyKey);
      } catch (error) {
        const normalized = normalizeTransportError(error, "reply");
        if (!cardTableLimitFallbackText || !normalized.isCardTableLimitFailure) throw error;
        this.logger.warn(
          { code: normalized.code, messageId: target.messageId },
          "Feishu rejected a reply card with too many tables; retrying as text.",
        );
        return this.replyMessageNow(
          target,
          "text",
          { text: cardTableLimitFallbackText },
          idempotencyKey,
        );
      }
    });
  }

  private async replyMessageNow(
    target: MessageReplyTarget,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
    allowAuditFallback = true,
  ): Promise<string | undefined> {
    let token: string;
    try {
      token = await this.getTenantAccessToken();
    } catch (error) {
      throw normalizeTransportError(error, "reply");
    }
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await delay(5000 * attempt);

      let error: FeishuApiError;
      try {
        const response = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}/reply`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              msg_type: msgType,
              content: JSON.stringify(content),
              reply_in_thread: target.replyInThread,
              ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
            }),
          },
        );
        const payload = (await response.json()) as SendMessageResponse;
        if (response.ok && payload.code === 0) return payload.data?.message_id;
        error = new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "reply", response.status);
      } catch (caught) {
        error = normalizeTransportError(caught, "reply");
      }
      lastError = error;

      if (!error.isRetryable || attempt === 2) {
        const fallback = allowAuditFallback && error.isEmailAddressAuditFailure
          ? sanitizeEmailAddressesInContent(content)
          : undefined;
        if (fallback) {
          this.logger.warn(
            { code: error.code, messageId: target.messageId, msgType },
            "Feishu rejected a reply as email-sensitive; retrying with audit-safe text.",
          );
          return this.replyMessageNow(target, msgType, fallback, idempotencyKey, false);
        }
        this.logger.error({ error, messageId: target.messageId, msgType }, "Failed to reply to Feishu message.");
        throw error;
      }
      this.logger.warn(
        { code: error.code, messageId: target.messageId, msgType, attempt: attempt + 1 },
        "Retryable Feishu reply failure; retrying after backoff.",
      );
    }

    throw lastError ?? new Error("Failed to reply to Feishu message.");
  }

  private async sendMessageNow(
    contextKey: string,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
    allowAuditFallback = true,
  ): Promise<string | undefined> {
    let token: string;
    try {
      token = await this.getTenantAccessToken();
    } catch (error) {
      throw normalizeTransportError(error, "send");
    }
    const { receiveId, receiveIdType } = parseContextKey(contextKey);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await delay(5000 * attempt);
      }

      let error: FeishuApiError;
      try {
        const response = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              receive_id: receiveId,
              msg_type: msgType,
              content: JSON.stringify(content),
              ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
            }),
          },
        );
        const payload = (await response.json()) as SendMessageResponse;
        if (response.ok && payload.code === 0) return payload.data?.message_id;
        error = new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "send", response.status);
      } catch (caught) {
        error = normalizeTransportError(caught, "send");
      }
      lastError = error;

      if (!error.isRetryable || attempt === 2) {
        const fallback = allowAuditFallback && error.isEmailAddressAuditFailure
          ? sanitizeEmailAddressesInContent(content)
          : undefined;
        if (fallback) {
          this.logger.warn(
            { code: error.code, contextKey, msgType },
            "Feishu rejected a message as email-sensitive; retrying with audit-safe text.",
          );
          return this.sendMessageNow(contextKey, msgType, fallback, idempotencyKey, false);
        }
        this.logger.error({ error, contextKey, msgType }, "Failed to send Feishu message.");
        throw error;
      }

      this.logger.warn(
        { code: error.code, contextKey, msgType, attempt: attempt + 1 },
        "Retryable Feishu send failure; retrying after backoff.",
      );
    }

    throw lastError ?? new Error("Failed to send Feishu message.");
  }

  private enqueueSend<T>(contextKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sendQueues.get(contextKey) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const lastSendAt = this.lastSendAt.get(contextKey) ?? 0;
      const elapsed = Date.now() - lastSendAt;
      if (elapsed < this.minSendIntervalMs) {
        await delay(this.minSendIntervalMs - elapsed);
      }

      const result = await task();
      this.lastSendAt.set(contextKey, Date.now());
      return result;
    });

    const stored = queued.then(
      () => undefined,
      () => undefined,
    );
    this.sendQueues.set(contextKey, stored);
    stored.finally(() => {
      if (this.sendQueues.get(contextKey) === stored) {
        this.sendQueues.delete(contextKey);
      }
    });

    return queued;
  }

  private enqueueCardUpdate(messageId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.cardUpdateQueues.get(messageId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(task);
    const stored = queued.then(
      () => undefined,
      () => undefined,
    );
    this.cardUpdateQueues.set(messageId, stored);
    stored.finally(() => {
      if (this.cardUpdateQueues.get(messageId) === stored) {
        this.cardUpdateQueues.delete(messageId);
      }
    });
    return queued;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) {
      return this.token.value;
    }

    const appId = this.config.feishu.appId;
    const appSecret = this.config.feishu.appSecret;
    if (!appId || !appSecret) {
      throw new Error("Feishu appId/appSecret are required for real Feishu messaging.");
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
    });

    const payload = (await response.json()) as TenantTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Failed to get Feishu tenant_access_token: ${payload.msg || response.statusText}`);
    }

    this.token = {
      value: payload.tenant_access_token,
      expiresAt: now + (payload.expire ?? 7200) * 1000,
    };

    return this.token.value;
  }

  private async uploadImage(filePath: string): Promise<string> {
    try {
      const contents = await readFile(filePath);
      return await this.uploadImageBytes(contents, "message", path.basename(filePath));
    } catch (error) {
      throw normalizeTransportError(error, "upload image");
    }
  }

  private async uploadFile(filePath: string): Promise<string> {
    const fileName = path.basename(filePath);
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw new Error(`Not a regular file: ${fileName}`);
      if (fileStats.size === 0) throw new Error(`Feishu does not accept empty files: ${fileName}`);
      if (fileStats.size > 30 * 1024 * 1024) {
        throw new Error(`File exceeds Feishu's 30 MiB limit: ${fileName}`);
      }

      const contents = await readFile(filePath);
      const token = await this.getTenantAccessToken();
      const form = new FormData();
      form.append("file_type", "stream");
      form.append("file_name", fileName);
      const bytes = new ArrayBuffer(contents.byteLength);
      new Uint8Array(bytes).set(contents);
      form.append("file", new Blob([bytes]), fileName);
      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const payload = (await response.json()) as UploadFileResponse;
      const fileKey = payload.data?.file_key;
      if (!response.ok || payload.code !== 0 || !fileKey) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "upload file", response.status);
      }
      return fileKey;
    } catch (error) {
      throw normalizeTransportError(error, "upload file");
    }
  }

  private async uploadImageBytes(
    contents: Uint8Array,
    imageType: "message" | "avatar",
    fileName: string,
  ): Promise<string> {
    if (contents.byteLength > 10 * 1024 * 1024) {
      throw new Error(`Image exceeds Feishu's 10 MiB limit: ${fileName}`);
    }
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.append("image_type", imageType);
    const bytes = new ArrayBuffer(contents.byteLength);
    new Uint8Array(bytes).set(contents);
    form.append("image", new Blob([bytes]), fileName);
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const payload = (await response.json()) as UploadImageResponse;
    const imageKey = payload.data?.image_key;
    if (!response.ok || payload.code !== 0 || !imageKey) {
      throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "upload image", response.status);
    }
    return imageKey;
  }

  private async downloadImageNow(messageId: string, imageKey: string): Promise<string> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({
          code: response.status,
          msg: response.statusText,
        })) as DownloadImageErrorResponse;
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          "download image",
          response.status,
        );
      }

      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`Feishu returned an unexpected image content type: ${contentType || "unknown"}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("Feishu returned an empty image.");
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Feishu image exceeds the 20 MiB input limit.");

      const sqlitePath = this.config.storage?.sqlitePath ?? defaultSqlitePath();
      const directory = path.join(path.dirname(sqlitePath), "inbound-images");
      await mkdir(directory, { recursive: true });
      const digest = createHash("sha256").update(`${messageId}:${imageKey}`).digest("hex");
      const filePath = path.join(directory, `${digest}${imageExtension(contentType)}`);
      await writeFile(filePath, bytes);
      return filePath;
    } catch (error) {
      throw normalizeTransportError(error, "download image");
    }
  }

  private async downloadFileNow(messageId: string, fileKey: string, fileName: string): Promise<string> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({
          code: response.status,
          msg: response.statusText,
        })) as DownloadImageErrorResponse;
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          "download file",
          response.status,
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("Feishu returned an empty file.");
      const sqlitePath = this.config.storage?.sqlitePath ?? defaultSqlitePath();
      const directory = path.join(path.dirname(sqlitePath), "inbound-files");
      await mkdir(directory, { recursive: true });
      const digest = createHash("sha256").update(`${messageId}:${fileKey}`).digest("hex").slice(0, 16);
      const safeName = safeInboundFileName(fileName);
      const filePath = path.join(directory, `${digest}-${safeName}`);
      await writeFile(filePath, bytes);
      return filePath;
    } catch (error) {
      throw normalizeTransportError(error, "download file");
    }
  }

  private async uploadImageCached(filePath: string): Promise<string> {
    const cacheKey = path.resolve(filePath);
    const mtimeMs = (await stat(cacheKey)).mtimeMs;
    const cached = this.imageUploads.get(cacheKey);
    if (cached?.mtimeMs === mtimeMs) return cached.upload;
    const upload = this.uploadImage(cacheKey).catch((error: unknown) => {
      if (this.imageUploads.get(cacheKey)?.upload === upload) this.imageUploads.delete(cacheKey);
      throw error;
    });
    this.imageUploads.set(cacheKey, { mtimeMs, upload });
    return upload;
  }

  private async prepareInteractiveCard(card: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.prepareCardValue(card) as Record<string, unknown>;
  }

  private async prepareCardValue(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.prepareCardValue(item)));
    if (!isRecord(value)) return value;
    const localImagePath = value[LOCAL_CARD_IMAGE_PATH];
    if (value.tag === "img" && typeof localImagePath === "string") {
      const image = { ...value };
      delete image[LOCAL_CARD_IMAGE_PATH];
      try {
        image.img_key = await this.uploadImageCached(localImagePath);
        return image;
      } catch (error) {
        this.logger.warn({ error, filePath: localImagePath }, "Failed to upload local card image to Feishu.");
        return { tag: "markdown", content: `图片加载失败：${cardImageLabel(value)}` };
      }
    }
    const prepared: Record<string, unknown> = {};
    await Promise.all(Object.entries(value).map(async ([key, child]) => {
      prepared[key] = await this.prepareCardValue(child);
    }));
    return prepared;
  }
}

export class FeishuApiError extends Error {
  readonly isRateLimit: boolean;
  readonly isRetryable: boolean;
  readonly isEmailAddressAuditFailure: boolean;
  readonly isCardTableLimitFailure: boolean;

  constructor(
    message: string,
    readonly code: number,
    readonly payload:
      | SendMessageResponse
      | CreateGroupResponse
      | DeleteGroupResponse
      | UploadImageResponse
      | UploadFileResponse
      | ReactionResponse
      | DownloadImageErrorResponse,
    operation = "send",
    readonly httpStatus?: number,
    forceRetryable = false,
  ) {
    super(`Failed to ${operation} Feishu message: ${message}`);
    this.name = "FeishuApiError";
    this.isRateLimit = code === 230020 || message.toLowerCase().includes("frequency limit");
    this.isRetryable = forceRetryable || this.isRateLimit || (httpStatus !== undefined && httpStatus >= 500);
    this.isEmailAddressAuditFailure = code === 230028 && message.includes("EMAIL_ADDRESS");
    this.isCardTableLimitFailure = code === 230099
      && /table number over limit|ErrorValue:\s*table/iu.test(message);
  }
}

function imageExtension(contentType: string): string {
  switch (contentType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    case "image/tiff": return ".tiff";
    default: return ".img";
  }
}

function safeInboundFileName(value: string): string {
  const baseName = path.basename(value.trim() || "file");
  const sanitized = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .slice(0, 180)
    || "file";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
}

function normalizeTransportError(error: unknown, operation: string): FeishuApiError {
  if (error instanceof FeishuApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FeishuApiError(message, 0, { code: 0, msg: message, error }, operation, undefined, true);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseContextKey(contextKey: string): { receiveIdType: string; receiveId: string } {
  const [receiveIdType, receiveId] = contextKey.split(":", 2);
  if (!receiveIdType || !receiveId) {
    throw new Error(`Invalid contextKey for Feishu receive_id: ${contextKey}`);
  }

  return { receiveIdType, receiveId };
}

function finalAnswerCard(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    body: {
      elements,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeEmailAddressesInContent(content: Record<string, unknown>): Record<string, unknown> | undefined {
  let changed = false;
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") {
      const sanitized = value.replace(
        /\b([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})\b/gi,
        "$1 [at] $2",
      );
      if (sanitized !== value) changed = true;
      return sanitized;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
  };
  const sanitized = sanitize(content) as Record<string, unknown>;
  return changed ? sanitized : undefined;
}

function cardImageLabel(image: Record<string, unknown>): string {
  const alt = image.alt;
  if (isRecord(alt) && typeof alt.content === "string" && alt.content.trim()) return alt.content;
  return "view_image 图片";
}
