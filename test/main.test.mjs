import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const executable = resolve(import.meta.dirname, '../dist/main.js');

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'afk-main-'));
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(bin);
  mkdirSync(home);
  const invocations = join(root, 'invocations');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = process.env.AFK_CALLS;
const count = Number(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '0') + 1;
fs.writeFileSync(calls, String(count));
fs.writeFileSync(process.env.AFK_ARGS, JSON.stringify({ args, cwd: process.cwd(), prompt: fs.readFileSync(0, 'utf8') }));
for (const line of JSON.parse(process.env.AFK_STDERR_LINES || '["agent diagnostic"]')) process.stderr.write(line + '\\n');
const outcomes = JSON.parse(process.env.AFK_OUTCOMES || '["complete"]');
const outcome = outcomes[Math.min(count - 1, outcomes.length - 1)];
if (outcome === 'exit') process.exit(7);
if (outcome === 'timeout') setInterval(() => {}, 1000);
else {
  if (outcome !== 'missing') process.stdout.write(outcome === 'invalid' ? 'not JSON' : JSON.stringify(outcome === 'blocked' ? { outcome, blocker_text: 'needs credentials' } : outcome === 'fail' ? { outcome, failure_summary: 'test failed' } : { outcome }));
}
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AFK_CALLS: invocations, AFK_ARGS: join(root, 'args') };
  const launch = (args, options = {}) => spawnSync(process.execPath, [executable, ...args], {
    cwd: workspace, env: { ...env, ...options.env }, input: options.input,
    encoding: 'utf8', timeout: 10000,
  });
  try { run({ root, workspace, home, invocations, env, launch }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('each prompt source launches Codex with the selected workspace and original prompt', () => fixture(({ root, workspace, launch }) => {
  const promptFile = join(root, 'prompt.txt');
  writeFileSync(promptFile, 'From file\n');
  for (const [args, input, expected] of [
    [['From argument'], undefined, 'From argument'],
    [['--prompt-file', promptFile], undefined, 'From file\n'],
    [[], 'From stdin\n', 'From stdin\n'],
  ]) {
    const result = launch(args, { input });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[afk\] Feature completed/);
    const call = JSON.parse(readFileSync(join(root, 'args'), 'utf8'));
    assert.equal(call.cwd, realpathSync(workspace));
    assert.ok(call.prompt.endsWith(expected));
  }
}));

test('input and option errors and help never launch Codex', () => fixture(({ invocations, launch }) => {
  const errors = [
    [[], undefined, /missing prompt/i],
    [['one'], 'two', /multiple prompt sources/i],
    [[], '  \n', /empty prompt/i],
    [['--prompt-file', 'absent'], undefined, /cannot read prompt file/i],
    [['--max-iterations', '0', 'prompt'], undefined, /positive integer/i],
  ];
  for (const [args, input, message] of errors) {
    const result = launch(args, { input });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
  }
  for (const help of ['--help', '-h']) {
    const result = launch(['--agent', 'unsupported', '--max-iterations', '0', help], { input: 'ignored' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: afk/);
    for (const code of ['0', '1', '2', '130']) assert.match(result.stdout, new RegExp(`\\b${code}\\b`));
    assert.equal(result.stderr, '');
  }
  assert.equal(readdirSync(join(invocations, '..')).includes('invocations'), false);
}));

test('invalid agent names exit with usage code and launch no session', () => fixture(({ invocations, launch }) => {
  for (const args of [['--agent', 'unknown', 'prompt'], ['--agent', '', 'prompt'], ['--agent=', 'prompt'], ['--agent']]) {
    const result = launch(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /codex/);
    assert.equal(result.stdout, '');
    assert.equal(readdirSync(join(invocations, '..')).includes('invocations'), false);
  }
}));

test('explicit Codex selection and retries keep the selected adapter and raw settings', () => fixture(({ root, launch, invocations }) => {
  const result = launch(['--agent', 'codex', '--model', 'custom-model', '--reasoning-effort', 'custom-effort', '--max-iterations', '2', 'prompt'],
    { env: { AFK_OUTCOMES: '["exit","complete"]' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(invocations, 'utf8'), '2');
  const call = JSON.parse(readFileSync(join(root, 'args'), 'utf8'));
  assert.deepEqual(call.args, ['exec', '--approve-for-me', '--model', 'custom-model', '-c', 'model_reasoning_effort="custom-effort"', '-']);
}));

test('all final outcomes report a clear status and consistent exit code', () => fixture(({ launch }) => {
  const cases = [
    ['complete', 0, 1, /feature completed/i],
    ['blocked', 1, 1, /blocked.*needs credentials/is],
    ['exit', 1, 2, /execution error.*exit.*7/is],
    ['missing', 1, 2, /execution error.*without a final response/is],
    ['invalid', 1, 2, /execution error.*invalid/is],
    ['repeat', 1, 1, /iteration limit.*1/is],
    ['fail', 1, 1, /iteration limit.*1/is],
    ['timeout', 2, 1, /timed out after 0\.05/is],
  ];
  for (const [outcome, code, limit, message] of cases) {
    const args = ['--max-iterations', String(limit)];
    if (outcome === 'timeout') args.push('--session-timeout', '0.05');
    const result = launch([...args, 'prompt'], { env: { AFK_OUTCOMES: JSON.stringify([outcome]) } });
    assert.equal(result.status, code, `${outcome}: ${result.stderr}`);
    assert.match(result.stderr, message, outcome);
    assert.equal(result.stdout, '', outcome);
    assert.doesNotMatch(result.stdout, /agent diagnostic/, outcome);
    assert.doesNotMatch(result.stdout, /\{"outcome":/, outcome);
    assert.match(result.stderr, /^\[afk\] Iteration 1\/\d+: starting agent session/m, outcome);
    if (outcome === 'fail') assert.match(result.stderr, /\[afk\] Task failed: test failed/);
    if (['exit', 'missing', 'invalid'].includes(outcome)) assert.match(result.stderr, /\[afk\] Retrying with fresh session 2/);
    if (!['exit', 'missing', 'invalid'].includes(outcome)) assert.doesNotMatch(result.stderr, /agent diagnostic/, outcome);
  }
}));

test('a Codex launch failure is reported after one retry', () => fixture(({ launch, workspace }) => {
  const result = spawnSync(process.execPath, [executable, '--max-iterations', '2', 'prompt'], {
    cwd: workspace, env: { ...process.env, PATH: '/nonexistent' }, input: '', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Execution error: failed to launch agent/);
  assert.match(result.stderr, /Retrying with fresh session 2/);
  assert.doesNotMatch(result.stderr, /codex/i);
}));

test('execution errors show only the last 20 agent stderr lines after each error', () => fixture(({ launch }) => {
  const lines = Array.from({ length: 25 }, (_, index) => `diagnostic ${index + 1}`);
  const result = launch(['--max-iterations', '2', 'prompt'], { env: { AFK_OUTCOMES: '["exit"]', AFK_STDERR_LINES: JSON.stringify(lines) } });
  assert.equal(result.status, 1, result.stderr);
  const expectedTail = lines.slice(-20).join('\n') + '\n';
  assert.equal(result.stderr.split(expectedTail).length - 1, 2);
  assert.doesNotMatch(result.stderr, /diagnostic [1-5]\n/);
  assert.match(result.stderr, /\[afk\] Execution error: agent exited unsuccessfully with exit code 7\n/);
  assert.match(result.stderr, /\[afk\] Retrying with fresh session 2/);
  assert.doesNotMatch(result.stderr, /Codex|afk:/);
}));

test('the same session results report identical stderr, final status, and exit code for different adapters', () => fixture(({ root, workspace, env, launch }) => {
  copyFileSync(join(root, 'bin', 'codex'), join(root, 'bin', 'other'));
  const preload = join(root, 'register-other.mjs');
  const registry = pathToFileURL(resolve(import.meta.dirname, '../dist/agents/registry.js')).href;
  writeFileSync(preload, `import { adapters } from ${JSON.stringify(registry)};
adapters.set('other', { name: 'other', executable: 'other', buildArgs: () => [], extractFinalMessage: stdout => stdout.trim() ? { kind: 'message', text: stdout.trim() } : { kind: 'missing' } });\n`);
  const outcomes = { AFK_OUTCOMES: '["exit","blocked"]', AFK_STDERR_LINES: '["detail"]' };
  const codexRun = launch(['--agent', 'codex', '--max-iterations', '2', 'prompt'], { env: outcomes });
  writeFileSync(join(root, 'invocations'), '0');
  const otherRun = spawnSync(process.execPath, ['--import', preload, executable, '--agent', 'other', '--max-iterations', '2', 'prompt'], {
    cwd: workspace, env: { ...env, ...outcomes }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(codexRun.status, 1, codexRun.stderr);
  assert.equal(otherRun.status, codexRun.status, otherRun.stderr);
  assert.equal(otherRun.stdout, codexRun.stdout);
  assert.equal(otherRun.stderr, codexRun.stderr);
  assert.match(otherRun.stderr, /\[afk\] Run blocked: needs credentials/);
}));

test('a run leaves the Git workspace and home unchanged', () => fixture(({ workspace, home, launch }) => {
  const git = (...args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  writeFileSync(join(workspace, 'existing.txt'), 'existing work');
  const before = {
    branch: git('symbolic-ref', 'HEAD').stdout,
    worktrees: git('worktree', 'list', '--porcelain').stdout,
    files: readdirSync(workspace).sort(),
    home: readdirSync(home),
  };
  const result = launch(['prompt']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('symbolic-ref', 'HEAD').stdout, before.branch);
  assert.equal(git('worktree', 'list', '--porcelain').stdout, before.worktrees);
  assert.deepEqual(readdirSync(workspace).sort(), before.files);
  assert.deepEqual(readdirSync(home), before.home);
  assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), 'existing work');
}));

test('agent output stays hidden while Codex runs', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'afk-live-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
process.stderr.write('working now\\n');
setTimeout(() => {
  process.stdout.write('{"outcome":"complete"}');
  process.exit(0);
}, 500);
`, { mode: 0o755 });
  try {
    const child = spawn(process.execPath, [executable, 'prompt'], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let sawActivityBeforeExit = false;
    let stderr = '';
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('working now') && child.exitCode === null) sawActivityBeforeExit = true;
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(status, 0);
    assert.equal(sawActivityBeforeExit, false);
    assert.doesNotMatch(stderr, /working now/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
