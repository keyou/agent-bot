import { open } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { PermissionMode } from "../runtime/types.js";

const READ_CHUNK_SIZE = 64 * 1024;
const TASK_STARTED = Buffer.from('"type":"task_started"');
const TASK_COMPLETE = Buffer.from('"type":"task_complete"');
const TURN_ABORTED = Buffer.from('"type":"turn_aborted"');
const PATTERN_OVERLAP = Math.max(TASK_STARTED.length, TASK_COMPLETE.length, TURN_ABORTED.length) - 1;

interface RolloutState {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  tail: Buffer;
  task: { active: boolean; turnId?: string };
}

interface ThreadPathRow {
  id: string;
  rollout_path: string;
}

interface ThreadSettingsRow {
  id: string;
  model_provider?: string | null;
  model: string | null;
  reasoning_effort: string | null;
  approval_mode: string | null;
}

export interface CodexLocalThreadSettings {
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
}

/**
 * Reads Codex's persisted state without joining, resuming, or controlling a thread.
 * This is needed because thread/list reports another app-server process as notLoaded
 * even while Codex Desktop is actively appending events to its rollout.
 */
export class CodexLocalActivityDetector {
  private readonly rollouts = new Map<string, RolloutState>();
  constructor(private readonly codexHome: string) {}

  async activeThreadIds(threadIds: string[]): Promise<Set<string>> {
    return new Set((await this.activeThreads(threadIds)).keys());
  }

  async activeThreads(threadIds: string[]): Promise<Map<string, string | undefined>> {
    const ids = [...new Set(threadIds.filter(Boolean))];
    if (ids.length === 0) return new Map();

    let database: Database.Database | undefined;
    let rows: ThreadPathRow[];
    try {
      database = new Database(path.join(this.codexHome, "state_5.sqlite"), {
        readonly: true,
        fileMustExist: true,
      });
      const placeholders = ids.map(() => "?").join(", ");
      rows = database.prepare(
        `SELECT id, rollout_path FROM threads WHERE id IN (${placeholders})`,
      ).all(...ids) as ThreadPathRow[];
    } catch {
      return new Map();
    } finally {
      database?.close();
    }

    const active = new Map<string, string | undefined>();
    for (const row of rows) {
      const task = await latestTask(row.rollout_path, this.rollouts);
      if (task.active) active.set(row.id, task.turnId);
    }
    return active;
  }

  async threadSettings(threadIds: string[]): Promise<Map<string, CodexLocalThreadSettings>> {
    const ids = [...new Set(threadIds.filter(Boolean))];
    if (ids.length === 0) return new Map();

    let database: Database.Database | undefined;
    try {
      database = new Database(path.join(this.codexHome, "state_5.sqlite"), {
        readonly: true,
        fileMustExist: true,
      });
      const placeholders = ids.map(() => "?").join(", ");
      const columns = new Set(
        (database.pragma("table_info(threads)") as Array<{ name: string }>).map((column) => column.name),
      );
      const providerColumn = columns.has("model_provider") ? ", model_provider" : "";
      const rows = database.prepare(
        `SELECT id${providerColumn}, model, reasoning_effort, approval_mode FROM threads WHERE id IN (${placeholders})`,
      ).all(...ids) as ThreadSettingsRow[];
      return new Map(rows.map((row) => [row.id, {
        ...(row.model_provider?.trim() ? { modelProvider: row.model_provider.trim() } : {}),
        ...(row.model?.trim() ? { model: row.model.trim() } : {}),
        ...(row.reasoning_effort?.trim() ? { reasoningEffort: row.reasoning_effort.trim() } : {}),
        ...(row.approval_mode?.trim()
          ? { permissionMode: row.approval_mode.trim() === "never" ? "auto" : "confirm" }
          : {}),
      }]));
    } catch {
      return new Map();
    } finally {
      database?.close();
    }
  }
}

async function latestTask(rolloutPath: string, cache: Map<string, RolloutState>): Promise<{ active: boolean; turnId?: string }> {
  let file;
  try {
    file = await open(rolloutPath, "r");
    const { size, mtimeMs, ctimeMs, ino, dev } = await file.stat();
    const previous = cache.get(rolloutPath);
    const sameFile = previous?.ino === ino && previous.dev === dev;
    if (sameFile && previous.size === size && previous.mtimeMs === mtimeMs && previous.ctimeMs === ctimeMs) {
      return previous.task;
    }
    let stopAt = 0;
    let task: RolloutState["task"] = { active: false };
    if (sameFile && size > previous.size) {
      const boundary = Buffer.alloc(previous.tail.length);
      await file.read(boundary, 0, boundary.length, previous.size - boundary.length);
      if (boundary.equals(previous.tail)) {
        stopAt = Math.max(0, previous.size - PATTERN_OVERLAP);
        task = previous.task;
      }
    }
    let position = size;
    let laterPrefix = Buffer.alloc(0);

    while (position > stopAt) {
      const length = Math.min(READ_CHUNK_SIZE, position - stopAt);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await file.read(chunk, 0, length, position);
      const searchable = laterPrefix.length > 0 ? Buffer.concat([chunk, laterPrefix]) : chunk;
      const startedAt = searchable.lastIndexOf(TASK_STARTED);
      const completedAt = searchable.lastIndexOf(TASK_COMPLETE);
      const abortedAt = searchable.lastIndexOf(TURN_ABORTED);
      const terminalAt = Math.max(completedAt, abortedAt);
      if (startedAt >= 0 || terminalAt >= 0) {
        task = startedAt <= terminalAt ? { active: false }
          : { active: true, turnId: await readTurnId(file, position + startedAt, size) };
        break;
      }
      laterPrefix = chunk.subarray(0, Math.min(PATTERN_OVERLAP, chunk.length));
    }
    const tail = Buffer.alloc(Math.min(1_024, size));
    await file.read(tail, 0, tail.length, size - tail.length);
    cache.delete(rolloutPath);
    cache.set(rolloutPath, { size, mtimeMs, ctimeMs, ino, dev, tail, task });
    if (cache.size > 512) cache.delete(cache.keys().next().value!);
    return task;
  } catch {
    cache.delete(rolloutPath);
    return { active: false };
  } finally {
    await file?.close();
  }
}

async function readTurnId(
  file: Awaited<ReturnType<typeof open>>,
  eventOffset: number,
  fileSize: number,
): Promise<string | undefined> {
  const start = Math.max(0, eventOffset - 1_024);
  const length = Math.min(8_192, fileSize - start);
  const buffer = Buffer.allocUnsafe(length);
  await file.read(buffer, 0, length, start);
  const relativeOffset = eventOffset - start;
  const previousNewline = buffer.lastIndexOf(0x0a, relativeOffset);
  const nextNewline = buffer.indexOf(0x0a, relativeOffset);
  const line = buffer.subarray(previousNewline + 1, nextNewline >= 0 ? nextNewline : undefined).toString("utf8");
  const match = /"turn_id":"([^"]+)"/.exec(line);
  return match?.[1];
}
