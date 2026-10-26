#!/usr/bin/env node
import { parseInvocation } from './cli.js';
import { runLoop } from './run.js';
import { runSession } from './session.js';

const invocation = parseInvocation(process.argv.slice(2), null, process.cwd());
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
    const status = await runLoop(invocation.options, runSession, () => {}, controller.signal);
    if (status.kind === 'interrupted') {
      process.stderr.write('afk: interrupted by Ctrl+C\n');
      process.exitCode = 130;
    } else if (status.kind === 'completed') {
      process.stdout.write('afk: feature completed\n');
    } else {
      process.stderr.write(`afk: ${status.kind}\n`);
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', interrupt);
  }
}
