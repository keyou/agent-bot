import type { AgentEvent } from "../runtime/types.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { TurnPresenter } from "../presentation/OutboundRouter.js";

export class ConsoleTurnPresenter implements TurnPresenter {
  private readonly contexts = new Map<string, string>();
  private readonly agentLabels = new Map<string, string>();
  private readonly delivered = new Set<string>();

  constructor(private readonly outbound: FeishuOutbound) {}

  registerSession(
    sessionId: string,
    contextKey: string,
    _taskTitle?: string,
    _projectCwd?: string,
    agentLabel?: string,
    _model?: string,
  ): void {
    this.contexts.set(sessionId, contextKey);
    if (agentLabel) this.agentLabels.set(sessionId, agentLabel);
  }

  updateSessionModel(): void {}

  updateSessionTitle(): void {}

  unregisterSession(sessionId: string): void {
    this.contexts.delete(sessionId);
    this.agentLabels.delete(sessionId);
  }

  async startPendingTurn(sessionId: string, contextKey: string): Promise<string | undefined> {
    await this.outbound.sendText(contextKey, `Connecting to ${this.agentLabel(sessionId)}...`);
    return undefined;
  }

  async failPendingTurn(sessionId: string, message: string): Promise<boolean> {
    const contextKey = this.contexts.get(sessionId);
    if (contextKey) await this.outbound.sendText(contextKey, `${this.agentLabel(sessionId)} failed to start: ${message}`);
    return false;
  }

  async interruptTurnForRecovery(): Promise<void> {}

  async appendSteerMessage(): Promise<void> {}

  async onEvent(event: AgentEvent): Promise<void> {
    const contextKey = this.contexts.get(event.sessionId);
    if (!contextKey) return;
    if (event.type === "turn_started") {
      await this.outbound.sendText(contextKey, `${this.agentLabel(event.sessionId)} started (${event.turnId})`);
    } else if (event.type === "progress") {
      await this.outbound.sendText(contextKey, event.text);
    } else if (event.type === "tool_started") {
      await this.outbound.sendText(contextKey, `> ${event.tool.title}`);
    } else if (event.type === "approval_requested") {
      await this.outbound.sendText(contextKey, `Approval required: ${event.request.title}. Use Feishu's Permission settings card.`);
    } else if (event.type === "turn_completed" && !this.delivered.has(event.turnId)) {
      this.delivered.add(event.turnId);
      await this.outbound.sendMarkdown(contextKey, event.finalResponse || "(completed without text)");
    } else if (event.type === "turn_failed") {
      await this.outbound.sendText(contextKey, `${this.agentLabel(event.sessionId)} failed: ${event.message}`);
    } else if (event.type === "turn_cancelled") {
      await this.outbound.sendText(contextKey, `${this.agentLabel(event.sessionId)} stopped.`);
    }
  }

  async showDetails(contextKey: string, turnId: string): Promise<void> {
    await this.outbound.sendText(contextKey, `Turn details are available in Feishu (${turnId}).`);
  }

  async showActivityPage(contextKey: string, turnId: string): Promise<void> {
    await this.outbound.sendText(contextKey, `Turn activity pages are available in Feishu (${turnId}).`);
  }

  async resumeDelivery(): Promise<void> {}

  async flushAll(): Promise<void> {}

  private agentLabel(sessionId: string): string {
    return this.agentLabels.get(sessionId) ?? "Agent";
  }
}
