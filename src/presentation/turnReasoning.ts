import type { TurnReasoningItem, TurnViewState } from "./turnViewTypes.js";

export function turnReasoningItems(state: TurnViewState): TurnReasoningItem[] {
  const items = new Map((state.reasoningItems ?? []).map((item) => [item.itemId, item]));
  const saved = new Set(items.keys());
  for (const [index, activity] of state.activities.entries()) {
    if (activity.kind !== "reasoning" || activity.id.startsWith("commentary:")) continue;
    const match = /^reasoning:(.+):(\d+)$/u.exec(activity.id);
    const itemId = match?.[1] ?? activity.id;
    if (saved.has(itemId)) continue;
    const section = match ? Number(match[2]) : 0;
    if (!Number.isSafeInteger(section) || section < 0 || section >= 10_000) continue;
    const item = items.get(itemId) ?? {
      itemId, afterActivityId: state.activities[index - 1]?.id, summary: [], content: [],
    };
    const summary = [...item.summary];
    summary[section] = activity.text;
    items.set(itemId, { ...item, summary });
  }
  return [...items.values()];
}
