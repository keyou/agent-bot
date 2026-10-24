import { RUNTIME_WARNING_PREFIXES, sameRuntimeError } from "../runtime/responseErrors.js";
import type { TurnActivity, TurnViewState } from "./turnViewTypes.js";

export function visibleTurnActivities(state: TurnViewState): TurnActivity[] {
  if (state.status !== "failed" || !state.error) return state.activities;
  return state.activities.filter((activity) => {
    if (activity.id !== `commentary:runtime-error:${state.turnId}`
      || (activity.kind !== "assistant" && activity.kind !== "reasoning")) return true;
    const prefix = RUNTIME_WARNING_PREFIXES.find((value) => activity.text.startsWith(value));
    return !sameRuntimeError(prefix ? activity.text.slice(prefix.length) : activity.text, state.error!);
  });
}
