// Only raise this before dispatching a prompt-bearing request. A timeout,
// disconnect, or generic provider rejection is not evidence of non-submission.
export class TurnNotSubmittedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TurnNotSubmittedError";
  }
}
