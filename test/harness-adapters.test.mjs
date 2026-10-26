import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { adapters } from '../dist/agents/registry.js';

const main = resolve(import.meta.dirname, '../dist/main.js');
const fixtureDirectory = resolve(import.meta.dirname, '../fixtures/agents');

async function withAgent(adapter, check) {
  const root = mkdtempSync(join(tmpdir(), 'afk-harness-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fixture = join(fixtureDirectory, `${adapter.name}.cjs`);
  assert.ok(existsSync(fixture), `missing fake executable fixture for registered agent ${adapter.name}`);
  const executable = join(bin, adapter.executable);
  copyFileSync(fixture, executable);
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AFK_COUNT: join(root, 'count'), AFK_READY: join(root, 'ready') };
  const run = (scenarios, args = []) => {
    rmSync(env.AFK_COUNT, { force: true });
    return spawnSync(process.execPath, [main, '--agent', adapter.name, '--max-iterations', '3', ...args, 'task'], {
      cwd: root, env: { ...env, AFK_SCENARIOS: JSON.stringify(scenarios) }, encoding: 'utf8', timeout: 10000,
    });
  };
  try { return await check({ root, env, run }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('every registered agent has a fake executable fixture', () => {
  for (const adapter of adapters.values()) {
    assert.ok(existsSync(join(fixtureDirectory, `${adapter.name}.cjs`)), adapter.name);
  }
});

for (const adapter of adapters.values()) {
  test(`${adapter.name}: protocol outcomes use identical status wording and exit codes`, () => withAgent(adapter, ({ run }) => {
    for (const [scenario, code, lines] of [
      ['complete', 0, ['[afk] Iteration 1/3: starting agent session', '[afk] Feature completed']],
      ['blocked', 1, ['[afk] Iteration 1/3: starting agent session', '[afk] Run blocked: needs input']],
      ['repeat', 1, ['[afk] Iteration 1/1: starting agent session', '[afk] Iteration limit reached (1) without reported completion']],
      ['fail', 1, ['[afk] Iteration 1/1: starting agent session', '[afk] Task failed: failed task', '[afk] Iteration limit reached (1) without reported completion']],
    ]) {
      const result = run([scenario], scenario === 'repeat' || scenario === 'fail' ? ['--max-iterations', '1'] : []);
      assert.equal(result.status, code, result.stderr);
      assert.match(result.stdout, new RegExp(scenario));
      assert.deepEqual(result.stderr.trimEnd().split('\n'), lines);
    }
  }));

  test(`${adapter.name}: execution errors retry once and stream diagnostics once`, () => withAgent(adapter, ({ run, env, root }) => {
    const diagnostics = Array.from({ length: 25 }, (_, index) => `detail ${index + 1}`);
    const result = spawnSync(process.execPath, [main, '--agent', adapter.name, '--max-iterations', '3', 'task'], {
      cwd: root,
      env: { ...env, AFK_SCENARIOS: JSON.stringify(['exit', 'blocked']), AFK_DIAGNOSTICS: JSON.stringify(diagnostics) },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /blocked/);
    assert.deepEqual(result.stderr.trimEnd().split('\n'), [
      '[afk] Iteration 1/3: starting agent session',
      ...diagnostics,
      '[afk] Execution error: agent exited unsuccessfully with exit code 7',
      '[afk] Retrying with fresh session 2',
      '[afk] Iteration 2/3: starting agent session',
      ...diagnostics,
      '[afk] Run blocked: needs input',
    ]);
    const exhausted = run(['missing', 'missing']);
    assert.equal(exhausted.status, 1, exhausted.stderr);
    assert.match(exhausted.stderr, /Retrying with fresh session 2/);
    assert.equal((exhausted.stderr.match(/exited without a final response/g) ?? []).length, 2);
    assert.doesNotMatch(exhausted.stderr, /Retrying with fresh session 3/);
    const recovered = run(['violation', 'complete']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(env.AFK_COUNT, 'utf8'), '2');
    assert.deepEqual(recovered.stderr.trimEnd().split('\n'), [
      '[afk] Iteration 1/3: starting agent session',
      '[afk] Execution error: agent final response is invalid: protocol violation',
      '[afk] Retrying with fresh session 2',
      '[afk] Iteration 2/3: starting agent session',
      '[afk] Feature completed',
    ]);
  }));

  test(`${adapter.name}: timeout stops without a retry after streaming agent stderr`, () => withAgent(adapter, ({ run }) => {
    const result = run(['hang'], ['--session-timeout', '0.8']);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(result.stderr.trimEnd().split('\n'), [
      '[afk] Iteration 1/3: starting agent session',
      'hidden diagnostic',
      '[afk] agent session timed out after 0.8 seconds',
    ]);
  }));

  test(`${adapter.name}: interruption stops without a retry after streaming agent stderr`, { timeout: 10000 }, async () => {
    await withAgent(adapter, async ({ env, root }) => {
      const child = spawn(process.execPath, [main, '--agent', adapter.name, '--max-iterations', '3', 'task'], {
        cwd: root, env: { ...env, AFK_SCENARIOS: '["hang"]' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.on('data', chunk => { stdout += chunk; });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code));
      });
      for (let attempt = 0; attempt < 200 && !existsSync(env.AFK_READY); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(existsSync(env.AFK_READY), 'fixture did not start');
      child.kill('SIGINT');
      assert.equal(await done, 130, stderr);
      assert.equal(stdout, '');
      assert.deepEqual(stderr.trimEnd().split('\n'), [
        '[afk] Iteration 1/3: starting agent session',
        'hidden diagnostic',
        '[afk] Interrupted by Ctrl+C',
      ]);
      assert.equal(readFileSync(env.AFK_COUNT, 'utf8'), '1');
    });
  });
}

test('the same scenario reports identical output and exit code for every registered agent', async () => {
  const results = [];
  for (const adapter of adapters.values()) {
    results.push(await withAgent(adapter, ({ run }) => {
      const result = run(['violation', 'blocked']);
      assert.match(result.stdout, /blocked/);
      return { status: result.status, stderr: result.stderr };
    }));
  }
  assert.ok(results.length > 1, 'comparison requires at least two registered adapters');
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
});
