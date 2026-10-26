import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSession } from '../dist/session.js';

async function withFake(source, check) {
  const dir = mkdtempSync(join(tmpdir(), 'afk-session-'));
  const oldPath = process.env.PATH;
  const oldRecord = process.env.AFK_FAKE_RECORD;
  const fake = join(dir, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath ?? ''}`;
  process.env.AFK_FAKE_RECORD = join(dir, 'record.json');
  try { await check(dir); }
  finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldRecord === undefined) delete process.env.AFK_FAKE_RECORD; else process.env.AFK_FAKE_RECORD = oldRecord;
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = (cwd, extras = {}) => ({ prompt: 'Original task prompt', cwd, ...extras });
const recordAndRespond = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.AFK_FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), prompt: Buffer.concat(chunks).toString() }));
  const path = args[args.indexOf('--output-last-message') + 1];
  fs.writeFileSync(path, '{"outcome":"complete"}');
  process.stdout.write('live stdout\\n');
  process.stderr.write('live stderr\\n');
});`;

test('launches fresh Codex in the workspace with skill instructions and only supplied overrides', async () => {
  await withFake(recordAndRespond, async (dir) => {
    const activity = [];
    const result = await runSession(config(dir), new AbortController().signal, (stream, chunk) => activity.push([stream, chunk.toString()]));
    assert.deepEqual(result, { kind: 'ok', finalMessage: '{"outcome":"complete"}' });
    const { args, cwd, prompt } = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.equal(cwd, realpathSync(dir));
    assert.deepEqual(args.slice(0, 2), ['exec', '--approve-for-me']);
    assert.equal(args.at(-1), '-');
    assert.ok(args.includes('--output-last-message'));
    assert.ok(!args.some(arg => ['resume', 'fork', '--model', '-c', '--config', '--worktree'].includes(arg)));
    assert.match(prompt, /Use the available code skill for this iteration/);
    assert.match(prompt, /one task|single task/i);
    assert.match(prompt, /response protocol/i);
    assert.ok(prompt.endsWith('Original task prompt'));
    assert.deepEqual(activity, [['stdout', 'live stdout\n'], ['stderr', 'live stderr\n']]);
    assert.equal(existsSync(args[args.indexOf('--output-last-message') + 1]), false);
  });
  await withFake(recordAndRespond, async (dir) => {
    await runSession(config(dir, { model: 'chosen', reasoningEffort: 'high' }), new AbortController().signal, () => {});
    const { args } = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'chosen']);
    assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort="high"']);
  });
});

test('forwards output before exit and takes the final message only from the dedicated file', async () => {
  await withFake(`
const fs = require('node:fs');
const args = process.argv.slice(2);
process.stdout.write('{"outcome":"repeat"}\\n');
process.stderr.write('working\\n');
setTimeout(() => { fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"outcome":"complete"}'); process.exit(0); }, 150);
`, async (dir) => {
    let settled = false;
    let live = false;
    const pending = runSession(config(dir), new AbortController().signal, (stream, chunk) => {
      if (stream === 'stdout' && chunk.toString().includes('repeat')) live = !settled;
    }).then(value => { settled = true; return value; });
    const result = await pending;
    assert.equal(live, true);
    assert.deepEqual(result, { kind: 'ok', finalMessage: '{"outcome":"complete"}' });
  });
});

test('reports missing final message and unsuccessful exit separately', async () => {
  await withFake(`process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`, async (dir) => {
    assert.deepEqual(await runSession(config(dir), new AbortController().signal, () => {}), { kind: 'ok', finalMessage: '' });
  });
  await withFake(`
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(process.env.AFK_FAKE_RECORD, path);
fs.writeFileSync(path, '{"outcome":"complete"}');
process.exit(7);
`, async (dir) => {
    assert.deepEqual(await runSession(config(dir), new AbortController().signal, () => {}), { kind: 'exit-failed', status: 7 });
    assert.equal(existsSync(readFileSync(join(dir, 'record.json'), 'utf8')), false);
  });
});

test('reports a launch failure without leaving a temporary response file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-missing-'));
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const result = await runSession(config(dir), new AbortController().signal, () => {});
    assert.equal(result.kind, 'launch-failed');
    assert.deepEqual((await import('node:fs')).readdirSync(dir), []);
  } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

test('times out and terminates a hung session, while no timeout permits completion', async () => {
  await withFake(`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.AFK_FAKE_RECORD, String(process.pid));
process.on('SIGINT', () => { fs.writeFileSync(process.env.AFK_FAKE_RECORD + '.signal', 'SIGINT'); process.exit(0); });
setTimeout(() => { fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"outcome":"complete"}'); process.exit(0); }, 1500);
`, async (dir) => {
    const timed = await runSession(config(dir, { sessionTimeout: 0.8 }), new AbortController().signal, () => {});
    assert.deepEqual(timed, { kind: 'timed-out' });
    assert.equal(readFileSync(join(dir, 'record.json.signal'), 'utf8'), 'SIGINT');
    const pid = Number(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const normal = await runSession(config(dir), new AbortController().signal, () => {});
    assert.deepEqual(normal, { kind: 'ok', finalMessage: '{"outcome":"complete"}' });
  });
});

test('abort interrupts and terminates the managed process', async () => {
  await withFake(`
const fs = require('node:fs');
fs.writeFileSync(process.env.AFK_FAKE_RECORD, String(process.pid));
process.on('SIGINT', () => { fs.writeFileSync(process.env.AFK_FAKE_RECORD + '.signal', 'SIGINT'); process.exit(0); });
setInterval(() => {}, 1000);
`, async (dir) => {
    const controller = new AbortController();
    const pending = runSession(config(dir), controller.signal, () => {});
    while (!existsSync(join(dir, 'record.json'))) await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    assert.deepEqual(await pending, { kind: 'aborted' });
    assert.equal(readFileSync(join(dir, 'record.json.signal'), 'utf8'), 'SIGINT');
    assert.throws(() => process.kill(Number(readFileSync(join(dir, 'record.json'), 'utf8')), 0), /ESRCH/);
  });
});

test('an already aborted signal starts no session', async () => {
  await withFake(recordAndRespond, async (dir) => {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await runSession(config(dir), controller.signal, () => {}), { kind: 'aborted' });
    assert.equal(existsSync(join(dir, 'record.json')), false);
  });
});
