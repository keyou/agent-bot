import type { Logger } from "pino";
import type { WSClient as LarkWsClient, WSConnectionStatus } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config/schema.js";
import { threadContextKey } from "./contextKey.js";
import { resolveFeishuBotOpenId } from "./FeishuBotIdentity.js";
import { normalizeFeishuPostText, renderFeishuCodeBlock } from "./InboundText.js";
import { allowsFeishuUser } from "./ownerAccess.js";
import type { CardAction, ChatUpdatedEvent, FeishuEventHandler, IncomingMessage } from "./types.js";

type BotOpenIdResolver = (appId: string, appSecret: string) => Promise<string>;
type BotOpenIdListener = (botOpenId: string) => void;

const LARK_WS_PING_TIMEOUT_SECONDS = 60;
const LARK_WS_HANDSHAKE_TIMEOUT_MS = 60_000;

export class FeishuConnector {
  private wsClient?: LarkWsClient;

  constructor(
    private readonly config: AppConfig,
    private readonly handler: FeishuEventHandler,
    private readonly logger: Logger,
    private readonly botOpenIdResolver: BotOpenIdResolver = resolveFeishuBotOpenId,
    private readonly onBotOpenId?: BotOpenIdListener,
  ) {}

  async start(): Promise<void> {
    const { appId, appSecret } = this.config.feishu;
    if (!appId || !appSecret) {
      throw new Error("Feishu appId/appSecret are required.");
    }

    const respondToAllGroupMessages = this.config.feishu.respondToAllGroupMessages !== false;
    let botOpenId: string | undefined;
    if (!respondToAllGroupMessages || this.onBotOpenId) {
      try {
        botOpenId = await this.botOpenIdResolver(appId, appSecret);
        this.onBotOpenId?.(botOpenId);
      } catch (error) {
        if (!respondToAllGroupMessages) throw error;
        this.logger.warn({ error }, "Failed to resolve the Lark bot Open ID for the Agent environment.");
      }
    }
    await this.startFeishuWs(appId, appSecret, botOpenId, !respondToAllGroupMessages);
  }

  stop(): void {
    this.wsClient?.close();
    this.wsClient = undefined;
  }

  getConnectionStatus(): WSConnectionStatus | undefined {
    return this.wsClient?.getConnectionStatus();
  }

  private async startFeishuWs(
    appId: string,
    appSecret: string,
    botOpenId?: string,
    requireMention = false,
  ): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");
    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const senderOpenId = getFeishuEvent(data)?.sender?.sender_id?.open_id;
        if (!allowsFeishuUser(this.config, senderOpenId)) {
          this.logger.debug(
            { messageId: getFeishuEvent(data)?.message?.message_id },
            "Ignored a Feishu message from a non-owner.",
          );
          return;
        }
        const message = toIncomingMessage(data, botOpenId, requireMention);
        if (!message) {
          this.logger.debug({ data }, "Ignored unsupported Feishu message event.");
          return;
        }

        void Promise.resolve()
          .then(() => this.handler.onMessage(message))
          .catch((error: unknown) => {
            this.logger.error({ error, messageId: message.messageId }, "Failed to handle Feishu message event.");
          });
      },
      "im.chat.updated_v1": async (data: unknown) => {
        const update = toChatUpdatedEvent(data);
        if (!update) {
          this.logger.debug({ data }, "Ignored Feishu chat update without a name change.");
          return;
        }
        if (!this.handler.onChatUpdated) return;

        void Promise.resolve()
          .then(() => this.handler.onChatUpdated!(update))
          .catch((error: unknown) => {
            this.logger.error(
              { error, chatId: update.chatId, afterName: update.afterName },
              "Failed to handle Feishu chat name update.",
            );
          });
      },
      "card.action.trigger": async (data: unknown) => {
        const receivedAt = Date.now();
        const operatorOpenId = getFeishuEvent(data)?.operator?.open_id;
        if (!allowsFeishuUser(this.config, operatorOpenId)) {
          this.logger.debug(
            { actionId: getEventId(data) },
            "Ignored a Feishu card action from a non-owner.",
          );
          return {};
        }
        const action = toCardAction(data);
        if (!action) {
          this.logger.debug({ data }, "Ignored unsupported Feishu card action.");
          return {};
        }

        this.deferCardAction(action, receivedAt);
        this.logger.debug(
          { actionId: action.actionId, messageId: action.messageId, responsePreparedInMs: Date.now() - receivedAt },
          "Prepared the Feishu card action acknowledgement.",
        );
        return {
          toast: {
            type: "success",
            content: "已处理",
          },
        };
      },
    });
    let resolveInitialConnection!: () => void;
    let rejectInitialConnection!: (error: Error) => void;
    let initialConnectionSettled = false;
    const initialConnection = new Promise<void>((resolve, reject) => {
      resolveInitialConnection = resolve;
      rejectInitialConnection = reject;
    });
    let wsClient: LarkWsClient | undefined;
    wsClient = new lark.WSClient({
      appId,
      appSecret,
      handshakeTimeoutMs: LARK_WS_HANDSHAKE_TIMEOUT_MS,
      wsConfig: {
        pingTimeout: LARK_WS_PING_TIMEOUT_SECONDS,
      },
      onReady: () => {
        if (initialConnectionSettled) return;
        initialConnectionSettled = true;
        resolveInitialConnection();
      },
      onError: (error) => {
        this.logger.error(
          { error, connectionStatus: wsClient?.getConnectionStatus() },
          "Feishu WebSocket connection failed.",
        );
        if (initialConnectionSettled) return;
        initialConnectionSettled = true;
        rejectInitialConnection(error);
      },
      onReconnecting: () => {
        this.logger.warn(
          { connectionStatus: wsClient?.getConnectionStatus() },
          "Feishu WebSocket connection lost; reconnecting.",
        );
      },
      onReconnected: () => {
        this.logger.info("Feishu WebSocket connection restored.");
      },
    });
    this.wsClient = wsClient;
    try {
      await wsClient.start({ eventDispatcher });
      const initialStatus = wsClient.getConnectionStatus();
      if ((initialStatus.state === "idle" || initialStatus.state === "failed") && !initialConnectionSettled) {
        throw new Error(`Feishu WebSocket failed to start (state: ${initialStatus.state}).`);
      }
      await initialConnection;
      const connectedStatus = wsClient.getConnectionStatus();
      if (connectedStatus.state !== "connected") {
        throw new Error(`Feishu WebSocket failed to become ready (state: ${connectedStatus.state}).`);
      }
      this.logger.info(
        { connectionStatus: connectedStatus },
        "Feishu WebSocket connector started.",
      );
    } catch (error) {
      wsClient.close({ force: true });
      if (this.wsClient === wsClient) this.wsClient = undefined;
      throw error;
    }
  }

  private deferCardAction(action: CardAction, receivedAt: number): void {
    setImmediate(() => {
      const startedAt = Date.now();
      this.logger.debug(
        { actionId: action.actionId, messageId: action.messageId, dispatchDelayMs: startedAt - receivedAt },
        "Started deferred Feishu card action handling.",
      );
      void Promise.resolve()
        .then(() => this.handler.onCardAction(action))
        .then(() => {
          this.logger.debug(
            { actionId: action.actionId, messageId: action.messageId, durationMs: Date.now() - startedAt },
            "Completed Feishu card action handling.",
          );
        })
        .catch((error: unknown) => {
          this.logger.error({ error, actionId: action.actionId }, "Failed to handle Feishu card action.");
        });
    });
  }
}

function toChatUpdatedEvent(data: unknown): ChatUpdatedEvent | undefined {
  const event = getFeishuEvent(data);
  const chatId = typeof event?.chat_id === "string" ? event.chat_id : undefined;
  const beforeName = typeof event?.before_change?.name === "string" ? event.before_change.name : undefined;
  const afterName = typeof event?.after_change?.name === "string" ? event.after_change.name : undefined;
  if (!chatId || !afterName || beforeName === afterName) return undefined;
  return {
    chatId,
    ...(beforeName !== undefined ? { beforeName } : {}),
    afterName,
  };
}

function toIncomingMessage(
  data: unknown,
  botOpenId?: string,
  requireMention = false,
): IncomingMessage | undefined {
  const event = getFeishuEvent(data);
  const message = event?.message;
  if (!message) {
    return undefined;
  }

  const messageType = message.message_type;
  const content = parseJsonObject(message.content);
  const parsed = parseMessageContent(messageType, content, message.mentions);
  if (!parsed) return undefined;
  const chatId = message.chat_id;
  const chatType = message.chat_type === "group" ? "group" : "p2p";
  const mentionedBot = chatType === "group"
    && Boolean(botOpenId)
    && mentionsOpenId(message.mentions, botOpenId!);
  if (chatType === "group" && requireMention && !mentionedBot) {
    return undefined;
  }
  const threadId = typeof message.thread_id === "string" && message.thread_id ? message.thread_id : undefined;
  const rootMessageId = typeof message.root_id === "string" && message.root_id ? message.root_id : undefined;
  const parentMessageId = typeof message.parent_id === "string" && message.parent_id ? message.parent_id : undefined;
  const threadContext = Boolean(chatId && threadId);
  const senderId =
    event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id ?? event.sender?.sender_id?.union_id;

  if (!chatId && !senderId) {
    return undefined;
  }

  const messageId = message.message_id ?? `${Date.now()}`;
  return {
    messageId,
    contextKey: chatId
      ? threadContext
        ? threadContextKey(chatId, threadId!)
        : `chat_id:${chatId}`
      : `open_id:${senderId}`,
    chatId,
    chatType,
    userId: senderId,
    ...(threadId ? { replyInThread: true as const } : {}),
    ...(threadContext ? { threadContext: true as const } : {}),
    ...(threadId ? { threadId } : {}),
    ...(rootMessageId ? { rootMessageId } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
    ...(mentionedBot ? { mentionedBot: true as const } : {}),
    text: parsed.text,
    ...(parsed.images.length > 0 ? { images: parsed.images.map((imageKey) => ({ imageKey })) } : {}),
    ...(parsed.files.length > 0 ? { files: parsed.files } : {}),
    ...(parsed.mergedForward ? { mergedForwardMessageId: messageId } : {}),
  };
}

function mentionsOpenId(value: unknown, openId: string): boolean {
  return Array.isArray(value) && value.some((mention) => {
    if (!isRecord(mention)) return false;
    if (mention.id === openId || mention.open_id === openId) return true;
    return isRecord(mention.id) && mention.id.open_id === openId;
  });
}

function parseMessageContent(
  messageType: unknown,
  content: Record<string, unknown>,
  mentions: unknown,
): {
  text: string;
  images: string[];
  files: Array<{ fileKey: string; fileName: string }>;
  mergedForward?: true;
} | undefined {
  if (messageType === "text") {
    const rawText = typeof content.text === "string" ? content.text : "";
    return { text: normalizeFeishuPostText(stripLeadingMentions(rawText, mentions)), images: [], files: [] };
  }
  if (messageType === "image") {
    const imageKey = typeof content.image_key === "string" ? content.image_key : undefined;
    return imageKey ? { text: "", images: [imageKey], files: [] } : undefined;
  }
  if (messageType === "file") {
    const fileKey = typeof content.file_key === "string" ? content.file_key : undefined;
    const fileName = typeof content.file_name === "string" && content.file_name.trim()
      ? content.file_name.trim()
      : "file";
    return fileKey ? { text: "", images: [], files: [{ fileKey, fileName }] } : undefined;
  }
  if (messageType === "merge_forward") {
    return { text: "", images: [], files: [], mergedForward: true };
  }
  if (messageType !== "post") return undefined;

  const locale = selectPostLocale(content);
  if (!locale) return undefined;
  const paragraphs: string[] = [];
  const title = typeof locale.title === "string" ? normalizeFeishuPostText(locale.title) : "";
  if (title) paragraphs.push(title);
  const images: string[] = [];
  const rows = Array.isArray(locale.content) ? locale.content : locale.content_v2;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      let rowText = "";
      let preserveFormatting = false;
      for (const element of row) {
        if (!isRecord(element)) continue;
        if ((element.tag === "text" || element.tag === "a") && typeof element.text === "string") {
          rowText += element.text;
        } else if (element.tag === "md" && typeof element.text === "string") {
          rowText += element.text;
          preserveFormatting = true;
        } else if (element.tag === "code_block" && typeof element.text === "string") {
          rowText += renderFeishuCodeBlock(element.text, element.language);
          preserveFormatting = true;
        } else if (element.tag === "img" && typeof element.image_key === "string") {
          images.push(element.image_key);
        }
      }
      const normalizedRow = preserveFormatting
        ? rowText.replace(/\r\n?/gu, "\n").trim()
        : normalizeFeishuPostText(rowText);
      if (normalizedRow) paragraphs.push(normalizedRow);
    }
  }
  return { text: paragraphs.join("\n"), images: [...new Set(images)], files: [] };
}

function selectPostLocale(content: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Array.isArray(content.content) || Array.isArray(content.content_v2)) return content;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    if (isRecord(content[locale])) return content[locale];
  }
  return Object.values(content).find(isRecord);
}

function stripLeadingMentions(text: string, value: unknown): string {
  if (!Array.isArray(value)) return text;
  const mentionKeys = value.flatMap((mention): string[] => {
    if (!isRecord(mention) || typeof mention.key !== "string" || !mention.key) return [];
    return [mention.key];
  });
  let remaining = text.trimStart();
  while (remaining) {
    const key = mentionKeys.find((candidate) => {
      if (!remaining.startsWith(candidate)) return false;
      const next = remaining[candidate.length];
      return next === undefined || /\s/u.test(next);
    });
    if (!key) break;
    remaining = remaining.slice(key.length).trimStart();
  }
  return remaining;
}

function toCardAction(data: unknown) {
  const event = getFeishuEvent(data);
  if (!event?.action) {
    return undefined;
  }

  const openId = event.operator?.open_id ?? event.operator?.user_id;
  const chatId = event.context?.open_chat_id ?? event.chat_id;
  return {
    actionId: getEventId(data) ?? event.action.action_id ?? event.action.name ?? `${Date.now()}`,
    contextKey: chatId ? `chat_id:${chatId}` : `open_id:${openId}`,
    userId: openId,
    ...(typeof event.context?.open_message_id === "string" ? { messageId: event.context.open_message_id } : {}),
    value: getCardActionValue(event.action),
  };
}

function getCardActionValue(action: Record<string, unknown>): Record<string, unknown> {
  if (action.tag === "overflow" && typeof action.option === "string") {
    const option = parseJsonObject(action.option);
    if (Object.keys(option).length > 0) return option;
  }
  const value = isRecord(action.value) ? action.value : {};
  return isRecord(action.form_value)
    ? { ...value, formValue: action.form_value }
    : value;
}

function getEventId(data: unknown): string | undefined {
  const value = getNested<unknown>(data, ["header", "event_id"]) ?? getNested(data, ["data", "header", "event_id"]);
  return typeof value === "string" ? value : undefined;
}

function getFeishuEvent(data: unknown): Record<string, any> | undefined {
  return getNested<Record<string, any>>(data, ["event"]) ?? getNested(data, ["data", "event"]) ?? asRecord(data);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getNested<T>(value: unknown, path: string[]): T | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return isRecord(value) ? value : undefined;
}
