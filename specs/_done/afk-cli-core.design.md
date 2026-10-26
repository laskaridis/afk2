# Design: afk CLI core

The repository has no application code (only a prototype `afk.sh` showing the intended Codex invocation and protocol checks, which is reference material, not architecture). This design defines the minimal module set for the TypeScript CLI.

## Modules

| Module | Single responsibility (reason to change) | Interface (small) |
| --- | --- | --- |
| `cli` | Turn argv, stdin and the environment into validated run options or a usage/input error; render help. Changes when the user-facing invocation changes. | `parseInvocation(argv, stdin, cwd) -> Options \| HelpRequested \| InputError` |
| `protocol` | Decide whether a final assistant message is a valid code-skill response. Changes when the code skill contract changes. | `parseResponse(text) -> Response \| Violation` |
| `session` | The Codex process boundary: launch one non-interactive session, stream its activity, capture the final message separately, enforce timeout, terminate on abort. Changes when the Codex CLI changes. | `runSession(config, signal) -> SessionResult` (`ok{finalMessage}` / `launch-failed` / `exit-failed{status}` / `timed-out`) |
| `run` | The policy: iteration budget, retry allowance, outcome handling, final status. Pure of process details so it is testable with a fake session. Changes when loop rules change. | `runLoop(options, sessionRunner, reporter, signal) -> RunStatus` |
| `main` (bin) | Wire modules, map `RunStatus` to exit codes and terminal output, translate Ctrl+C into an abort signal. | `afk` executable |

## Key decisions

- `RunStatus` is one of: completed, blocked, execution-error (launch / exit status / bad response), iteration-limit, timeout, interrupted. Each carries the detail AC-029 requires.
- `session` receives the session runner as an injectable dependency of `run`, so loop policy is tested without Codex, and `session` is tested against a fake `codex` executable on `PATH`.
- Final response comes only from Codex's dedicated last-message output, never from streamed activity (AC-010). Any temporary file used for this is removed and is not a harness log (AC-030).
- No state is kept between runs; every invocation starts a fresh budget (AC-026).
- Node.js with TypeScript, compiled output exposed as the `afk` bin, runnable via `npx`. Package name is not fixed by the spec; the executable name is `afk`.

## Spec notes

- The spec uses AC-025 twice (help, and Ctrl+C) and has no AC-007. Tasks refer to both as AC-025; the plan distinguishes them by description.
