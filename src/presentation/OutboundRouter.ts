import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentEvent } from "../runtime/types.js";
import type {
  CreatedGroup,
  CreateGroupInput,
  FeishuOutbound,
  MergedForwardContent,
  MessageReplyTarget,
  ReferencedMessageContent,
} from "../feishu/types.js";

export interface TurnPresenter {
  registerSession(
    sessionId: string,
    contextKey: string,
    taskTitle?: string,
    projectCwd?: string,
    agentLabel?: string,
  ): void;
  updateSessionTitle(sessionId: string, taskTitle: string): void;
  unregisterSession(sessionId: string): void;
  startPendingTurn(
    sessionId: string,
    contextKey: string,
    taskTitle?: string,
    replyTarget?: MessageReplyTarget,
    prompt?: string,
  ): Promise<string | undefined>;
  failPendingTurn(
    sessionId: string,
    message: string,
    replacementCard?: Record<string, unknown>,
  ): Promise<boolean>;
  interruptTurnForRecovery(sessionId: string, contextKey: string, turnId: string, message: string): Promise<void>;
  appendSteerMessage(sessionId: string, turnId: string, text: string, messageId?: string): Promise<void>;
  onEvent(event: AgentEvent): Promise<void>;
  showDetails(contextKey: string, turnId: string): Promise<void>;
  showActivityPage(
    contextKey: string,
    turnId: string,
    page: number | "latest",
    messageId?: string,
  ): Promise<void>;
  resumeDelivery(sessionId: string, contextKey: string, turnId: string): Promise<void>;
  flushAll(): Promise<void>;
}

export interface OutboundRoute {
  matches(contextKey: string): boolean;
  outbound: FeishuOutbound;
  presenter: TurnPresenter;
}

export class OutboundRouter {
  private readonly sessionRoutes = new Map<string, OutboundRoute>();
  private readonly sessionContextKeys = new Map<string, string>();
  private readonly sessionReplyTargets = new Map<string, MessageReplyTarget>();
  private readonly replyTargets = new AsyncLocalStorage<{ contextKey: string; target: MessageReplyTarget }>();

  constructor(private readonly routes: OutboundRoute[]) {
    if (routes.length === 0) throw new Error("At least one outbound route is required.");
  }

  registerSession(
    sessionId: string,
    contextKey: string,
    taskTitle?: string,
    projectCwd?: string,
    agentLabel?: string,
  ): void {
    const route = this.route(contextKey);
    this.sessionRoutes.set(sessionId, route);
    this.sessionContextKeys.set(sessionId, contextKey);
    route.presenter.registerSession(sessionId, contextKey, taskTitle, projectCwd, agentLabel);
  }

  getSessionContextKey(sessionId: string): string | undefined {
    return this.sessionContextKeys.get(sessionId);
  }

  getSessionReplyTarget(sessionId: string): MessageReplyTarget | undefined {
    return this.sessionReplyTargets.get(sessionId);
  }

  canRoute(contextKey: string): boolean {
    return this.routes.some((route) => route.matches(contextKey));
  }

  updateSessionTitle(sessionId: string, taskTitle: string): void {
    this.sessionRoutes.get(sessionId)?.presenter.updateSessionTitle(sessionId, taskTitle);
  }

  unregisterSession(sessionId: string): void {
    const route = this.sessionRoutes.get(sessionId);
    route?.presenter.unregisterSession(sessionId);
    this.sessionRoutes.delete(sessionId);
    this.sessionContextKeys.delete(sessionId);
    this.sessionReplyTargets.delete(sessionId);
  }

  async startPendingTurn(
    sessionId: string,
    contextKey: string,
    taskTitle?: string,
    replyTarget?: MessageReplyTarget,
    prompt?: string,
  ): Promise<string | undefined> {
    const route = this.route(contextKey);
    this.sessionRoutes.set(sessionId, route);
    this.sessionContextKeys.set(sessionId, contextKey);
    if (replyTarget) this.sessionReplyTargets.set(sessionId, replyTarget);
    else this.sessionReplyTargets.delete(sessionId);
    return route.presenter.startPendingTurn(sessionId, contextKey, taskTitle, replyTarget, prompt);
  }

  async failPendingTurn(
    sessionId: string,
    message: string,
    replacementCard?: Record<string, unknown>,
  ): Promise<boolean> {
    return await this.sessionRoutes.get(sessionId)?.presenter.failPendingTurn(
      sessionId,
      message,
      replacementCard,
    ) ?? false;
  }

  async interruptTurnForRecovery(
    sessionId: string,
    contextKey: string,
    turnId: string,
    message: string,
  ): Promise<void> {
    await this.route(contextKey).presenter.interruptTurnForRecovery(sessionId, contextKey, turnId, message);
  }

  async appendSteerMessage(
    sessionId: string,
    turnId: string,
    text: string,
    messageId?: string,
  ): Promise<void> {
    await this.sessionRoutes.get(sessionId)?.presenter.appendSteerMessage(sessionId, turnId, text, messageId);
  }

  async onEvent(event: AgentEvent): Promise<void> {
    await this.sessionRoutes.get(event.sessionId)?.presenter.onEvent(event);
  }

  async showDetails(contextKey: string, turnId: string): Promise<void> {
    await this.route(contextKey).presenter.showDetails(contextKey, turnId);
  }

  async showActivityPage(
    contextKey: string,
    turnId: string,
    page: number | "latest",
    messageId?: string,
  ): Promise<void> {
    await this.route(contextKey).presenter.showActivityPage(contextKey, turnId, page, messageId);
  }

  async resumeDelivery(sessionId: string, contextKey: string, turnId: string): Promise<void> {
    await this.route(contextKey).presenter.resumeDelivery(sessionId, contextKey, turnId);
  }

  async addReaction(contextKey: string, messageId: string, emojiType: string): Promise<string | undefined> {
    return this.route(contextKey).outbound.addReaction?.(messageId, emojiType);
  }

  async deleteReaction(contextKey: string, messageId: string, reactionId: string): Promise<void> {
    await this.route(contextKey).outbound.deleteReaction?.(messageId, reactionId);
  }

  async downloadImage(contextKey: string, messageId: string, imageKey: string): Promise<string> {
    const outbound = this.route(contextKey).outbound;
    const download = outbound.downloadImage;
    if (!download) throw new Error("当前消息通道不支持下载图片。");
    return download.call(outbound, messageId, imageKey);
  }

  async downloadFile(
    contextKey: string,
    messageId: string,
    fileKey: string,
    fileName: string,
  ): Promise<string> {
    const outbound = this.route(contextKey).outbound;
    const download = outbound.downloadFile;
    if (!download) throw new Error("当前消息通道不支持下载文件。");
    return download.call(outbound, messageId, fileKey, fileName);
  }

  async readMergedForward(contextKey: string, messageId: string): Promise<MergedForwardContent> {
    const outbound = this.route(contextKey).outbound;
    const read = outbound.readMergedForward;
    if (!read) throw new Error("当前消息通道不支持读取合并转发消息。");
    return read.call(outbound, messageId);
  }

  async readReferencedMessage(contextKey: string, messageId: string): Promise<ReferencedMessageContent> {
    const outbound = this.route(contextKey).outbound;
    const read = outbound.readReferencedMessage;
    if (!read) throw new Error("当前消息通道不支持读取引用消息。");
    return read.call(outbound, messageId);
  }

  async createGroup(contextKey: string, input: CreateGroupInput): Promise<CreatedGroup> {
    const outbound = this.route(contextKey).outbound;
    const createGroup = outbound.createGroup;
    if (!createGroup) throw new Error("当前消息通道不支持创建飞书群。");
    return createGroup.call(outbound, input);
  }

  async deleteGroup(contextKey: string, chatId: string): Promise<void> {
    const outbound = this.route(contextKey).outbound;
    const deleteGroup = outbound.deleteGroup;
    if (!deleteGroup) throw new Error("当前消息通道不支持解散飞书群。");
    await deleteGroup.call(outbound, chatId);
  }

  withReplyTarget<T>(
    contextKey: string,
    target: MessageReplyTarget | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!target) return operation();
    return this.replyTargets.run({ contextKey, target }, operation);
  }

  sendText(contextKey: string, text: string): Promise<string | undefined> {
    const outbound = this.route(contextKey).outbound;
    const target = this.currentReplyTarget(contextKey);
    return target && outbound.replyText
      ? outbound.replyText(contextKey, target, text)
      : outbound.sendText(contextKey, text);
  }

  sendFile(contextKey: string, filePath: string): Promise<string | undefined> {
    const outbound = this.route(contextKey).outbound;
    const target = this.currentReplyTarget(contextKey);
    if (target) {
      if (!outbound.replyFile) throw new Error("当前消息通道不支持在话题中发送文件。");
      return outbound.replyFile(contextKey, target, filePath);
    }
    if (!outbound.sendFile) throw new Error("当前消息通道不支持发送文件。");
    return outbound.sendFile(contextKey, filePath);
  }

  sendMarkdown(contextKey: string, markdown: string): Promise<string | undefined> {
    const outbound = this.route(contextKey).outbound;
    const target = this.currentReplyTarget(contextKey);
    return target && outbound.replyMarkdown
      ? outbound.replyMarkdown(contextKey, target, markdown)
      : outbound.sendMarkdown(contextKey, markdown);
  }

  sendInteractiveCard(contextKey: string, card: Record<string, unknown>): Promise<string | undefined> {
    const outbound = this.route(contextKey).outbound;
    const target = this.currentReplyTarget(contextKey);
    return target && outbound.replyInteractiveCard
      ? outbound.replyInteractiveCard(contextKey, target, card)
      : outbound.sendInteractiveCard(contextKey, card);
  }

  async updateInteractiveCard(
    contextKey: string,
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    await this.route(contextKey).outbound.updateInteractiveCard(messageId, card);
  }

  async flushAll(): Promise<void> {
    const presenters = [...new Set(this.routes.map((route) => route.presenter))];
    await Promise.all(presenters.map((presenter) => presenter.flushAll()));
  }

  private route(contextKey: string): OutboundRoute {
    const route = this.routes.find((candidate) => candidate.matches(contextKey));
    if (!route) throw new Error(`No outbound route for context: ${contextKey}`);
    return route;
  }

  private currentReplyTarget(contextKey: string): MessageReplyTarget | undefined {
    const current = this.replyTargets.getStore();
    return current?.contextKey === contextKey ? current.target : undefined;
  }
}
