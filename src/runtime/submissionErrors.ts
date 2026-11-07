// Only raise this before dispatching a prompt-bearing request. A timeout,
// disconnect, or generic provider rejection is not evidence of non-submission.
export class TurnNotSubmittedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TurnNotSubmittedError";
  }
}

export class TurnStoppedBeforeSubmissionError extends TurnNotSubmittedError {
  constructor() {
    super(new Error("本次执行已停止，未提交请求。"));
    this.name = "TurnStoppedBeforeSubmissionError";
  }
}
