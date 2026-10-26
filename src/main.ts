#!/usr/bin/env node

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: afk [options] [prompt]\n');
} else {
  process.stderr.write('afk: CLI invocation is not implemented yet\n');
  process.exitCode = 1;
}
