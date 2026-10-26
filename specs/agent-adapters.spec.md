# Feature Specification: Agent adapters

## Purpose / Big Picture

`afk` currently runs only Codex. Developers who use other coding agents, starting with Claude Code, cannot use it, and adding an agent today means changing Codex-specific code throughout the session runner, reporting, and help text.

This feature makes `afk` a harness layer above interchangeable coding agents. The user picks the agent with `--agent` when invoking `afk`; everything else (prompt input, options, `[afk]` status lines, protocol handling, retries, limits, timeouts, interruption, final status, and exit codes) looks and behaves the same regardless of the agent. Maintainers can add a new agent by writing one small adapter and registering it, without touching the loop or the session runner.

This specification extends [afk-cli-core.spec.md](afk-cli-core.spec.md). Where it states that behavior applies to "Codex", it now applies to the selected agent. AC-028 of that spec (live agent activity) is superseded by US-003 below.

## User stories

### US-001: Choose the coding agent for a run

As a developer, I want to select the coding agent when I invoke `afk`, so that I can run the same unattended workflow with the agent I use.

#### Acceptance criteria

- **AC-001:** Given no `--agent` option, when a run starts, then every session uses Codex, so existing invocations keep working unchanged.
- **AC-002:** Given `--agent codex` or `--agent claude`, when a run starts, then every session in the run, including retries, uses the selected agent.
- **AC-003:** Given `--agent` with an unsupported or empty value, when the invocation is evaluated, then `afk` reports an option error that lists the supported agent names, exits with the usage-error exit code (`2`), and starts no session.
- **AC-004:** Given `--help` or `-h`, when help is printed, then it documents `--agent <name>`, lists the supported agent names, and states the default (`codex`). Help still takes precedence over every other option, including an invalid `--agent` value.
- **AC-005:** Given `--model <model>` or `--reasoning-effort <effort>`, when a session starts, then the value is passed to the selected agent unchanged. `afk` does not translate, map, or validate the value against the agent, beyond the existing non-empty check. Given neither option, the agent's own configuration applies.

### US-002: Run unattended work with Claude Code

As a developer who uses Claude Code, I want `afk` to drive Claude Code sessions, so that I can leave Claude implementing a feature one task at a time.

#### Acceptance criteria

- **AC-006:** Given `--agent claude`, when a session starts, then `afk` launches a fresh, non-interactive `claude` process in print mode with JSON output and the `auto` permission mode, in the selected workspace, with the session prompt written to its stdin. It adds `--model <model>` and `--effort <effort>` only when the corresponding `afk` option is given. It never selects a full-access permission mode such as `bypassPermissions`.
- **AC-007:** Given a Claude session that exits with code `0` and prints a JSON result whose `result` field is a non-empty string, when the session ends, then `afk` evaluates that `result` text with the existing code skill protocol rules and acts on the outcome exactly as it does for Codex.
- **AC-008:** Given a Claude session, when it ends, then results are classified using the existing execution error kinds and the existing retry-once policy applies:

  | Claude session result | Execution error |
  | --- | --- |
  | Process could not be started | launch failed |
  | Non-zero exit code without a structured `is_error: true` result, or terminated by a signal | exited unsuccessfully (with exit code or signal) |
  | Exit code `0`, stdout is not valid JSON | invalid response (agent output could not be parsed) |
  | JSON result reports `is_error: true` on exit code `0` or a non-zero exit | exited unsuccessfully, with Claude's reported `subtype` included in the reported reason |
  | Exit code `0`, stdout empty or JSON has no non-empty `result` string | missing response |
  | `result` text violates the code skill protocol | invalid response (existing protocol reasons) |

  A structured `is_error: true` result on a non-zero exit is a deliberate exception to the earlier rule that every non-zero exit is reported only with its exit code.

- **AC-009:** Given a Claude session, when the session timeout expires or the user presses Ctrl+C, then `afk` terminates it and ends the run exactly as it does for Codex: same messages, no retry, and the same exit codes.

### US-003: See the same quiet harness output for every agent

As a developer, I want a run to look the same whichever agent runs it, so that switching agents does not change what I see or how I read the outcome.

#### Acceptance criteria

- **AC-010:** Given any agent, when a session runs, then the agent's stdout is captured by `afk` and not shown in the terminal. The only output during a run is the `[afk]` status lines on stderr. This applies to Codex as well, whose output previously streamed to the terminal.
- **AC-011:** Given any agent, when an iteration starts, then the status line is `[afk] Iteration <n>/<max>: starting agent session`. Retry lines, task-failure lines, execution-error lines, and final status lines name no specific agent. For example: "failed to launch agent", "agent exited unsuccessfully with exit code 3", "agent exited without a final response", "agent final response is invalid: …", "agent session timed out after 1800 seconds".
- **AC-012:** Given the same sequence of session results from Codex and from Claude, when two runs execute, then they produce the same `[afk]` stderr lines, the same final status, and the same exit code.
- **AC-013:** Given `--agent codex`, when a session starts, then Codex is launched as today (`exec`, automatic approval review, the selected workspace, optional model and reasoning-effort overrides, prompt on stdin), except that `afk` reads the final message from Codex's piped stdout and no longer passes `--output-last-message` or creates a temporary output file. Exit code `0` with empty or whitespace-only stdout is a missing response.
- **AC-014:** Given any run, when it ends, then `afk` has written no log files, temporary session files, or run history.
- **AC-015:** Given a long-running session, when it is in progress, then `afk` prints no periodic progress or heartbeat lines.

### US-004: Diagnose an execution error from the agent's error output

When an agent session ends with an execution error, I want to see the end of the agent's error output, so that I can understand what went wrong even though agent output is hidden.

#### Acceptance criteria

- **AC-016:** Given any agent, when a session runs, then its stderr is captured and not shown live, and `afk` keeps only its last 20 lines.
- **AC-017:** Given a session that ends with an execution error and produced stderr output, when the `[afk] Execution error: …` line is printed, then up to the last 20 stderr lines from that session are printed to stderr directly after it, in their original order. Given no stderr output, nothing extra is printed.
- **AC-018:** Given a session that ends with a valid protocol response, a timeout, or an interruption, when its result is reported, then no agent stderr is printed.

### US-005: Add a new coding agent with one adapter

For the `afk` codebase, we need each agent to be implemented as one self-contained adapter in a built-in registry, so that adding an agent does not require changes to the run loop, session runner, protocol handling, or reporting.

#### Acceptance criteria

- **AC-019:** Given the codebase, when an agent is supported, then it is implemented by one module under `src/agents/` that exports an adapter with this shape and is registered in a single registry that maps names to adapters:

  ```ts
  interface AgentAdapter {
    name: string;        // value accepted by --agent, e.g. 'codex', 'claude'
    executable: string;  // command to launch, e.g. 'codex', 'claude'
    buildArgs(input: { cwd: string; model?: string; effort?: string }): string[];
    extractFinalMessage(stdout: string): FinalMessageResult; // final message text, or missing / invalid
  }
  ```

  `buildArgs` and `extractFinalMessage` are pure functions. Adapters have no per-session state, temporary files, or cleanup.
- **AC-020:** Given any adapter, when a session runs, then the shared session runner owns everything else: spawning the executable in the workspace, writing the prompt to stdin, capturing stdout and the stderr tail, timeouts, Ctrl+C handling, mapping process exits to execution errors, and passing the extracted final message to the existing protocol parser.
- **AC-021:** Given an adapter whose agent does not support a harness setting (such as `model` or `effort`), when that setting is supplied, then the adapter ignores it and `afk` prints no warning and reports no error.
- **AC-022:** Given the `--agent` option, when the supported names are validated and listed in errors and help, then they come from the registry, so a newly registered adapter is selectable and listed without other changes.
- **AC-023:** Given the test suite, when it runs, then one shared set of harness behavior tests (protocol outcomes, retry policy, iteration limit, timeout, interruption, stderr tail, and output wording) runs against every registered adapter using a fake executable fixture per agent, plus unit tests of each adapter's `buildArgs` and `extractFinalMessage`. Each fixture emits its final message the way the real agent does: the Codex fixture writes it to stdout and no longer reads `--output-last-message`, and the Claude fixture writes the JSON result object to stdout. The tests do not require a real agent installation.

### US-006: Learn which agents are supported and what they need

As a developer, I want the help and README to describe `afk` independently of any one agent and to list each supported agent's prerequisites, so that I can prepare my environment for the agent I choose.

#### Acceptance criteria

- **AC-024:** Given `afk --help`, when it is printed, then its description and option texts refer to "the coding agent" rather than Codex, and `--model` and `--reasoning-effort` state that the value is passed to the agent unchanged.
- **AC-025:** Given the README, when it is read, then it describes `afk` as agent-neutral, documents `--agent`, and has a "Supported agents" section listing, for each agent, its prerequisites and how `afk` launches it. For Codex these are: Codex CLI installed and authenticated with `--approve-for-me` support. For Claude Code: Claude Code CLI installed and authenticated, `auto` permission mode available for the account and model, and the `code` skill discoverable by Claude Code (for example under `.claude/skills`). The section also says which harness settings each agent honors.
- **AC-026:** Given the package metadata, when it is published, then its description no longer names Codex as the only agent.

### US-007: Verify the adapters against the real agents

As a maintainer, I want each adapter checked once against the real agent CLI, so that the fake fixtures do not hide a wrong assumption about how the agent reports its final message.

#### Acceptance criteria

- **AC-027:** Given the Codex CLI and the Claude Code CLI installed and authenticated, when a manual smoke check is run after implementation, then the following are recorded as evidence, with the CLI versions used:
  - `codex exec --approve-for-me -o <file> -` run with stdout piped and a trivial prompt writes the same final message to stdout as to `<file>`, apart from surrounding whitespace.
  - `afk --agent codex` and `afk --agent claude` each run once in a scratch workspace with a prompt that names no specification or task list. Each run ends with `[afk] Run blocked: …` and exit code `1`, which shows that the code skill's `blocked` response was read and parsed end to end.

  This check is manual and is not part of the automated test suite. It changes no source files. Any mismatch becomes a follow-up fix task.

## Assumptions

- The CLI flag stays `--reasoning-effort`; only the internal field is named `effort`. The flag was not renamed during the interview, and keeping it avoids breaking existing invocations.
- `codex exec` without `--json` writes only the final agent message to stdout when stdout is not a terminal, followed by a newline, and sends all progress and status output to stderr. When stdout is a terminal, the final message goes to stderr instead. `afk` always pipes stdout, so it always gets the stdout path. Source: `codex-rs/exec/src/event_processor_with_human_output.rs` (`print_final_output`) on the `openai/codex` main branch, checked against the docs while `codex-cli 0.162.1` was installed locally. The final message is printed only when Codex decides to emit it at shutdown, and the source does not document when it doesn't. If it is not printed, stdout is empty and the session is reported as a missing response under AC-013. AC-027 verifies this against the real CLI.
- `claude -p --output-format json` prints a single JSON object whose `result` field holds the final assistant message, and includes `is_error` and `subtype` fields. `claude` supports `--permission-mode auto`, `--model`, and `--effort`. The flags and the `auto` permission mode were confirmed with `claude --help`. The JSON fields are not yet confirmed; AC-027 checks them.
- If Claude's `auto` permission mode is unavailable, the resulting Claude error is handled as an ordinary execution error. There is no dedicated detection or message.
- Prerequisites are not checked before the first session. A missing agent executable is a launch failure, handled by the existing retry-once policy.
- Each agent's own session persistence and configuration are left untouched. `afk` adds no agent-specific flags beyond those listed above.
- The code skill's response protocol, the session prompt (harness instructions), exit codes, and the run loop behavior are unchanged and identical for every agent.
- The stderr tail is printed for each execution error, including the first one that leads to a retry.

## Out of Scope

- Agents other than Codex and Claude Code.
- Loading adapters from outside the package (plugins) or selecting the agent through environment variables or configuration files.
- Showing, rendering, or normalizing live agent activity, heartbeat lines, or per-session log files.
- Translating or validating `--model` or `--reasoning-effort` values per agent, and warning about ignored settings.
- Options that apply to one agent only, user-facing executable overrides, and passing extra arguments through to the agent.
- Pre-flight checks of agent installation, authentication, permission-mode availability, or skill presence.
- Renaming `--reasoning-effort`, changing exit codes, changing the code skill protocol, or changing the session prompt.
- Full-access permission modes for any agent.
- Version bumps, changelogs, and publishing.

## Clarifications needed

None. The minor inferred defaults are recorded under Assumptions.
