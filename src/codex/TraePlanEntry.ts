import { open } from "node:fs/promises";
import { z } from "zod";

const MAX_TAIL_BYTES = 256 * 1024;
const mutation = z.object({
  type: z.literal("history_mutation"),
  payload: z.object({
    version: z.literal(1),
    turn_id: z.string(),
    operation: z.string(),
    items: z.array(z.object({
      type: z.string(),
      call_id: z.string().optional(),
      name: z.string().optional(),
      output: z.unknown().optional(),
    })).optional(),
  }),
});

// TraeX can finish EnterPlanMode without a mode/changeResolved notification.
// Read only a bounded tail, and require the exact call and its successful result.
export async function hasCompletedTraePlanEntry(
  rolloutPath: string, turnId: string, toolCallId: string,
): Promise<boolean> {
  const file = await open(rolloutPath, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    lines.pop(); // Ignore an uncommitted/partial final record.
    let entered = false;
    let matchedCall = false;
    for (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      const parsed = mutation.safeParse(value);
      if (!parsed.success || parsed.data.payload.turn_id !== turnId) continue;
      const payload = parsed.data.payload;
      if (payload.operation !== "append") {
        matchedCall = false;
        entered = false;
        continue;
      }
      for (const item of payload.items ?? []) {
        if (item.call_id !== toolCallId) continue;
        if (item.type === "function_call") {
          matchedCall = item.name === "EnterPlanMode";
          entered = false;
        } else if (item.type === "function_call_output") {
          entered = matchedCall && typeof item.output === "string"
            && item.output.startsWith("Entered plan mode.");
        }
      }
    }
    return entered;
  } finally {
    await file.close();
  }
}
