# Agent Bot Settings Panel

## Scope

Add owner-only `/settings` cards for existing user-facing configuration. Keep task settings separate. Preserve secrets, launch commands, paths for persisted data, YAML comments and unrelated fields. Save explicit sections with stale-card protection. All changes become active after an explicit safe restart; Agent defaults then apply only to new tasks without inherited overrides.

## Implementation

- [x] Configuration allowlist, validation and atomic persistence.
- [x] Section forms, navigation, command/action routing and ownership checks.
- [x] Documentation, focused/full tests, typecheck and build.
- [x] Requested a safe restart after verification. Status confirmed scheduled, waiting for one running task; restart completion is not yet observed.

## Test Workflow

- [x] Step1: Preparation. Git Bash succeeded; TMP_ROOT=/tmp/tmp.tp7JcumMzB, EXEC_SOURCE empty. WSL bash unavailable.
- [x] Step2: JavaScript/TypeScript; AGENTS.md, schema, YAML writer, controller and adjacent Vitest tests read.
- [x] Step3: Target selection (see below).
- [x] Step4: Defect analysis: BUG_MAP=[] (see below).
- [x] Step5: Generate, validate, repair. All focused and full tests passed.
- [x] Step6: Coverage check skipped by skill policy (no requested threshold or coverage gate; EXEC_SOURCE empty).
- [x] Step7: Report below. `utree flush` attempted but unavailable on this machine.

## TARGETS

Scope: uncommitted changes only, no baseline branch comparison. New files have no diff hunks.

| File | Symbols | Source |
| --- | --- | --- |
| src/config/SettingsStore.ts | settingsSection, SettingsStore.read/save/write, fieldsFor | untracked |
| src/feishu/SettingsCard.ts | renderSettingsCard | untracked |
| src/commands/CommandRouter.ts | parse | diff hunk |
| src/proxy/ProxySessionController.ts | execute, onCardAction, requireSettingsOwner, handleSettingsAction | diff hunks |
| src/feishu/FeishuConnector.ts | getCardActionValue through SDK handler | diff hunk |
| src/cli/help.ts | renderCliHelp | direct documentation of new command |

Dependency preflight: existing npm/Vitest workspace, node_modules installed, package scripts and adjacent tests inspected. Startup wiring is covered through controller tests rather than running a live production process.

## Defect Analysis

BUG_MAP=[] at generation entry. Candidate filtering: global ownership uses an explicit check independent of respondToOwnerOnly; stale cards compare whole-file revision before writing; YAML output only writes selected allowlisted fields; task mutation/runtime APIs are never called. No-op formatting churn was removed during implementation before testing. These are regression scenarios, not claims of confirmed pre-existing defects.

## Verification Log

- Store loop: `npx vitest run tests/config/SettingsStore.test.ts`; initial fixture failures (unescaped template literal and unquoted YAML environment references), corrected test data, then 30/30 passed. Added effective-value coverage for environment-backed switches/selectors.
- Card/router/help loop: `npx vitest run tests/feishu/SettingsCard.test.ts tests/commands/CommandRouter.test.ts tests/cli/help.test.ts`; new command changed the expected ambiguous-prefix list; updated that existing assertion, not routing behavior.
- Controller loop: `npx vitest run tests/proxy/ProxySessionController.test.ts -t "global settings panel"`; adjusted the fixture assertion to the router's actual three-argument reply API.
- Combined regression exposed a production callback collision: broad `settings_` dispatch intercepted existing task cards (54 failures). Fixed in the implementation phase by using a separate `bot_settings_` namespace. Rerunning settings/Provider/model tests left only the help-command-count expectation, updated for the new command; 108 behavior cases passed before the final focused rerun.
- `npm run typecheck` passed before the final regression run.

Card JSON 2.0 form/callback structure checked against the existing scheduling form implementation and official Feishu component/interaction documentation. No live card has been sent and no user configuration has been changed during testing.

## Final Test Report

- Scope: configuration persistence, card rendering, command parsing, Feishu callback decoding, owner enforcement, task isolation and safe restart routing.
- Defect analysis: callback namespace collision found by existing regressions and corrected; the rerun verifies task-level Provider/model/permission actions remain intact. No unresolved failures.
- Generated cases: 47 new cases (31 store, 8 card, 1 command, 2 transport, 5 controller); adjusted existing prefix/help assertions for `/settings`.
- Validation: focused 717/717; full suite 2493/2493 (2475 unit, 11 process, 7 render). Typecheck, build and diff whitespace checks passed.
- Read-only smoke: the actual local Profile loads all five sections with five configured Agents; no configuration values or secrets printed and no settings changed.
- Limits: no live Feishu client click/render test; no numerical coverage measurement. `utree flush` executable is not installed; this does not affect Vitest execution.

## Layout Revision

Requested: make the first page Common and improve card density/layout. Four navigation tabs: Common, Agent, Group names, Advanced. Common includes task defaults, message/display preferences and updates; network and diagnostic options stay Advanced. Keep ownership, task isolation and restart activation unchanged.

- [x] Step1: Test preparation. TMP_ROOT=/tmp/tmp.83ZgAMohLv; EXEC_SOURCE empty.
- [x] Step2: LANG=javascript. Existing TypeScript/Vitest context and fixtures reused; no new dependencies.
- [x] Step3: TARGETS: SettingsStore.fieldsFor/read/save, renderSettingsCard, controller settings callbacks. Scope limited to the requested uncommitted panel layout and regrouping.
- [x] Step4: BUG_MAP=[]; this is a UX revision. Regression risks: lost/duplicated options after regrouping, accidental form submission from navigation, altered task/restart scope, duplicate save notices. Existing validation and persistence remain unchanged.
- [x] Step5: Updated layout/section cases; focused regression passed 718/718 after copy/type assertion adjustments.
- [x] Step6: Coverage gate skipped (no threshold/gate requested; EXEC_SOURCE empty).
- [x] Step7: Report below; build passed; safe restart requested and confirmed waiting for three running tasks.

### Layout Verification Log

- Loop 1: `npx vitest run tests/config/SettingsStore.test.ts tests/feishu/SettingsCard.test.ts` passed 40/40. Added cases for Common-first navigation, complete/unique field placement, paired controls and full-width paths. Strengthened save-status/action separation assertions.
- Loop 2: focused six-file regression ran 718 cases; 717 passed and one existing controller assertion expected the previous longer pending-restart text. Updated that copy assertion, preserving all task-isolation/restart assertions; also verify `/settings` opens Common without diagnostic fields.
- Typecheck and whitespace check passed before the controller copy adjustment.
- Loop 3: the six-file focused command passed 718/718. Typecheck caught optional `replyInteractiveCard` access in the added mock assertion; made the fixture's known method explicit, then typecheck passed again. No production behavior changes were needed to make the tests pass.
- Full run 1: 2475/2476 unit cases passed. The unrelated Preview auto-port reuse test failed with Node fetch `bad port`; no settings code was involved. That single case passed immediately in isolation without code changes.
- Full run 2: `npm test` passed 2494/2494 (2476 unit, 11 process, 7 render). Build and whitespace checks passed.

### Layout Test Report

- Scope: four-section regrouping, Common as initial page, compact native card layout, complete form fields and independent save/restart actions. Persistence, authorization and task semantics unchanged.
- Defect analysis: no new functional defect found in this revision. Updated assertions for intentionally shortened copy and optional mock typing. Recorded the unrelated transient auto-port fetch failure above without changing Preview code.
- Generated cases: two new cases for unique option placement and compact paired layout; updated parameterized section tests and strengthened navigation, default command page and save-status assertions. Settings store/card cases passed 40/40; six-file regression passed 718/718.
- Validation: full suite 2494/2494, typecheck/build/whitespace checks passed. Coverage measurement skipped by the existing skill gate policy. `utree flush` attempted but its executable remains unavailable.
- Runtime: safe restart requested with reason `优化 /settings 常用页与卡片布局`; status confirms scheduled, three running tasks, no pending deliveries or active terminals. Restart completion not yet observed.
- Limits: no live Feishu client rendering/click test. No user configuration values were changed during this revision.

## Remove Directory Control

Scope: remove default working directory from `/settings`, including its editable allowlist. Preserve YAML `defaults.cwd` and all task-directory behavior.

- [x] Step1: Prepared tools; TMP_ROOT=/tmp/tmp.s6sLgrxnNV, EXEC_SOURCE empty.
- [x] Step2: LANG=javascript; reuse existing TypeScript/Vitest conventions, skill references and temporary-YAML fixtures.
- [x] Step3: TARGETS: SettingsStore.fieldsFor/read/save and renderSettingsCard; only directory-control removal and preservation behavior.
- [x] Step4: BUG_MAP=[]; requested surface reduction, not a pre-existing bug. Protect existing YAML directories, reject attempts to submit the removed field and retain unrelated settings.
- [x] Step5: Loop 1 passed 40/40 settings-store/card cases; no failures to repair. Updated the field-count/card assertions, preserved a custom YAML directory on unrelated saves, and added rejected-directory-submission coverage.
- [x] Step6: Coverage gate skipped; no requested threshold, EXEC_SOURCE empty.
- [x] Step7: Report below; build passed; safe restart requested and confirmed queued behind one running task.

### Directory Removal Test Report

- Scope: settings-store allowlist/read/save and generated card; no runtime directory-selection changes.
- Defect analysis: no functional defects discovered. Existing YAML `defaults.cwd` remains untouched; removed the now-unreachable directory comparison and import.
- Generated cases: one new rejected-directory-submission case replacing the obsolete directory-value validation case; updated existing tests to check a custom directory survives unrelated saves and no directory input is rendered.
- Validation: focused 40/40, full 2494/2494 (2476 unit, 11 process, 7 render), typecheck/build/whitespace checks passed on the first run. Coverage skipped per policy. `utree flush` attempted but not installed.
- Runtime: safe restart scheduled with reason `移除 /settings 默认工作目录设置项`; one active task, no active terminals or pending final deliveries. Completion not yet observed. No user configuration was edited.

## Grouped Thinking Cards Only

Scope: remove the retired thinking-card layout setting, renderer option, chronological renderer and fixed-count pagination. Use grouped rendering for progress, details and history cards. Preserve web Preview presentation and persisted history. Existing unknown YAML keys follow normal schema stripping; no special compatibility branch or configuration rewrite.

- [x] Step1: Prepared tools; TMP_ROOT=/tmp/tmp.6sijKlrRQt, EXEC_SOURCE empty.
- [x] Step2: LANG=javascript; renderer/configuration, presenter history navigation and existing Vitest cases read; reuse previously loaded skill references and repository conventions.
- [x] Step3: TARGETS: CardRenderer.renderTurn/renderTurnDetails/renderActivityHistory, grouped rendering/pagination, appConfigSchema/loadConfig, SettingsStore and settings cards. Include presenter history-freeze and Preview-isolation regression cases.
- [x] Step4: BUG_MAP=[]; intentional retirement. Protect approvals, errors, tools/files, stable panel IDs, pagination/history navigation and final delivery. Remove tests of obsolete chronological/40-item semantics, retain their still-supported invariants under grouped rendering.
- [x] Step5: Loop 1 passed all 407 focused cases across seven files; no failures to repair. Replaced obsolete chronological/40-item expectations with shared-grouping, byte-budget navigation and non-mutation checks; removed duplicate retired-mode parameter rows.
- [x] Step6: Coverage gate skipped (no requested threshold, EXEC_SOURCE empty).
- [x] Step7: Report below; build passed; safe restart scheduled behind one active task.

### Grouped-Only Verification Log

- Focused command: `npx vitest run tests/config/SettingsStore.test.ts tests/config/loadConfig.test.ts tests/feishu/SettingsCard.test.ts tests/feishu/CardRenderer.test.ts tests/feishu/FeishuTurnPresenter.test.ts tests/local-files/TurnPreviewPage.test.ts tests/cli/InitializationWelcome.test.ts`; 407/407 passed. Typecheck and whitespace checks passed.
- Two `npm test` attempts encountered a Vitest worker-fork unexpected exit with different unfinished case counts (2459/2469 and 2427/2469 completed). Neither reported an assertion failure. Do not treat these interrupted runs as successful or as proof of an application defect.
- A unit rerun passed 2469/2469. Its requested `--maxWorkers=1` was consumed by the PowerShell npm wrapper (explicit CLI warning), so this was not counted as serial verification. Running the Vitest Node entry directly for a genuine single-worker check; process/render stages follow separately.
- Direct single-worker check passed 2469/2469 across 113 files: `node node_modules/vitest/vitest.mjs run --exclude tests/shell/ShellCommandJobManager.test.ts --exclude tests/scripts/prepare-release.test.ts --exclude tests/feishu/GroupAvatarGenerator.test.ts --exclude tests/terminal/TerminalPty.process.test.ts --maxWorkers=1`. No source/test assertions changed between the interrupted parallel runs and the successful reruns.

### Grouped-Only Test Report

- Scope: remove obsolete layout/configuration paths, use one renderer for progress/details/history, and preserve settings ownership, final delivery, approval actions, tool/file panels, history navigation and Preview isolation.
- Defect analysis: no application defect discovered. Two parallel worker exits remain an observed test-runner limitation, not a diagnosed root cause; the complete suite passed on single-worker verification without weakening assertions.
- Generated/updated cases: three replacements for obsolete rendering/pagination tests; updated reasoning/steering and history-freeze scenarios; retired-key parsing/save protection; removed seven duplicate mode-parameter rows. Existing grouped size/component/identity tests remain intact. Raw history non-mutation and web Preview behavior are asserted.
- Validation: focused 407/407; full 2487/2487 (2469 unit, 11 process, 7 render); typecheck, build and whitespace checks passed. Runtime/configuration sources and current reference docs contain no retired layout type/key/selector. `utree flush` was attempted but its executable is unavailable; coverage measurement was skipped per skill policy.
- Runtime: safe restart scheduled with reason `移除废弃思考卡片布局，统一使用分组渲染`; one active task, no pending final deliveries or active terminals. Restart completion not yet observed. No production configuration or history was rewritten.
- Limits: no live Feishu client rendering/click verification performed.

## Agent Defaults Dropdowns

Scope: expose only default model, reasoning effort and permission as dropdowns on the Agent tab. Preserve the configured Provider, existing tasks and upstream identifiers. Discover choices without creating/resuming a task; validate model/effort combinations on explicit save.

- [x] Step1: Prepared; TMP_ROOT=/tmp/tmp.V0zZjJ5734, EXEC_SOURCE empty.
- [x] Step2: LANG=javascript; repository Vitest/TypeScript conventions and existing temporary-YAML/runtime mocks loaded. Vitest 4.1.10 resolves locally; no dependency changes.
- [x] Step3: TARGETS (explicit requested scope intersected with uncommitted settings feature): SettingsStore.fieldsFor/read/save; SettingsCard.renderField/renderSettingsCard; ProxySessionController.handleSettingsAction. Untracked files read directly; controller callback diff inspected. No other task-setting paths are targets.
- [x] Step4: BUG_MAP=[]; requested UI reduction. Existing text-field validation is intentional prior behavior, not classified as a defect. New regression risks: invalid model/effort combinations, changed Provider, lost environment references/current values when discovery fails, stale revisions after async discovery and mutation of running tasks.
- [x] Step5: Source-file loops all passed first run: store 42/42, card 9/9, controller settings 12/12. No assertion repairs needed. Full regression follows.
- [x] Step6: Coverage gate skipped (no requested threshold, EXEC_SOURCE empty).
- [x] Step7: Report below; build passed and safe restart confirmed scheduled behind one running task.

### Dropdown Verification Log

- Store loop: `node node_modules/vitest/vitest.mjs run tests/config/SettingsStore.test.ts --maxWorkers=1`; 42/42 passed, exit 0, all-pass.
- Card loop: `node node_modules/vitest/vitest.mjs run tests/feishu/SettingsCard.test.ts --maxWorkers=1`; 9/9 passed, exit 0, all-pass.
- Controller loop: `node node_modules/vitest/vitest.mjs run tests/proxy/ProxySessionController.test.ts -t "global settings panel" --maxWorkers=1`; 12/12 matched cases passed, exit 0, all-pass. The remaining 588 cases were excluded only in this targeted run and included in the subsequent regression.
- Combined six-file regression passed 736/736; typecheck and whitespace checks passed. No implementation changes or test-assertion repairs were needed after these loops.
- Full suite uses `CI=true npm test` to activate the repository's existing Windows single-worker setting; this avoids the parallel worker exits observed in the previous revision without changing test assertions or configuration.
- `utree flush` attempted with TMP_ROOT=/tmp/tmp.V0zZjJ5734; the executable is not installed. Vitest validation remains available. No numerical coverage gate was requested.

### Dropdown Test Report

- Scope: three Agent default dropdowns, catalog discovery and allowlisting, model/effort compatibility, fallback values, Provider preservation, environment-backed values, stale writes and task isolation.
- Defect analysis: no new functional defect found; existing namespace, ownership and atomic-persistence protections remain intact. Catalog errors do not expose raw upstream diagnostics. No changes to task-level setting semantics.
- Generated cases: 18 added (10 store, 1 card, 7 controller), plus updated existing cases for the reduced form and dropdown values. All targeted cases passed on their first run; no assertions were weakened.
- Validation: focused 736/736; full `npm test` 2505/2505 (2487 unit, 11 process, 7 render); typecheck, build and whitespace checks passed. Coverage gate skipped; `utree flush` unavailable as noted above.
- Runtime: safe restart requested with reason `Agent 设置精简为默认模型、默认思考强度、默认权限下拉框`; status confirmed scheduled, one running task, no pending deliveries or active terminals. Completion not yet observed.
- Limits: no live Feishu client click/render verification. No production configuration, task settings or conversation history changed by testing.

## Autosave And Address Control Removal

Scope: remove publicBaseUrl from the settings panel only; retain local YAML/network behavior. Replace explicit page saves with validated field-level autosave for all panel controls. Keep owner enforcement, task isolation and explicit safe-restart activation.

- [x] Step1: Prepared; TMP_ROOT=/tmp/tmp.jf42UU5xBi, EXEC_SOURCE empty.
- [x] Step2: LANG=javascript; reuse loaded TypeScript/Vitest skill references, repository guidance and existing settings/transport/controller fixtures. Dependencies unchanged.
- [x] Step3: TARGETS: SettingsStore.fieldsFor/read/save and field autosave; SettingsCard.renderField/renderSettingsCard; FeishuConnector.getCardActionValue; ProxySessionController.handleSettingsAction. Scope also includes single-Agent defaults presentation per the latest request.
- [x] Step4: BUG_MAP=[] at entry; this is requested new behavior. Protect against lost unrelated field edits, stale same-field updates, asynchronous discovery races, invalid partial input, unauthorized writes, accidental task/restart changes and hidden publicBaseUrl mutation.
- [x] Step5: Store/card/controller/transport loops passed; combined six-file regression 748/748, typecheck passed. Full validation follows.
- [x] Step6: Coverage gate skipped; no requested threshold, EXEC_SOURCE empty.
- [x] Step7: Report below; build passed and safe restart confirmed scheduled behind two running tasks.

Platform contract verified from official Card JSON 2.0 input/checker docs and card-callback-communication: selects report option, checkers report checked, standalone inputs report input_value only after their built-in submit icon is clicked. There is no documented input blur/change callback. Do not claim keystroke/blur autosave; remove the separate page Save action and persist each received component callback.

Single-Agent interpretation: Common replaces the default-Agent selector with Provider/model; reasoning/permission remain on Agent, without a redundant Agent picker. Other settings remain available. A clarification question was sent; no response received at implementation time. Preserve unrelated defaults/history and avoid implicit runtime reconfiguration.

Official input contract: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input

### Autosave Verification Log

- Store loop: 43/43 after field autosave/address removal; 46/46 after single-Agent Provider/model cases. Both exit 0, no test repairs.
- Card loop: 10/10 passed after replacing obsolete form/Save assertions with per-control callback, no-form and single-Agent layout assertions.
- Controller loop: 15/15 global-settings cases passed; exercises owner checks, same-card independent changes, native text/number callbacks, invalid/stale input, Provider selection, task isolation and explicit restart.
- Transport loop: 44/44 passed; verifies false checkboxes, empty input strings, upstream model IDs and preserving generic form callbacks for other features.
- Combined: `node node_modules/vitest/vitest.mjs run tests/config/SettingsStore.test.ts tests/feishu/SettingsCard.test.ts tests/proxy/ProxySessionController.test.ts tests/feishu/transport.test.ts tests/commands/CommandRouter.test.ts tests/cli/help.test.ts --maxWorkers=1` passed 748/748. No assertion weakening or unexplained failures.
- Full run 1: `CI=true npm test` completed unit stage with 2495/2499 passing. Four unchanged LocalFileViewerServer cases failed at fetch with `bad port`; no settings assertions failed. Rechecking that file in isolation and then the full suite without changing Preview code or test expectations. Process/render stages did not run in this failed invocation.
- Isolated LocalFileViewerServer retry passed 45/45 without edits. Full run 2 had no assertion failures but a Vitest worker exited unexpectedly after 2498/2499 unit cases (112/113 files), so it is not a successful validation. Running the direct Vitest entry with explicit maxWorkers=1 and a JSON result artifact under .tmp for a complete check; process/render stages follow separately. No unrelated source/tests changed to mask either failure.
- Full run 3: the direct single-worker Vitest entry passed all 2499/2499 unit cases; `.tmp/settings-autosave-unit-results.json` reports success with no failed or pending cases. Separate `npm run test:process` passed 11/11 and `npm run test:render` passed 7/7. Full validation totals 2517/2517; `npm run build` passed.

### Autosave Test Report

- Scope: field-level persistence, independent card callbacks, single-Agent Provider/model placement, dependent defaults validation, owner enforcement, stale-write handling, task isolation and address-control removal.
- Defect analysis: no new application defect found. Initial full runs encountered the recorded unrelated fetch bad-port failures and worker exit; both remain undiagnosed test-run limitations. Complete rerun passed without changing unrelated source or weakening assertions.
- Generated cases: added and updated store/card/controller/transport coverage for same-card independent edits, stale same-field edits, false/empty callback values, invalid input, single-Agent defaults, Provider/model/reasoning compatibility and preservation of YAML-only address configuration.
- Validation: focused 748/748; full 2517/2517 (2499 unit, 11 process, 7 render); typecheck and build passed. Coverage measurement skipped under the skill policy. `utree flush` was attempted but its executable is unavailable.
- Runtime: safe restart requested with reason `设置逐项自动保存，精简单 Agent 配置并移除对外访问地址入口`; status confirms scheduled, two running tasks, no pending final deliveries or active terminals. Restart completion not yet observed.
- Limits: no live Feishu client rendering/click verification. Text controls still require the native submit icon because Feishu does not report blur/keystroke callbacks; selects and switches save on change. No production configuration or task history was edited during testing.
