#!/usr/bin/env node
import { missingPromptMessage, parseInvocation } from './cli.js';
import { runLoop } from './run.js';
import type { ExecutionError, RunEvent } from './run.js';
import { runSession } from './session.js';

function describeError(error: ExecutionError): string {
  switch (error.kind) {
    case 'launch-failed': return `failed to launch agent: ${error.message}`;
    case 'exit-failed': return `${error.status === null ? 'agent exited unsuccessfully with signal' : `agent exited unsuccessfully with exit code ${error.status}`}${error.reason ? `: ${error.reason}` : ''}`;
    case 'missing-response': return 'agent exited without a final response';
    case 'invalid-response': return `agent final response is invalid: ${error.reason}`;
  }
}

function reportExecutionError(error: ExecutionError): void {
  process.stderr.write(`[afk] Execution error: ${describeError(error)}\n`);
}

function report(event: RunEvent): void {
  switch (event.kind) {
    case 'iteration-start':
      process.stderr.write(`[afk] Iteration ${event.iteration}/${event.limit}: starting agent session\n`);
      break;
    case 'agent-output':
      (event.stream === 'stdout' ? process.stdout : process.stderr).write(event.chunk);
      break;
    case 'execution-error':
      reportExecutionError(event.error);
      break;
    case 'retry':
      process.stderr.write(`[afk] Retrying with fresh session ${event.iteration}\n`);
      break;
    case 'fail':
      process.stderr.write(`[afk] Task failed: ${event.summary}\n`);
      break;
  }
}

const args = process.argv.slice(2);
/** Read piped stdin to EOF, or with `graceMs` give up on a pipe that stays silent and open. */
function readStdin(graceMs?: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      const input = Buffer.concat(chunks).toString('utf8');
      resolve(input.length > 0 ? input : null);
    };
    const timer = graceMs === undefined ? undefined : setTimeout(finish, graceMs);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// A prompt given by argument or file must not block on a pipe that never closes.
let invocation = parseInvocation(args, null, process.cwd());
if (invocation.kind !== 'help' && !process.stdin.isTTY) {
  const missing = invocation.kind === 'error' && invocation.message === missingPromptMessage;
  const stdin = await readStdin(missing ? undefined : 200);
  if (stdin !== null) invocation = parseInvocation(args, stdin, process.cwd());
}
if (invocation.kind === 'help') {
  process.stdout.write(invocation.text);
} else if (invocation.kind === 'error') {
  process.stderr.write(`[afk] ${invocation.message}\n`);
  process.exitCode = invocation.category === 'option' ? 2 : 1;
} else {
  const controller = new AbortController();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let received: (typeof signals)[number] | undefined;
  const handlers = signals.map((name) => {
    const handler = () => { received ??= name; controller.abort(); };
    process.on(name, handler);
    return [name, handler] as const;
  });
  try {
    const status = await runLoop(invocation.options, runSession, report, controller.signal);
    if (status.kind === 'interrupted') {
      process.stderr.write(received === 'SIGTERM' || received === 'SIGHUP' ? `[afk] Interrupted by ${received}\n` : '[afk] Interrupted by Ctrl+C\n');
      process.exitCode = received === 'SIGTERM' ? 143 : received === 'SIGHUP' ? 129 : 130;
    } else if (status.kind === 'completed') {
      process.stderr.write('[afk] Feature completed\n');
    } else {
      switch (status.kind) {
        case 'blocked': process.stderr.write(`[afk] Run blocked: ${status.blockerText}\n`); break;
        case 'execution-error': reportExecutionError(status.error); break;
        case 'iteration-limit': process.stderr.write(`[afk] Iteration limit reached (${status.limit}) without reported completion\n`); break;
        case 'timeout': process.stderr.write(`[afk] agent session timed out after ${status.duration} seconds\n`); break;
      }
      process.exitCode = status.kind === 'timeout' ? 2 : 1;
    }
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}
