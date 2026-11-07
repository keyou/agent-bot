# Task execution contracts

Implement six independently reviewable changes on `fix/task-execution-contracts`.

- [x] 1. Keep task execution settings separate from Agent defaults. Commit `2729ce3`; 757 focused tests and typecheck passed.
- [x] 2. Recover known execution without replaying ambiguous submissions. Durable dispatch boundary, exact turn matching and unknown queue guard; 873 focused tests and typecheck passed.
- [x] 3. Persist Stop intent across automatic continuations and restarts. Durable generation checks, retained queues and late-ack interruption; focused tests and typecheck passed.
- [x] 4. Represent uncertain execution explicitly and keep presentation consistent. Implemented before recovery as its dependency; 1040 focused tests and typecheck passed.
- [x] 5. Record minimal execution provenance and effective settings. Persistent allowlisted metadata, logical instruction links and `/turn` details; 825 focused tests and typecheck passed.
- [x] 6. Add cross-module regression coverage for execution invariants. Real SQLite, presenter, Preview journal and delivery ledger coverage, plus cancellation/scheduling races and conservative migration tests.

Preserve original history and thread IDs during settings changes. Preserve queued user instructions on Stop. Do not infer completion from final text alone. Use one progress card per turn and existing audit channels.

Validation: focused Vitest tests per change, TypeScript checking, full tests, build, final diff review, then safe service restart.

Test workflow:
- [x] Step1: Prepare tools and temporary workspace (`/tmp/tmp.MsQra6tBHl`, local execution).
- [x] Step2: Load TypeScript and repository context (Vitest, existing SQLite fixtures).
- [x] Step3: Identify targets.
- [x] Step4: Map defects to observable regression scenarios.
- [x] Step5: Generate, validate, and repair tests alongside each change.
- [x] Step6: Assess coverage of the changed behavior. No numerical coverage threshold was requested; behavioral assertions cover the six contracts and newly discovered race boundaries.
- [x] Step7: Record results. Full suite: 2428 unit, 11 process and 7 render tests passed (2446 total); typecheck, build and diff whitespace checks passed. The final unknown/stale-start guard also passed the real-presentation integration tests. Local test telemetry could not flush because `utree` is not installed; test execution and results are unaffected.

TARGETS (non-diff, explicit six-part scope):
- `ProxySessionController`: task settings setters; `recoverTurnAttempt`, `startTurnNow`, `recoverFailedResponse`, `cancelSession`, `handleRuntimeEvent`, queue/plan/response continuation.
- `StateStore`: attempt persistence, submission/cancellation boundaries, provenance and terminal transitions.
- `TurnStateReducer`, `FeishuTurnPresenter`, `TurnPreviewPage`: unknown state, terminal events and late-event handling.

BUG_MAP / validation scenarios:
- P1 Business Gaps: task setters persist Agent defaults despite promising task scope; verify other tasks and configured defaults remain independent.
- P1 Business Gaps: recovery can replay an already submitted instruction; distinguish reattachment, known unsubmitted preparation and ambiguous execution.
- P1 Concurrency: Stop awaits remote inspection before persisting intent, and automatic paths use separate guards; verify Stop during preparation and async continuation survives restart.
- P1 Logic Errors: controller terminal events unconditionally update session head, and presenter late `turn_started` can revive terminal views; verify old events cannot replace current turn or known completion.
- Provenance is a feature gap; record trigger/settings at submission without claiming a reproduced runtime defect.

Source fixes are explicitly authorized by the user; this overrides the testing skill's default restriction to test-only edits.

Regression-driven refinements in part 6:
- Cancellation verification cannot create a replacement recoverable attempt.
- Stopped pre-submission scheduled work retains queue order and can reuse its safe unsubmitted attempt.
- Ambiguous approved-plan submission remains unknown rather than becoming a false failure.
- A delayed Stop acknowledgement cannot interrupt a newer explicit instruction.
- Provenance and the submission boundary commit atomically; blocked submissions record neither.
- Removed unreachable prompt-replay helpers; Responses continuation always uses empty input.

No live Provider calls, history rewrites, external task mutations, publish or push were needed for validation. Tests use isolated databases and fake runtime/network boundaries. Safe restart is scheduled through the supported CLI after committing and building.
