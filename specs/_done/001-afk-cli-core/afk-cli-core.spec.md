# Feature Specification: afk CLI core

## Purpose / Big Picture

`afk` lets a developer leave a coding agent implementing a specified feature, one task at a time, without remaining available to answer questions or approve actions. Each iteration starts a fresh codex session to avoid accumulating conversation context. The code skill preserves continuity through task status and working memory in the prepared project workspace.

The first version is a small, reusable TypeScript CLI distributed as an npm-compatible package for use through `npx`. It manages session execution, validates the skill's responses, and decides whether to continue or stop. The code skill owns the development workflow.

## User stories

### US-001: Launch work using one prompt in a prepared workspace

As a developer, I want to supply feature instructions through my preferred shell input method, so that I can start unattended work in different projects.

#### Acceptance criteria

- **AC-001:** Given a non-empty prompt supplied as the single positional argument, such as `afk "feature instructions"`, and no other prompt source, when `afk` starts, then it uses that argument as the launch prompt. Document references and specifications in the prompt remain user-provided context for Codex.
- **AC-002:** Given `--prompt-file <path>` as the only prompt source and the file contains non-empty text, when `afk` starts, then it uses the file contents as the launch prompt. Document references and specifications in the file remain user-provided context for Codex.
- **AC-003:** Given non-empty stdin input as the only prompt source, when `afk` starts, then it uses that input as the launch prompt. Document references and specifications in the input remain user-provided context for Codex.
- **AC-004:** Given multiple prompt sources, no prompt source, an empty prompt, or an unreadable prompt file, when the invocation is evaluated, then `afk` reports a clear input error, exits unsuccessfully, and launches no Codex session. Inputs are not combined or silently ignored. An interactive terminal with no prompt is treated as missing input rather than prompting the user.
- **AC-005:** Given a valid invocation, when execution starts, then the current directory is the working directory unless `--cwd <directory>` selects another existing directory. Every session uses that selected workspace.
- **AC-006:** Given a prepared workspace, when a run starts, then the harness does not create or switch Git branches, create worktrees, install the code skill, or prepare project dependencies. It does not require a particular project language, test command, specification filename, or task-file format.

### US-002: Implement successive tasks in fresh sessions

As a developer, I want each iteration to start with fresh conversation context while retaining project progress, so that a feature can advance across multiple tasks.

#### Acceptance criteria

- **AC-008:** Given a valid launch prompt, when an iteration begins, then the harness starts a new non-interactive Codex session with the original launch prompt and instructions to use the available code skill for one task and follow its response protocol.
- **AC-009:** Given multiple iterations, when one session ends and another starts, then sessions run sequentially in the same workspace. The harness does not resume or fork the preceding conversation or replay its transcript. The skill reads persisted project state to recover context.
- **AC-010:** Given a successfully exited Codex process, when its final assistant message is evaluated separately from streamed activity, then the harness accepts that message only if it is a single JSON object conforming to the code skill's protocol. Leading and trailing whitespace are allowed; surrounding prose, Markdown fences, missing required fields, and unsupported outcomes are contract violations. JSON appearing in streamed activity is not treated as the final response.
- **AC-011:** Given a valid protocol response, when the harness handles it, then it performs the corresponding action below, subject to the session limit:

  | Response | Harness action |
  | --- | --- |
  | `{"outcome":"repeat"}` | Start a fresh session. |
  | `{"outcome":"complete"}` | Report completion and exit successfully. |
  | `{"outcome":"blocked","blocker_text":"..."}` | Print the blocker and exit unsuccessfully without starting another session. |
  | `{"outcome":"fail","failure_summary":"..."}` | Surface the failure summary and start a fresh session so the skill can address the recorded follow-up work. |

  `blocker_text` and `failure_summary` must be non-empty strings. `repeat` and `complete` must have no additional fields. The current contract is defined in the [code skill](https://github.com/laskaridis/skills/blob/main/skills/code/SKILL.md).

- **AC-012:** Given a valid outcome, when deciding what to do next, then the harness trusts that outcome. It does not independently parse task files, select or generate tasks, inspect Git state to judge progress, run project tests, review implementation, or decide whether acceptance criteria are satisfied.

### US-003: Run without a person approving actions

As a developer, I want execution to proceed without interactive approval requests while respecting my Codex setup, so that I can leave the tool unattended.

#### Acceptance criteria

- **AC-013:** Given any session, including a retry, when Codex is launched, then automatic approval review is explicitly selected. The harness does not offer a full-access mode or silently broaden permissions when an action is denied.
- **AC-014:** Given a missing required specification or task list, or a permission denial or material development ambiguity that leaves no authorized next step after checking available context, when the code skill stops, then it returns a valid `blocked` response stating the reason and exact unblock condition. The harness prints that response and ends unsuccessfully without asking the user a question or starting another session.
- **AC-015:** Given existing Codex configuration and no model or reasoning-effort override, when a session starts, then those settings are inherited. Given `--model <model>` or `--reasoning-effort <effort>`, then the supplied setting overrides the corresponding inherited value for every session in the run, including retries. Unrelated Codex settings remain inherited.
- **AC-016:** Given a session that cannot proceed within its effective environment or permissions, when it reports `blocked`, then the run ends with its explanation rather than waiting for the user. If it exits without a valid response, the execution-error policy applies instead.

### US-004: Recover once from an execution error

When Codex fails to execute or violates the response contract, I want one automatic retry, so that a transient failure need not end an unattended run.

#### Acceptance criteria

- **AC-017:** Given a process launch failure, unsuccessful process exit, or missing or invalid final response, when an execution attempt ends, then the harness reports the error and starts one fresh-session retry if the overall session budget allows it. An unsuccessful process exit is an execution error even if output contains an apparent protocol response.
- **AC-018:** Given that retry, when another execution error occurs before any valid response, then the harness reports the failure and stops unsuccessfully. A valid response resets the consecutive execution-error allowance. A valid `fail` outcome is a development outcome, not an execution error.
- **AC-019:** Given a retry after partial project changes, when the retry starts, then the harness preserves those changes in the same workspace and supplies the original prompt and code-skill instructions.

### US-005: Bound an unattended run

As a developer, I want a session limit and an optional session timeout, so that I can bound unattended execution.

#### Acceptance criteria

- **AC-020:** Given no explicit limit, when a run starts, then it allows at most 10 Codex session launches. `--max-iterations <count>` overrides this with a positive integer. Every launch attempt, including retries, consumes one iteration.
- **AC-021:** Given the last allowed iteration returns `repeat` or `fail`, or requires a retry, when its result is handled, then the harness starts no further session, reports that the iteration limit was reached without reported completion, and exits unsuccessfully. A valid `complete` response on the last allowed iteration still ends successfully; a valid `blocked` response still reports the blocker.
- **AC-022:** Given no `--session-timeout`, when a session runs, then the harness imposes no session timeout. Given `--session-timeout <seconds>`, then that positive duration applies separately to each session.
- **AC-023:** Given a configured timeout expires, when the active session is interrupted and terminated, then the harness reports the timeout and stops the entire run unsuccessfully. It does not retry or start another iteration, and it preserves existing project changes.
- **AC-024:** Given an invalid limit or timeout, when the invocation is evaluated, then the harness reports an option error and starts no Codex session.
- **AC-025:** Given `--help` or `-h`, when the invocation is evaluated, then the harness prints usage, options, and exit codes to standard output, exits successfully, and starts no Codex session. Help takes precedence over validation of other options and over prompt input.

### US-006: Interrupt work and continue later

As a developer, I want to stop execution and later rerun the same prompt, so that I can retain completed and partial work without managing harness checkpoints.

#### Acceptance criteria

- **AC-025:** Given an active run, when the user presses Ctrl+C, then the harness forwards the interruption to the active Codex process, prevents further iterations and retries, and exits as interrupted. It does not wait for the task to finish, roll back changes, or delete the skill's working memory.
- **AC-026:** Given a run stops through interruption, timeout, an error, a blocker, or the iteration limit, when the user launches `afk` again with the same prompt in the same workspace, then it starts a fresh run with a fresh session budget.
- **AC-027:** Given foreground execution, when stopping the active session, then the harness terminates the session it manages before ending the run. It does not deliberately detach Codex to continue working after the harness exits.

### US-007: Observe activity and understand why the run stopped

As a developer, I want live terminal activity and a clear final outcome, so that I can understand execution without a saved logging system.

#### Acceptance criteria

- **AC-028:** Given Codex is running, when it emits user-visible activity, then the harness displays that activity during execution rather than withholding everything until the process exits. Iteration starts and execution-error retries are identifiable.
- **AC-029:** Given a run ends, when its final status is displayed, then it identifies completion, a reported blocker, an execution error, the iteration limit, a timeout, or user interruption. A blocker includes its `blocker_text`; an execution error identifies whether launch failed, the process exited unsuccessfully with its exit status, or the final response was missing or invalid; an iteration-limit stop includes the configured limit; and a timeout includes the configured duration. Only a valid `complete` outcome reports feature completion and exits successfully.
- **AC-030:** Given any run, when the harness manages execution, then it creates no persistent harness logs, run-history directory, or resume database. This does not remove or suppress the code skill's task and progress files or Codex's own session storage.

## Assumptions

- Users have Node.js/npm, an installed and authenticated Codex CLI supporting automatic review, and a code skill discoverable by Codex. The harness does not provision them.
- Users supply feature specifications and tasks in their custom prompt, including references to files where applicable. The skill checks these prerequisites; the harness does not interpret or create them.
- The code skill owns task priority, dependencies, one-task scope, testing, acceptance evidence, reviews, task status, commits, follow-up tasks, and working memory such as `progress.txt`.
- On a later run, the code skill reads available task status, progress notes, and workspace changes to decide what work remains.
- The workspace, Git branch or worktree, dependencies, credentials, and other environment prerequisites are prepared by the user. The harness runs in the foreground; external backgrounding or terminal multiplexers are the user's choice.
- The harness does not rewrite project files or user configuration to configure itself. The code skill may modify project files as authorized by the task. The harness supplies its automatic-review setting and any explicitly requested model or reasoning-effort override for the launched sessions, without editing the user's configuration files.
- The repository currently has no application implementation or established application architecture to extend.
- Seconds are the inferred unit for `--session-timeout`; limits must be positive. Numeric exit-code assignments beyond success versus unsuccessful/interrupted termination are implementation details.
- The executable name is `afk`. npm package-name availability has not been established; a different package name may expose that executable. Publishing is separate from making the package runnable through `npx`.

## Out of Scope

- Specification authoring, task generation, task-format normalization, or project-specific workflow rules in the harness.
- Independent task verification, progress detection, review sessions, or further changes to the code skill beyond its unattended blocked-response rule.
- Branch or worktree management, dependency installation, environment provisioning, skill installation, or Codex authentication flows.
- Full-access permission modes, interactive approvals, notifications, or waiting for user answers.
- Saved harness logs, run history, dedicated resume commands, persisted run settings, or replaying previous conversations.
- Background daemons, detached execution, parallel task sessions, automatic rollback, automatic permission broadening, or retries beyond the agreed single consecutive execution-error retry.
- Arbitrary Codex-argument passthrough, a separate configuration-file system, cost budgets, or an overall elapsed-time limit.
- Publishing the package to npm as part of implementing this specification.

## Clarifications needed

None. The agreed behavior is sufficient to implement v1; the minor inferred defaults are recorded under Assumptions.
