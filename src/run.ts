import type { RunOptions } from './cli.js';
import { parseResponse } from './protocol.js';
import type { SessionConfig, SessionResult } from './session.js';
import { adapters, defaultAgentName } from './agents/registry.js';

export type ExecutionError =
  | { kind: 'launch-failed'; message: string }
  | { kind: 'exit-failed'; status: number | null }
  | { kind: 'missing-response' }
  | { kind: 'invalid-response'; reason: string };

export type RunStatus =
  | { kind: 'completed' }
  | { kind: 'blocked'; blockerText: string }
  | { kind: 'execution-error'; error: ExecutionError; stderrTail: string[] }
  | { kind: 'iteration-limit'; limit: number }
  | { kind: 'timeout'; duration: number }
  | { kind: 'interrupted' };

export type RunEvent =
  | { kind: 'iteration-start'; iteration: number; limit: number }
  | { kind: 'execution-error'; error: ExecutionError; stderrTail: string[] }
  | { kind: 'retry'; iteration: number }
  | { kind: 'fail'; summary: string };

export type SessionRunner = (config: SessionConfig, signal: AbortSignal) => Promise<SessionResult>;
export type Reporter = (event: RunEvent) => void;

/** Apply the code-skill outcome policy without inspecting project state. */
export async function runLoop(options: RunOptions, runSession: SessionRunner, report: Reporter, signal: AbortSignal): Promise<RunStatus> {
  const config: SessionConfig = {
    adapter: adapters.get(options.agent ?? defaultAgentName)!,
    prompt: options.prompt,
    cwd: options.cwd,
    ...(options.model !== undefined && { model: options.model }),
    ...(options.reasoningEffort !== undefined && { reasoningEffort: options.reasoningEffort }),
    ...(options.sessionTimeout !== undefined && { sessionTimeout: options.sessionTimeout }),
  };
  let consecutiveErrors = 0;
  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    if (signal.aborted) return { kind: 'interrupted' };
    report({ kind: 'iteration-start', iteration, limit: options.maxIterations });
    if (signal.aborted) return { kind: 'interrupted' };
    const result = await runSession(config, signal);
    if (signal.aborted || result.kind === 'aborted') return { kind: 'interrupted' };
    if (result.kind === 'timed-out') return { kind: 'timeout', duration: options.sessionTimeout ?? 0 };

    let error: ExecutionError;
    if (result.kind === 'launch-failed') error = { kind: 'launch-failed', message: result.message };
    else if (result.kind === 'exit-failed') error = { kind: 'exit-failed', status: result.status };
    else if (result.kind === 'missing-response') error = { kind: 'missing-response' };
    else if (result.kind === 'invalid-response') error = { kind: 'invalid-response', reason: result.reason };
    else {
      const response = parseResponse(result.finalMessage);
      if ('kind' in response) {
        error = result.finalMessage.trim()
          ? { kind: 'invalid-response', reason: 'code skill protocol violation' }
          : { kind: 'missing-response' };
      } else {
        consecutiveErrors = 0;
        if (response.outcome === 'complete') return { kind: 'completed' };
        if (response.outcome === 'blocked') return { kind: 'blocked', blockerText: response.blocker_text };
        if (response.outcome === 'fail') report({ kind: 'fail', summary: response.failure_summary });
        continue;
      }
    }

    consecutiveErrors++;
    if (consecutiveErrors >= 2) return { kind: 'execution-error', error, stderrTail: result.stderrTail ?? [] };
    report({ kind: 'execution-error', error, stderrTail: result.stderrTail ?? [] });
    if (iteration < options.maxIterations) report({ kind: 'retry', iteration: iteration + 1 });
  }
  return { kind: 'iteration-limit', limit: options.maxIterations };
}
