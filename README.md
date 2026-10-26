# afk

`afk` runs a prepared coding task through fresh coding agent sessions, one task per session. Choose the agent with `--agent`; Codex is the default. The agent decides when the work is complete, blocked, or needs another iteration.

## Prerequisites

- Node.js 22 or newer and npm.
- An installed, authenticated CLI for the agent you select, available on `PATH`.
- Prepare the workspace and its dependencies before starting `afk`.

Build with `npm install && npm run build`. For local use, invoke `node dist/main.js`. The package exposes the `afk` executable when installed or run through `npx`.

## Usage

Supply exactly one prompt source:

```sh
afk 'Read specs/feature.spec.md and implement specs/feature.plan.json'
afk --prompt-file prompt.txt
cat prompt.txt | afk
```

The current directory is the workspace unless `--cwd <directory>` selects another existing directory. A stopped run can be restarted with the same prompt in the same workspace; each invocation starts a fresh session budget and the agent reads project progress from the workspace.

| Option | Purpose |
| --- | --- |
| `--cwd <directory>` | Select the workspace. |
| `--agent <name>` | Choose `codex` or `claude`; default is `codex`. |
| `--model <model>` | Pass a model value to the agent unchanged. |
| `--reasoning-effort <effort>` | Pass a reasoning effort value to the agent unchanged. |
| `--max-iterations <count>` | Limit agent session launches, including retries; default is 10. |
| `--session-timeout <seconds>` | Set a per-session timeout; absent by default. |
| `-h`, `--help` | Print usage and exit codes. |

| Exit code | Meaning |
| --- | --- |
| `0` | Feature completion reported, or help displayed. |
| `1` | Input error, reported blocker, execution error, or iteration limit. |
| `2` | Option error or session timeout. |
| `130` | Interrupted by Ctrl+C. |

## Supported agents

- **Codex (`--agent codex`)**: Install and authenticate the `codex` CLI with `--approve-for-me` support. `afk` launches `codex exec --approve-for-me` with the prompt on stdin and reads the final message from stdout. It passes `--model` as a model override and `--reasoning-effort` as Codex's `model_reasoning_effort` setting.
- **Claude Code (`--agent claude`)**: Install and authenticate the `claude` CLI. The `auto` permission mode must be available for your account and selected model. `afk` launches Claude in non-interactive print mode with JSON output and `--permission-mode auto`, sends the prompt on stdin, and reads the JSON `result`. It passes `--model` to Claude's `--model` and `--reasoning-effort` to Claude's `--effort`.

Both agents use `--cwd`, `--max-iterations`, and `--session-timeout` in the shared harness. Model and reasoning effort overrides are passed only when supplied; otherwise each agent uses its own configuration. `afk` does not translate or validate these values for the selected agent.

Agent stdout and stderr are shown as they arrive. `afk` continues to use the captured stdout to read the final response. Codex normally emits activity on stderr; Claude's JSON output may arrive only when its session finishes.
