# Task execution contracts

Implement six independently reviewable changes on `fix/task-execution-contracts`.

- [x] 1. Keep task execution settings separate from Agent defaults. Commit `2729ce3`; 757 focused tests and typecheck passed.
- [x] 2. Recover known execution without replaying ambiguous submissions. Durable dispatch boundary, exact turn matching and unknown queue guard; 873 focused tests and typecheck passed.
- [x] 3. Persist Stop intent across automatic continuations and restarts. Durable generation checks, retained queues and late-ack interruption; focused tests and typecheck passed.
- [x] 4. Represent uncertain execution explicitly and keep presentation consistent. Implemented before recovery as its dependency; 1040 focused tests and typecheck passed.
- [ ] 5. Record minimal execution provenance and effective settings.
- [ ] 6. Add cross-module regression coverage for execution invariants.

Preserve original history and thread IDs during settings changes. Preserve queued user instructions on Stop. Do not infer completion from final text alone. Use one progress card per turn and existing audit channels.

Validation: focused Vitest tests per change, TypeScript checking, full tests, build, final diff review, then safe service restart.

Test workflow:
- [x] Step1: Prepare tools and temporary workspace (`/tmp/tmp.MsQra6tBHl`, local execution).
- [x] Step2: Load TypeScript and repository context (Vitest, existing SQLite fixtures).
- [x] Step3: Identify targets.
- [x] Step4: Map defects to observable regression scenarios.
- [ ] Step5: Generate, validate, and repair tests alongside each change.
- [ ] Step6: Assess coverage of the changed behavior.
- [ ] Step7: Record results.

TARGETS (non-diff, explicit six-part scope):
- `ProxySessionController`: task settings setters; `recoverTurnAttempt`, `startTurnNow`, `retryFailedLlmTurn`, `cancelSession`, `handleRuntimeEvent`, queue/plan/response continuation.
- `StateStore`: attempt persistence, submission/cancellation boundaries, provenance and terminal transitions.
- `TurnStateReducer`, `FeishuTurnPresenter`, `TurnPreviewPage`: unknown state, terminal events and late-event handling.

BUG_MAP / validation scenarios:
- P1 Business Gaps: task setters persist Agent defaults despite promising task scope; verify other tasks and configured defaults remain independent.
- P1 Business Gaps: recovery can replay an already submitted instruction; distinguish reattachment, known unsubmitted preparation and ambiguous execution.
- P1 Concurrency: Stop awaits remote inspection before persisting intent, and automatic paths use separate guards; verify Stop during preparation and async continuation survives restart.
- P1 Logic Errors: controller terminal events unconditionally update session head, and presenter late `turn_started` can revive terminal views; verify old events cannot replace current turn or known completion.
- Provenance is a feature gap; record trigger/settings at submission without claiming a reproduced runtime defect.

Source fixes are explicitly authorized by the user; this overrides the testing skill's default restriction to test-only edits.
