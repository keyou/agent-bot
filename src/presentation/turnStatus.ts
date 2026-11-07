import type { AgentEvent } from "../runtime/types.js";
import type { TurnViewState, TurnViewStatus } from "./turnViewTypes.js";

export function isTerminalTurnStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

/** Settled monitoring does not imply that the remote execution has ended. */
export function isSettledTurnStatus(status: string): boolean {
  return status === "unknown" || isTerminalTurnStatus(status);
}

export function canApplyTurnEvent(
  state: Pick<TurnViewState, "sessionId" | "turnId" | "status">,
  event: AgentEvent,
): boolean {
  if (event.sessionId !== state.sessionId || event.turnId !== state.turnId) return false;
  // Late accounting may enrich a result, but never change its adjudication.
  if (event.type === "token_usage_updated") return true;
  if (isTerminalTurnStatus(state.status)) return state.status !== "completed" && event.type === "turn_completed";
  if (state.status !== "unknown") return true;
  return event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed"
    || event.type === "turn_status_unknown" || event.type === "agent_text_delta";
}

export function turnStatusLabel(status: TurnViewStatus, language: "zh" | "en" = "zh"): string {
  const labels: Record<TurnViewStatus, [string, string]> = {
    starting: ["正在处理", "Starting"],
    running: ["正在处理", "Processing"],
    tool_running: ["正在处理", "Processing"],
    waiting_for_approval: ["等待确认", "Waiting for approval"],
    unknown: ["待核实", "Unverified"],
    completed: ["已完成", "Completed"],
    cancelled: ["已停止", "Stopped"],
    failed: ["执行失败", "Failed"],
  };
  return labels[status]?.[language === "zh" ? 0 : 1] ?? status;
}
