import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { claude } from '../dist/agents/claude.js';
import { runSession } from '../dist/session.js';

const main = resolve(import.meta.dirname, '../dist/main.js');

async function withClaude(source, check) {
  const dir = mkdtempSync(join(tmpdir(), 'afk-claude-'));
  const oldPath = process.env.PATH;
  const oldRecord = process.env.AFK_CLAUDE_RECORD;
  writeFileSync(join(dir, 'claude'), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath ?? ''}`;
  process.env.AFK_CLAUDE_RECORD = join(dir, 'record.json');
  try { await check(dir); }
  finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldRecord === undefined) delete process.env.AFK_CLAUDE_RECORD; else process.env.AFK_CLAUDE_RECORD = oldRecord;
    rmSync(dir, { recursive: true, force: true });
  }
}

const session = (cwd, extra = {}) => runSession({ adapter: claude, cwd, prompt: 'Implement task', ...extra }, new AbortController().signal);

test('Claude launches in the workspace with prompt on stdin and optional settings unchanged', async () => {
  await withClaude(`
const fs = require('node:fs');
fs.writeFileSync(process.env.AFK_CLAUDE_RECORD, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), prompt: fs.readFileSync(0, 'utf8') }));
process.stdout.write(JSON.stringify({ result: '{"outcome":"complete"}' }));
`, async (dir) => {
    assert.deepEqual(await session(dir), { kind: 'ok', finalMessage: '{"outcome":"complete"}', stderrTail: [] });
    let call = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.equal(call.cwd, realpathSync(dir));
    assert.deepEqual(call.args, ['-p', '--output-format', 'json', '--permission-mode', 'auto']);
    assert.match(call.prompt, /Use the available code skill/);
    assert.ok(call.prompt.endsWith('Implement task'));
    await session(dir, { model: 'raw-model', reasoningEffort: 'raw-effort' });
    call = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.deepEqual(call.args, ['-p', '--output-format', 'json', '--permission-mode', 'auto', '--model', 'raw-model', '--effort', 'raw-effort']);
  });
});

test('Claude session classifies every process and output error', async () => {
  const cases = [
    ['process.exit(7)', { kind: 'exit-failed', status: 7, stderrTail: [] }],
    ["process.kill(process.pid, 'SIGTERM')", { kind: 'exit-failed', status: null, stderrTail: [] }],
    ["process.stdout.write('not JSON')", { kind: 'invalid-response', reason: 'agent output could not be parsed', stderrTail: [] }],
    ["process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_max_turns' }))", { kind: 'exit-failed', status: 0, reason: 'reported subtype: error_max_turns', stderrTail: [] }],
    ["process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_during_execution' })); process.exit(7)", { kind: 'exit-failed', status: 7, reason: 'reported subtype: error_during_execution', stderrTail: [] }],
    ['', { kind: 'missing-response', stderrTail: [] }],
    ["process.stdout.write(JSON.stringify({ result: '  ' }))", { kind: 'missing-response', stderrTail: [] }],
    ["process.stdout.write(JSON.stringify({ result: 42 }))", { kind: 'missing-response', stderrTail: [] }],
  ];
  for (const [source, expected] of cases) {
    await withClaude(source, async (dir) => assert.deepEqual(await session(dir), expected, source));
  }
  const dir = mkdtempSync(join(tmpdir(), 'afk-claude-missing-'));
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try { assert.equal((await session(dir)).kind, 'launch-failed'); }
  finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

test('Claude protocol outcomes and errors use the existing loop and retry policy', async () => {
  await withClaude(`
const fs = require('node:fs');
const record = process.env.AFK_CLAUDE_RECORD;
const count = Number(fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '0') + 1;
fs.writeFileSync(record, String(count));
const outcome = JSON.parse(process.env.AFK_CLAUDE_OUTCOMES)[Math.min(count - 1, JSON.parse(process.env.AFK_CLAUDE_OUTCOMES).length - 1)];
if (outcome === 'exit') process.exit(7);
if (outcome === 'signal') process.kill(process.pid, 'SIGTERM');
if (outcome === 'timeout') setInterval(() => {}, 1000);
if (outcome === 'invalid-json') process.stdout.write('not JSON');
else if (outcome === 'missing') process.stdout.write('{}');
else if (outcome === 'is-error') process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_max_turns' }));
else if (outcome === 'is-error-exit') { process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_during_execution' })); process.exit(7); }
else process.stdout.write(JSON.stringify({ result: outcome === 'violation' ? 'not protocol' : JSON.stringify(outcome === 'blocked' ? { outcome, blocker_text: 'needs input' } : outcome === 'fail' ? { outcome, failure_summary: 'failed task' } : { outcome }) }));
`, async (dir) => {
    const launch = (outcomes, extra = []) => {
      rmSync(join(dir, 'record.json'), { force: true });
      return spawnSync(process.execPath, [main, '--agent', 'claude', '--max-iterations', '2', ...extra, 'task'], {
        cwd: dir, env: { ...process.env, AFK_CLAUDE_OUTCOMES: JSON.stringify(outcomes) }, input: '', encoding: 'utf8', timeout: 10000,
      });
    };
    for (const [outcome, code, expected] of [
      ['complete', 0, /Feature completed/], ['blocked', 1, /Run blocked: needs input/],
      ['repeat', 1, /Iteration limit reached/], ['fail', 1, /Task failed: failed task/],
    ]) {
      const result = launch([outcome]);
      assert.equal(result.status, code, result.stderr);
      assert.match(result.stderr, expected);
      assert.equal(result.stdout, '');
    }
    for (const error of ['exit', 'signal', 'invalid-json', 'missing', 'is-error', 'is-error-exit', 'violation']) {
      const result = launch([error, 'complete']);
      assert.equal(result.status, 0, `${error}: ${result.stderr}`);
      assert.match(result.stderr, /Execution error:/);
      assert.match(result.stderr, /Retrying with fresh session 2/);
      assert.match(result.stderr, /Feature completed/);
      assert.equal(readFileSync(join(dir, 'record.json'), 'utf8'), '2');
      if (error === 'is-error') assert.match(result.stderr, /error_max_turns/);
      if (error === 'is-error-exit') assert.match(result.stderr, /error_during_execution/);
      if (error === 'violation') assert.match(result.stderr, /code skill protocol violation/);
    }
    const timeout = launch(['timeout'], ['--session-timeout', '0.8']);
    assert.equal(timeout.status, 2, timeout.stderr);
    assert.doesNotMatch(timeout.stderr, /Retrying/);
    assert.equal(readFileSync(join(dir, 'record.json'), 'utf8'), '1');
  });
});

test('Claude launch failure retries once and remains an execution error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-claude-no-bin-'));
  try {
    const result = spawnSync(process.execPath, [main, '--agent', 'claude', '--max-iterations', '2', 'task'], {
      cwd: dir, env: { ...process.env, PATH: dir }, input: '', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /failed to launch agent/);
    assert.match(result.stderr, /Retrying with fresh session 2/);
    assert.match(result.stderr, /Iteration 2\/2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Ctrl+C interrupts Claude without a retry or agent stderr', { timeout: 10000 }, async () => {
  await withClaude(`
const fs = require('node:fs');
fs.writeFileSync(process.env.AFK_CLAUDE_RECORD, String(process.pid));
process.stderr.write('hidden Claude diagnostic\\n');
process.on('SIGINT', () => process.exit(7));
setInterval(() => {}, 1000);
`, async (dir) => {
    const child = spawn(process.execPath, [main, '--agent', 'claude', '--max-iterations', '2', 'task'], {
      cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    for (let attempt = 0; attempt < 200 && !existsSync(join(dir, 'record.json')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(join(dir, 'record.json')));
    child.kill('SIGINT');
    assert.equal(await done, 130, stderr);
    assert.match(stderr, /Interrupted by Ctrl\+C/);
    assert.doesNotMatch(stderr, /Retrying|hidden Claude diagnostic/);
  });
});
