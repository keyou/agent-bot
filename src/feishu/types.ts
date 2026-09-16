import type { MergedForwardContent, ReferencedMessageContent } from "./MergedForwardMessage.js";

export type { MergedForwardContent, ReferencedMessageContent } from "./MergedForwardMessage.js";

export interface IncomingMessage {
  messageId: string;
  contextKey: string;
  chatId?: string;
  chatType?: "p2p" | "group";
  userId?: string;
  replyInThread?: boolean;
  threadContext?: true;
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
  mentionedBot?: true;
  text: string;
  images?: IncomingImageReference[];
  files?: IncomingFileReference[];
  mergedForwardMessageId?: string;
  displayText?: string;
}

export interface IncomingImageReference {
  imageKey: string;
}

export interface IncomingFileReference {
  fileKey: string;
  fileName: string;
}

export interface MessageReplyTarget {
  messageId: string;
  replyInThread: true;
}

export interface CreateGroupInput {
  name: string;
  userOpenId: string;
  avatarPng?: Uint8Array;
}

export interface CreatedGroup {
  chatId: string;
  name: string;
}

export interface CardAction {
  actionId: string;
  contextKey: string;
  userId?: string;
  messageId?: string;
  value: Record<string, unknown>;
}

export interface ChatUpdatedEvent {
  chatId: string;
  beforeName?: string;
  afterName: string;
}

export interface FeishuOutbound {
  createGroup?(input: CreateGroupInput): Promise<CreatedGroup>;
  deleteGroup?(chatId: string): Promise<void>;
  addReaction?(messageId: string, emojiType: string): Promise<string | undefined>;
  deleteReaction?(messageId: string, reactionId: string): Promise<void>;
  downloadImage?(messageId: string, imageKey: string): Promise<string>;
  downloadFile?(messageId: string, fileKey: string, fileName: string): Promise<string>;
  readMergedForward?(messageId: string): Promise<MergedForwardContent>;
  readReferencedMessage?(messageId: string): Promise<ReferencedMessageContent>;
  sendText(contextKey: string, text: string): Promise<string | undefined>;
  sendFile?(contextKey: string, filePath: string): Promise<string | undefined>;
  sendMarkdown(contextKey: string, markdown: string, idempotencyKey?: string): Promise<string | undefined>;
  sendInteractiveCard(contextKey: string, card: Record<string, unknown>, idempotencyKey?: string): Promise<string | undefined>;
  replyText?(
    contextKey: string,
    target: MessageReplyTarget,
    text: string,
    idempotencyKey?: string,
  ): Promise<string | undefined>;
  replyFile?(
    contextKey: string,
    target: MessageReplyTarget,
    filePath: string,
  ): Promise<string | undefined>;
  replyMarkdown?(
    contextKey: string,
    target: MessageReplyTarget,
    markdown: string,
    idempotencyKey?: string,
  ): Promise<string | undefined>;
  replyInteractiveCard?(
    contextKey: string,
    target: MessageReplyTarget,
    card: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined>;
  updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export interface FeishuEventHandler {
  onMessage(message: IncomingMessage): Promise<void>;
  onCardAction(action: CardAction): Promise<void>;
  onChatUpdated?(event: ChatUpdatedEvent): Promise<void>;
}
