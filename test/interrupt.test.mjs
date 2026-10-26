import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const executable = resolve(import.meta.dirname, '../dist/main.js');

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function launch(args, env) {
  const child = spawn(process.execPath, [executable, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output: output.join('') }));
  });
  return { child, done };
}

test('Ctrl+C interrupts active Codex, stops retries, preserves workspace, and a new run gets a fresh budget', { timeout: 15000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'afk-interrupt-'));
  const workspace = join(fixture, 'workspace');
  const bin = join(fixture, 'bin');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workspace);
  mkdirSync(bin);
  writeFileSync(join(workspace, 'existing.txt'), 'keep this work');
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!/usr/bin/env node
const fs = require('node:fs');
const countPath = process.env.AFK_COUNT;
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;
fs.writeFileSync(countPath, String(count));
if (process.env.AFK_FINISH === 'yes') {
  process.stdout.write(count === 2 ? '{"outcome":"repeat"}' : '{"outcome":"complete"}');
  process.exit(0);
}
process.stderr.write('interrupted agent detail\\n');
process.on('SIGINT', () => {
  fs.writeFileSync(process.env.AFK_SIGNAL, 'SIGINT');
  process.exit(7);
});
fs.writeFileSync(process.env.AFK_READY, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const count = join(fixture, 'count');
  const ready = join(fixture, 'ready');
  const signal = join(fixture, 'signal');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AFK_COUNT: count, AFK_READY: ready, AFK_SIGNAL: signal };
  try {
    const first = launch(['--cwd', workspace, '--max-iterations', '3', 'Original prompt'], env);
    await waitForFile(ready);
    const codexPid = Number(readFileSync(ready, 'utf8'));
    const interruptedAt = Date.now();
    first.child.kill('SIGINT');
    const result = await first.done;
    assert.ok(Date.now() - interruptedAt < 3000, 'interruption should not wait for the fake task');
    assert.equal(result.code, 130, result.output);
    assert.match(result.output, /interrupt/i);
    assert.match(result.output, /interrupted agent detail/);
    assert.equal(readFileSync(signal, 'utf8'), 'SIGINT');
    assert.throws(() => process.kill(codexPid, 0), /ESRCH/);
    assert.equal(readFileSync(count, 'utf8'), '1');
    assert.deepEqual(readdirSync(workspace), ['existing.txt']);
    assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), 'keep this work');

    const second = launch(['--cwd', workspace, '--max-iterations', '2', 'Original prompt'], { ...env, AFK_FINISH: 'yes' });
    const resumed = await second.done;
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(readFileSync(count, 'utf8'), '3');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
