#!/usr/bin/env node
import { parseInvocation } from './cli.js';
import { runLoop } from './run.js';
import type { ExecutionError, RunEvent } from './run.js';
import { runSession } from './session.js';

function describeError(error: ExecutionError): string {
  switch (error.kind) {
    case 'launch-failed': return `Codex launch failed: ${error.message}`;
    case 'exit-failed': return `Codex exited unsuccessfully with status ${error.status ?? 'unknown'}`;
    case 'missing-response': return 'final response is missing';
    case 'invalid-response': return 'final response is invalid';
  }
}

function report(event: RunEvent): void {
  switch (event.kind) {
    case 'iteration-start':
      process.stderr.write(`afk: starting iteration ${event.iteration}/${event.limit}\n`);
      break;
    case 'execution-error':
      process.stderr.write(`afk: execution error: ${describeError(event.error)}\n`);
      break;
    case 'retry':
      process.stderr.write(`afk: retrying with fresh session ${event.iteration}\n`);
      break;
    case 'fail':
      process.stderr.write(`afk: task failed: ${event.summary}\n`);
      break;
  }
}

const args = process.argv.slice(2);
let stdin: string | null = null;
if (!args.includes('--help') && !args.includes('-h') && !process.stdin.isTTY) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks).toString('utf8');
  if (input.length > 0) stdin = input;
}
const invocation = parseInvocation(args, stdin, process.cwd());
if (invocation.kind === 'help') {
  process.stdout.write(invocation.text);
} else if (invocation.kind === 'error') {
  process.stderr.write(`afk: ${invocation.message}\n`);
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  try {
    const status = await runLoop(invocation.options, runSession, report, controller.signal);
    if (status.kind === 'interrupted') {
      process.stderr.write('afk: interrupted by Ctrl+C\n');
      process.exitCode = 130;
    } else if (status.kind === 'completed') {
      process.stdout.write('afk: feature completed\n');
    } else {
      switch (status.kind) {
        case 'blocked': process.stderr.write(`afk: blocked: ${status.blockerText}\n`); break;
        case 'execution-error': process.stderr.write(`afk: execution error: ${describeError(status.error)}\n`); break;
        case 'iteration-limit': process.stderr.write(`afk: iteration limit reached (${status.limit}) without reported completion\n`); break;
        case 'timeout': process.stderr.write(`afk: session timeout after ${status.duration} seconds\n`); break;
      }
      process.exitCode = status.kind === 'timeout' ? 2 : 1;
    }
  } finally {
    process.off('SIGINT', interrupt);
  }
}
