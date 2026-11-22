import type Database from "better-sqlite3";
import type { RuntimeSession } from "../runtime/types.js";
import { createId } from "../utils/id.js";

export type ExecutionTrigger = "user" | "queue" | "schedule" | "recovery" | "retry"
  | "plan_handoff" | "response_continuation" | "recovery_continuation";

export interface ExecutionProvenance {
  submissionId: string;
  instructionId: string;
  attemptId: string;
  localSessionId: string;
  turnId?: string;
  trigger: ExecutionTrigger;
  parentSourceTurnId?: string;
  scheduledFor?: number;
  submittedAt: number;
  settings: Pick<RuntimeSession, "agentName" | "modelProvider" | "model" | "reasoningEffort" | "permissionMode" | "cwd">;
}

interface ProvenanceRow {
  submission_id: string;
  instruction_id: string;
  attempt_id: string;
  local_session_id: string;
  turn_id: string | null;
  trigger: ExecutionTrigger;
  parent_source_turn_id: string | null;
  scheduled_for: number | null;
  submitted_at: number;
  agent_name: string;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  permission_mode: RuntimeSession["permissionMode"];
  cwd: string;
}

export class ExecutionProvenanceStore {
  constructor(private readonly db: Database.Database) {}

  recordSubmission(input: Omit<ExecutionProvenance, "submissionId" | "submittedAt" | "turnId" | "instructionId">
    & { instructionId?: string }): ExecutionProvenance {
    const previous = this.latestForAttempt(input.attemptId);
    const parent = input.parentSourceTurnId && input.trigger !== "user" && input.trigger !== "queue" && input.trigger !== "schedule"
      ? this.forTurn(input.parentSourceTurnId, input.localSessionId) : undefined;
    const instructionId = previous?.instructionId ?? parent?.instructionId ?? input.instructionId ?? input.attemptId;
    const scheduledFor = input.scheduledFor ?? previous?.scheduledFor ?? parent?.scheduledFor;
    const submissionId = createId("submission");
    // Explicit columns are the allowlist: never serialize a runtime session or prompt here.
    const { agentName, modelProvider, model, reasoningEffort, permissionMode, cwd } = input.settings;
    this.db.prepare(`INSERT INTO execution_provenance (
      submission_id, instruction_id, attempt_id, local_session_id, trigger, parent_source_turn_id,
      scheduled_for, submitted_at, agent_name, model_provider, model, reasoning_effort, permission_mode, cwd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      submissionId, instructionId, input.attemptId, input.localSessionId, input.trigger, input.parentSourceTurnId ?? null,
      scheduledFor ?? null, Date.now(), agentName, modelProvider ?? null, model ?? null, reasoningEffort ?? null, permissionMode, cwd,
    );
    return this.latestForAttempt(input.attemptId)!;
  }

  bindTurn(submissionId: string, turnId: string): void {
    this.db.prepare(`UPDATE execution_provenance SET turn_id = ? WHERE submission_id = ? AND turn_id IS NULL`)
      .run(turnId, submissionId);
  }

  bindLatestTurn(attemptId: string, turnId: string): void {
    const latest = this.latestForAttempt(attemptId);
    if (latest) this.bindTurn(latest.submissionId, turnId);
  }

  latestForAttempt(attemptId: string): ExecutionProvenance | undefined {
    return this.read(this.db.prepare(`SELECT * FROM execution_provenance WHERE attempt_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(attemptId));
  }

  forTurn(turnId: string, localSessionId: string): ExecutionProvenance | undefined {
    return this.read(this.db.prepare(`SELECT * FROM execution_provenance WHERE turn_id = ? AND local_session_id = ?
      ORDER BY rowid DESC LIMIT 1`).get(turnId, localSessionId));
  }

  listForAttempt(attemptId: string): ExecutionProvenance[] {
    return this.db.prepare(`SELECT * FROM execution_provenance WHERE attempt_id = ? ORDER BY rowid`).all(attemptId)
      .map((row) => this.read(row)!);
  }

  private read(value: unknown): ExecutionProvenance | undefined {
    if (!value) return undefined;
    const row = value as ProvenanceRow;
    return {
      submissionId: row.submission_id, instructionId: row.instruction_id, attemptId: row.attempt_id,
      localSessionId: row.local_session_id, turnId: row.turn_id ?? undefined, trigger: row.trigger,
      parentSourceTurnId: row.parent_source_turn_id ?? undefined, scheduledFor: row.scheduled_for ?? undefined,
      submittedAt: row.submitted_at, settings: {
        agentName: row.agent_name, modelProvider: row.model_provider ?? undefined, model: row.model ?? undefined,
        reasoningEffort: row.reasoning_effort ?? undefined, permissionMode: row.permission_mode, cwd: row.cwd,
      },
    };
  }
}
