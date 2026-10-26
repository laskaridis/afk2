# Design: Agent adapters

Extends the architecture in `_done/afk-cli-core.design.md` (cli, protocol, session, run, main). No new layers; one new module group.

## Modules

| Module | Single responsibility (reason to change) | Interface |
| --- | --- | --- |
| `agents/<name>` (one per agent: `codex`, `claude`) | Everything specific to one agent CLI: its executable, its argument list, and how its stdout yields the final message. Changes only when that agent's CLI changes. | `AgentAdapter` (AC-019), pure functions only |
| `agents/registry` | The single name -> adapter map, default agent name, and supported-name list used by validation, errors and help. | `agents`, `defaultAgent`, `agentNames` |
| `cli` | Gains `--agent` (validated against the registry; empty/unsupported is an option error), agent-neutral help. | `RunOptions.agent: string` |
| `session` | Agent-neutral process boundary: spawn adapter executable, stdin prompt, capture stdout and last 20 stderr lines, timeout/abort, map exits to results. No live output, no temp files. | `runSession(config, signal)`; config carries the adapter |
| `run` | Unchanged policy; execution errors gain the detail needed for reporting (exit code or signal, Claude `subtype`, parse reason, stderr tail). | `runLoop(...)` |
| `main` | Agent-neutral `[afk]` reporting, stderr tail printing after execution errors, exit codes. | `afk` executable |

## Decisions

- Session results gain a `stderrTail` (<= 20 lines) on every non-timeout, non-abort outcome; the reporter prints it only after an `Execution error` line.
- `extractFinalMessage` returns `{ kind: 'message', text } | { kind: 'missing' } | { kind: 'invalid', reason }`; the session runner maps `missing`/`invalid` to the existing `missing-response` / `invalid-response` execution errors. The Claude `is_error` handling (exit-failed with `subtype`, even on non-zero exit) needs the adapter to see stdout on non-zero exits; the exact shape of that interplay is left to the implementer provided AC-008 table is met.
- Exit codes (decided with the user): option errors and the session timeout both exit `2`; blocker, execution error, iteration limit, and input errors keep exit `1`; Ctrl+C `130` (SIGTERM 143, SIGHUP 129 unchanged). All status lines use the `[afk] ` prefix.
- Spec AC-003 says "usage-error exit code (2)"; the spec's "input errors" (missing/empty/multiple prompt) are not named, so they keep their current exit code `1`.
