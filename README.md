# afk

`afk` runs a prepared coding task through fresh Codex sessions, one task per session. The code skill decides when the work is complete, blocked, or needs another iteration.

## Prerequisites

- Node.js 22 or newer and npm.
- An installed, authenticated `codex` CLI available on `PATH`.
- The code skill available to Codex in the project workspace. Prepare the workspace and its dependencies before starting `afk`.

Build with `npm install && npm run build`. For local use, invoke `node dist/main.js`. The package exposes the `afk` executable when installed or run through `npx`.

## Usage

Supply exactly one prompt source:

```sh
afk 'Read specs/feature.spec.md and implement specs/feature.plan.json'
afk --prompt-file prompt.txt
cat prompt.txt | afk
```

The current directory is the workspace unless `--cwd <directory>` selects another existing directory. A stopped run can be restarted with the same prompt in the same workspace; each invocation starts a fresh session budget and the code skill reads project progress from the workspace.

| Option | Purpose |
| --- | --- |
| `--cwd <directory>` | Select the workspace. |
| `--model <model>` | Override the configured Codex model. |
| `--reasoning-effort <effort>` | Override the configured reasoning effort. |
| `--max-iterations <count>` | Limit Codex session launches, including retries; default is 10. |
| `--session-timeout <seconds>` | Set a per-session timeout; absent by default. |
| `-h`, `--help` | Print usage and exit codes. |

| Exit code | Meaning |
| --- | --- |
| `0` | Feature completion reported, or help displayed. |
| `1` | Input or option error, reported blocker, execution error, or iteration limit. |
| `2` | Session timeout. |
| `130` | Interrupted by Ctrl+C. |
