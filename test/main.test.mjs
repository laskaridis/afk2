import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
process.stderr.write('agent diagnostic\\n');
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
    assert.match(result.stdout, /feature completed/i);
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
    const result = launch(['--max-iterations', '0', help], { input: 'ignored' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: afk/);
    for (const code of ['0', '1', '2', '130']) assert.match(result.stdout, new RegExp(`\\b${code}\\b`));
    assert.equal(result.stderr, '');
  }
  assert.equal(readdirSync(join(invocations, '..')).includes('invocations'), false);
}));

test('all final outcomes report a clear status and consistent exit code', () => fixture(({ launch }) => {
  const cases = [
    ['complete', 0, 1, /feature completed/i],
    ['blocked', 1, 1, /blocked.*needs credentials/is],
    ['exit', 1, 2, /execution error.*exit.*7/is],
    ['missing', 1, 2, /execution error.*missing/is],
    ['invalid', 1, 2, /execution error.*invalid/is],
    ['repeat', 1, 1, /iteration limit.*1/is],
    ['fail', 1, 1, /iteration limit.*1/is],
    ['timeout', 2, 1, /timeout.*0\.05/is],
  ];
  for (const [outcome, code, limit, message] of cases) {
    const args = ['--max-iterations', String(limit)];
    if (outcome === 'timeout') args.push('--session-timeout', '0.05');
    const result = launch([...args, 'prompt'], { env: { AFK_OUTCOMES: JSON.stringify([outcome]) } });
    assert.equal(result.status, code, `${outcome}: ${result.stderr}`);
    assert.match(result.stdout + result.stderr, message, outcome);
    assert.doesNotMatch(result.stdout, /agent diagnostic/, outcome);
    assert.doesNotMatch(result.stdout, /\{"outcome":/, outcome);
    assert.doesNotMatch(result.stderr, /agent diagnostic/, outcome);
    assert.match(result.stderr, /starting iteration 1/, outcome);
    if (outcome === 'fail') assert.match(result.stderr, /task failed: test failed/);
    if (['exit', 'missing', 'invalid'].includes(outcome)) assert.match(result.stderr, /retrying with fresh session 2/);
  }
}));

test('a Codex launch failure is reported after one retry', () => fixture(({ launch, workspace }) => {
  const result = spawnSync(process.execPath, [executable, '--max-iterations', '2', 'prompt'], {
    cwd: workspace, env: { ...process.env, PATH: '/nonexistent' }, input: '', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /execution error.*launch failed/is);
  assert.match(result.stderr, /retrying with fresh session 2/);
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
