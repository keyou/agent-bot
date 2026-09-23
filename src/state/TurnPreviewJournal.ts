import fs from "node:fs";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AgentEvent, ToolState } from "../runtime/types.js";
import { reduceTurnEvent } from "../presentation/TurnStateReducer.js";
import type { TurnViewState } from "../presentation/turnViewTypes.js";

type TextChange = { key: string; field: string; append: boolean; text: string };
export type PreviewRecord =
  | { kind: "seed"; state: TurnViewState }
  | { kind: "state"; patch: Partial<TurnViewState> }
  | { kind: "user"; id: string; text: string; images?: string[] }
  | { kind: "event"; event: AgentEvent; texts: TextChange[] };
type Stream = { length: number; hash: Hash };
type Writer = { seeded?: boolean; pending: string[]; bytes: number; dirtyDisk?: boolean; streams: Map<string, Stream>; timings: Map<string, number>; timer?: NodeJS.Timeout; error?: unknown };

/** A presentation journal, not an agent/tool replay mechanism. All paths are local to this store. */
export class TurnPreviewJournal {
  private readonly writers = new Map<string, Writer>();
  private detailExpiry?: NodeJS.Timeout;
  private readonly detailReaders = new Map<string, { projection: TurnPreviewProjection; offset: number; accessed: number }>();
  constructor(readonly directory: string, private readonly onError: (error: unknown) => void = () => {}) {}

  file(turnId: string): string {
    const hash = createHash("sha256").update(turnId).digest("hex");
    return path.join(this.directory, hash.slice(0, 2), hash + ".jsonl");
  }

  has(turnId: string): boolean { return this.writers.has(turnId) || fs.existsSync(this.file(turnId)); }

  seed(state: TurnViewState): void {
    const writer = this.writer(state.turnId);
    if (writer.seeded) return;
    this.append(state.turnId, { kind: "seed", state: { ...state, previewJournal: true } });
    writer.seeded = true;
    for (const change of seedTexts(state)) this.track(writer, change);
  }

  state(state: TurnViewState): void {
    this.seed(state);
    // Growing execution fields live only in events. Keep routing/final-delivery metadata here.
    const { activities, reasoningItems, fullToolOutputs, fullToolErrors, toolStatuses,
      completedTools, failedTools, activeTool, assistantText, progressText, plan, fileSummary,
      activitiesTruncated, previewCursor, ...patch } = state;
    this.append(state.turnId, { kind: "state", patch });
  }

  user(turnId: string, id: string, text: string, images?: string[]): void {
    this.append(turnId, { kind: "user", id, text, images });
  }

  event(event: AgentEvent): void {
    const writer = this.writer(event.turnId);
    const texts: TextChange[] = [];
    const copy = { ...event } as AgentEvent;
    const capture = (key: string, field: string, text: string, append = false) => {
      const old = writer.streams.get(key);
      let suffix = text;
      let incremental = append;
      if (!append && old && text.length >= old.length
        && createHash("sha256").update(text.slice(0, old.length)).digest("hex") === old.hash.copy().digest("hex")) {
        suffix = text.slice(old.length);
        incremental = true;
      }
      this.track(writer, { key, field, append: incremental, text: suffix });
      texts.push({ key, field, append: incremental, text: suffix });
    };
    if (copy.type === "tool_started" || copy.type === "tool_updated") {
      const startedAt = copy.tool.startedAt ?? writer.timings.get(copy.tool.id) ?? Date.now();
      writer.timings.set(copy.tool.id, startedAt);
      copy.tool = { ...copy.tool, startedAt,
        completedAt: copy.tool.status === "running" ? copy.tool.completedAt : copy.tool.completedAt ?? Date.now() };
      for (const field of ["title", "command", "output", "error"] as const) {
        const text = copy.tool[field];
        if (text === undefined) continue;
        capture(`tool:${copy.tool.id}:${field}`, field, text);
        delete (copy.tool as Partial<ToolState>)[field];
      }
    } else if (copy.type === "tool_output_delta") {
      capture(`tool:${copy.toolId}:output`, "delta", copy.delta, true);
      copy.delta = "";
    } else if (copy.type === "progress") {
      capture(copy.reasoning ? `reasoning:${copy.reasoning.itemId}:summary:${copy.reasoning.summaryIndex}`
        : `progress:${copy.activityId ?? "progress"}`, "text", copy.text, copy.append);
      copy.text = "";
      copy.append = false;
    }
    if (copy.type === "reasoning_delta") {
      capture(`reasoning:${copy.itemId}:content:${copy.contentIndex}`, "text", copy.text, true);
      copy.text = "";
    } else if (copy.type === "reasoning_completed") {
      for (const field of ["summary", "content"] as const) {
        copy[field] = copy[field].map((value, index) => {
          capture(`reasoning:${copy.itemId}:${field}:${index}`, `${field}:${index}`, value);
          return "";
        });
      }
    }
    this.append(event.turnId, { kind: "event", event: copy, texts });
  }

  flush(turnId?: string, durable = false): void {
    if (!turnId) { for (const id of this.writers.keys()) this.flush(id, durable); return; }
    const writer = this.writers.get(turnId);
    if (!writer) return;
    if (writer.timer) clearTimeout(writer.timer);
    writer.timer = undefined;
    if (writer.error) throw writer.error;
    if (!writer.bytes && !(durable && writer.dirtyDisk)) return;
    const file = this.file(turnId);
    let fd: number | undefined;
    let size = 0;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, "a");
      size = fs.fstatSync(fd).size;
      if (writer.bytes) fs.writeFileSync(fd, writer.pending.join(""));
      writer.dirtyDisk = true;
      if (durable) { fs.fsyncSync(fd); writer.dirtyDisk = false; }
      writer.pending = [];
      writer.bytes = 0;
    } catch (error) {
      // Never continue after a partial append: the journal must remain a valid prefix.
      if (fd !== undefined) { try { fs.ftruncateSync(fd, size); } catch { /* Fail closed below. */ } }
      writer.pending = [];
      writer.bytes = 0;
      writer.error = error;
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  release(turnId: string): void {
    this.flush(turnId, true);
    this.writers.delete(turnId);
  }

  close(): void {
    try { this.flush(undefined, true); } finally {
      for (const writer of this.writers.values()) if (writer.timer) clearTimeout(writer.timer);
      this.writers.clear();
      this.detailReaders.clear();
      if (this.detailExpiry) clearTimeout(this.detailExpiry);
    }
  }

  /** Bounded byte cursor; a partial final record is ignored until its newline is present. */
  read(turnId: string, offset = 0, maxBytes = 256 * 1024, through = Infinity): { records: PreviewRecord[]; offset: number; end: boolean } {
    const file = this.file(turnId);
    if (!fs.existsSync(file)) return { records: [], offset, end: true };
    const fd = fs.openSync(file, "r");
    try {
      const size = Math.min(fs.fstatSync(fd).size, through);
      const records: PreviewRecord[] = [];
      const start = offset;
      let position = offset;
      let parts: Buffer[] = [];
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
        const count = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!count) break;
        position += count;
        let begin = 0;
        let newline: number;
        while ((newline = chunk.indexOf(10, begin)) !== -1 && newline < count) {
          parts.push(chunk.subarray(begin, newline));
          const line = Buffer.concat(parts);
          records.push(JSON.parse(line.toString("utf8")) as PreviewRecord);
          offset += line.length + 1;
          parts = [];
          begin = newline + 1;
        }
        if (begin < count) parts.push(chunk.subarray(begin, count));
        if (records.length && position - start >= maxBytes) break;
      }
      return { records, offset, end: position >= size };
    } finally { fs.closeSync(fd); }
  }

  load(turnId: string, details: boolean | string = true): TurnViewState | undefined {
    this.flush(turnId);
    const cacheKey = `${turnId}:${String(details)}`;
    const cached = typeof details === "string" ? this.detailReaders.get(cacheKey) : undefined;
    const projection = cached?.projection ?? new TurnPreviewProjection(details);
    let offset = cached?.offset ?? 0;
    for (;;) {
      const batch = this.read(turnId, offset);
      for (const record of batch.records) projection.apply(record, ++projection.revision);
      if (batch.end || batch.offset === offset) {
        if (typeof details === "string") {
          const now = Date.now();
          for (const [key, value] of this.detailReaders) if (now - value.accessed > 60_000) this.detailReaders.delete(key);
          this.detailReaders.delete(cacheKey);
          if (projection.retainedTextBytes() < 16 * 1024 * 1024)
            this.detailReaders.set(cacheKey, { projection, offset: batch.offset, accessed: now });
          if (this.detailExpiry) clearTimeout(this.detailExpiry);
          this.detailExpiry = setTimeout(() => this.detailReaders.clear(), 60_000);
          this.detailExpiry.unref();
          while (this.detailReaders.size > 4) this.detailReaders.delete(this.detailReaders.keys().next().value!);
        }
        return projection.state ? { ...projection.state, previewCursor: batch.offset } : undefined;
      }
      offset = batch.offset;
    }
  }

  outputAppend(turnId: string, toolId: string, after: number, through: number): string | undefined {
    if (!Number.isSafeInteger(after) || after <= 0 || after > through) return undefined;
    let offset = after;
    const parts: string[] = [];
    while (offset < through) {
      const batch = this.read(turnId, offset, 256 * 1024, through);
      if (batch.offset === offset) return undefined;
      for (const record of batch.records) {
        if (record.kind === "seed") return undefined;
        if (record.kind !== "event") continue;
        const event = record.event;
        if ((event.type === "tool_started" || event.type === "tool_updated") && event.tool.id === toolId
          && (event.tool.files || event.tool.imagePath)) return undefined;
        for (const change of record.texts) {
          if (!change.key.startsWith(`tool:${toolId}:`)) continue;
          if (change.key === `tool:${toolId}:output` && change.append) parts.push(change.text);
          else if (change.text || !change.append) return undefined;
        }
      }
      offset = batch.offset;
    }
    return parts.join("");
  }

  private track(writer: Writer, change: TextChange): void {
    const old = change.append ? writer.streams.get(change.key) : undefined;
    const stream = old ?? { length: 0, hash: createHash("sha256") };
    stream.hash.update(change.text);
    stream.length += change.text.length;
    writer.streams.set(change.key, stream);
  }

  private writer(turnId: string): Writer {
    let writer = this.writers.get(turnId);
    if (writer) return writer;
    writer = { pending: [], bytes: 0, streams: new Map(), timings: new Map() };
    // On first write after restart, rebuild only stream fingerprints, not the full execution.
    let offset = 0;
    if (fs.existsSync(this.file(turnId))) {
      for (;;) {
        const batch = this.read(turnId, offset);
        for (const record of batch.records) {
          if (record.kind === "event") {
            for (const change of record.texts) this.track(writer, change);
            const event = record.event;
            if ((event.type === "tool_started" || event.type === "tool_updated") && event.tool.startedAt !== undefined)
              writer.timings.set(event.tool.id, event.tool.startedAt);
          }
          if (record.kind === "seed") {
            writer.seeded = true;
            for (const change of seedTexts(record.state)) this.track(writer, change);
          }
        }
        offset = batch.offset;
        if (batch.end || !batch.records.length) break;
      }
      const size = fs.statSync(this.file(turnId)).size;
      if (offset < size) fs.truncateSync(this.file(turnId), offset);
    }
    this.writers.set(turnId, writer);
    return writer;
  }

  private append(turnId: string, record: PreviewRecord): void {
    const writer = this.writer(turnId);
    if (writer.error) throw writer.error;
    const line = JSON.stringify(record) + "\n";
    writer.pending.push(line);
    writer.bytes += Buffer.byteLength(line);
    if (writer.bytes >= 256 * 1024) this.flush(turnId);
    else if (!writer.timer) {
      writer.timer = setTimeout(() => {
        try { this.flush(turnId); } catch (error) { this.onError(error); }
      }, 250);
      writer.timer.unref();
    }
  }
}

/** Built only when a human opens history. SSE keeps summaries, not full tool output, in memory. */
export class TurnPreviewProjection {
  state?: TurnViewState;
  revision = 0;
  readonly changed = new Set<string>();
  readonly removed = new Set<string>();
  private readonly text = new Map<string, string>();
  constructor(private readonly details: boolean | string = false) {}
  retainedTextBytes(): number {
    let bytes = 0;
    for (const value of this.text.values()) bytes += value.length * 2;
    return bytes;
  }
  private wantsFull(key: string): boolean {
    return this.details === true || (typeof this.details === "string" && key.startsWith(`${this.details}:`));
  }

  apply(record: PreviewRecord, revision: number): void {
    if (record.kind === "seed") {
      this.state = { ...record.state, activities: [...record.state.activities], activitiesTruncated: false };
      for (const change of seedTexts(record.state)) this.text.set(change.key, this.wantsFull(change.key) ? change.text : change.text.slice(0, 6000));
      if (this.details !== true) {
        this.state = { ...this.state, fullToolOutputs: {}, fullToolErrors: {}, activities: this.state.activities.map((a) => a.kind === "tool"
          ? { ...a, tool: { ...a.tool, output: a.tool.output?.slice(0, 6000), error: a.tool.error?.slice(0, 6000) } } : a) };
      }
      if (typeof this.details === "string" && this.details.startsWith("tool:")) {
        const id = this.details.slice(5);
        const tool = record.state.activities.find((a) => a.kind === "tool" && a.id === id);
        if (tool?.kind === "tool") {
          this.state.activities = this.state.activities.map((a) => a.id === id ? tool : a);
          this.state.fullToolOutputs = { [id]: record.state.fullToolOutputs?.[id] ?? tool.tool.output ?? "" };
          this.state.fullToolErrors = { [id]: record.state.fullToolErrors?.[id] ?? tool.tool.error ?? "" };
        }
      }
      for (const a of record.state.activities) this.changed.add(a.id);
      return;
    }
    if (!this.state) return;
    if (record.kind === "state") {
      this.state = { ...this.state, ...record.patch, historyDetail: "full", previewJournal: true };
      return;
    }
    if (record.kind === "user") {
      const user = { kind: "user" as const, id: record.id, text: record.text, localImagePaths: record.images };
      const index = this.state.activities.findIndex((a) => a.id === record.id);
      this.state.activities = [...this.state.activities];
      if (index < 0) this.state.activities.push(user); else this.state.activities[index] = user;
      this.changed.add(record.id);
      return;
    }
    let event = { ...record.event } as AgentEvent;
    if (event.type === "tool_started" || event.type === "tool_updated") event.tool = { ...event.tool };
    if (event.type === "reasoning_completed") event = { ...event, summary: [...event.summary], content: [...event.content] };
    for (const change of record.texts) {
      let value = (change.append ? this.text.get(change.key) ?? "" : "") + change.text;
      const full = this.wantsFull(change.key);
      if (!full && (change.key.startsWith("tool:") || change.key.startsWith("reasoning:"))) value = value.slice(0, 6000);
      this.text.set(change.key, value);
      if (event.type === "tool_started" || event.type === "tool_updated") {
        (event.tool as unknown as Record<string, unknown>)[change.field] = value;
      } else if (event.type === "progress") event.text = value;
      else if (event.type === "reasoning_delta") event.text = change.text;
      else if (event.type === "reasoning_completed") {
        const [field, index] = change.field.split(":");
        event[field as "summary" | "content"][Number(index)] = value;
      }
      else if (event.type === "tool_output_delta") {
        const toolId = event.toolId;
        const activity = this.state.activities.find((a) => a.kind === "tool" && a.id === toolId);
        if (activity?.kind === "tool") event = { type: "tool_updated", sessionId: event.sessionId, turnId: event.turnId,
          tool: { ...activity.tool, output: value } };
      }
    }
    if (event.type === "tool_started" || event.type === "tool_updated") {
      const toolId = event.tool.id;
      const previous = this.state.activities.find((a) => a.kind === "tool" && a.id === toolId);
      if (previous?.kind === "tool") event.tool = { ...previous.tool, ...event.tool };
      event.tool.previewRevision = revision;
      this.changed.add(event.tool.id);
    } else if (event.type === "progress") {
      this.changed.add(event.activityId ?? "progress");
      if (event.reasoning) this.changed.add(`reasoning:${event.reasoning.itemId}`);
    }
    else if (event.type === "agent_text_delta" && event.replacesActivityId) this.removed.add(event.replacesActivityId);
    if (event.type === "reasoning_delta" || event.type === "reasoning_completed") this.changed.add(`reasoning:${event.itemId}`);
    const old = this.state;
    this.state = reduceTurnEvent(old, event, true);
    if (["completed", "failed", "cancelled"].includes(old.status) && !event.type.startsWith("turn_")) this.state.status = old.status;
    const reasoningId = event.type === "reasoning_delta" || event.type === "reasoning_completed" ? event.itemId
      : event.type === "progress" ? event.reasoning?.itemId : undefined;
    if (reasoningId) this.state.reasoningItems = this.state.reasoningItems?.map((r) => r.itemId === reasoningId ? { ...r, previewRevision: revision } : r);
    if (event.type === "context_compaction") {
      for (const a of this.state.activities) if (!old.activities.includes(a)) this.changed.add(a.id);
    }
    if (this.details !== true && this.state.reasoningItems) this.state.reasoningItems = this.state.reasoningItems.map((r) => ({ ...r,
      summary: r.summary.map((t) => this.wantsFull(`reasoning:${r.itemId}:`) ? t : t.slice(0, 6000)), content: r.content.map((t) => this.wantsFull(`reasoning:${r.itemId}:`) ? t : t.slice(0, 6000)) }));
    this.state.activitiesTruncated = false;
  }
}

function seedTexts(state: TurnViewState): TextChange[] {
  const result: TextChange[] = [];
  for (const a of state.activities) {
    if (a.kind === "tool") for (const field of ["title", "command", "output", "error"] as const) {
      const text = (field === "output" ? state.fullToolOutputs?.[a.id] : field === "error" ? state.fullToolErrors?.[a.id] : undefined) ?? a.tool[field];
      if (text !== undefined) result.push({ key: `tool:${a.id}:${field}`, field, append: false, text });
    }
    else if (a.kind !== "user") result.push({ key: `progress:${a.id}`, field: "text", append: false, text: a.text });
  }
  for (const item of state.reasoningItems ?? []) for (const field of ["summary", "content"] as const) {
    item[field].forEach((text, i) => result.push({ key: `reasoning:${item.itemId}:${field}:${i}`, field: `${field}:${i}`, append: false, text }));
  }
  return result;
}
