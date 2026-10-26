import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSession } from '../dist/session.js';
import { codex } from '../dist/agents/codex.js';

async function withFake(source, check) {
  const dir = mkdtempSync(join(tmpdir(), 'afk-session-'));
  const oldPath = process.env.PATH;
  const oldRecord = process.env.AFK_FAKE_RECORD;
  writeFileSync(join(dir, 'codex'), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath ?? ''}`;
  process.env.AFK_FAKE_RECORD = join(dir, 'record.json');
  try { await check(dir); }
  finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldRecord === undefined) delete process.env.AFK_FAKE_RECORD; else process.env.AFK_FAKE_RECORD = oldRecord;
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = (cwd, extras = {}) => ({ adapter: codex, prompt: 'Original task prompt', cwd, ...extras });
const recordAndRespond = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.AFK_FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), prompt: Buffer.concat(chunks).toString() }));
  process.stdout.write('{"outcome":"complete"}\\n');
  process.stderr.write('diagnostic\\n');
});`;

test('launches Codex in the workspace with the prompt and only supplied overrides', async () => {
  await withFake(recordAndRespond, async (dir) => {
    const result = await runSession(config(dir), new AbortController().signal);
    assert.deepEqual(result, { kind: 'ok', finalMessage: '{"outcome":"complete"}\n', stderrTail: ['diagnostic'] });
    const { args, cwd, prompt } = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.equal(cwd, realpathSync(dir));
    assert.deepEqual(args, ['exec', '--approve-for-me', '-']);
    assert.match(prompt, /Use the available code skill for this iteration/);
    assert.ok(prompt.endsWith('Original task prompt'));
    assert.deepEqual(readdirSync(dir).sort(), ['codex', 'record.json']);
  });
  await withFake(recordAndRespond, async (dir) => {
    await runSession(config(dir, { model: 'chosen', reasoningEffort: 'high' }), new AbortController().signal);
    const { args } = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.deepEqual(args, ['exec', '--approve-for-me', '--model', 'chosen', '-c', 'model_reasoning_effort="high"', '-']);
  });
});

test('captures output silently until exit and uses stdout as final message', async () => {
  await withFake(`
process.stdout.write('{"outcome":"complete"}\\n');
process.stderr.write('working\\n');
setTimeout(() => process.exit(0), 150);
`, async (dir) => {
    const result = await runSession(config(dir), new AbortController().signal);
    assert.deepEqual(result, { kind: 'ok', finalMessage: '{"outcome":"complete"}\n', stderrTail: ['working'] });
  });
});

test('keeps only the final 20 stderr lines in original order', async () => {
  await withFake(`
process.stderr.write(Array.from({ length: 25 }, (_, i) => 'line ' + i).join('\\n') + '\\n');
process.stdout.write('{"outcome":"complete"}');
`, async (dir) => {
    const result = await runSession(config(dir), new AbortController().signal);
    assert.deepEqual(result.stderrTail, Array.from({ length: 20 }, (_, i) => `line ${i + 5}`));
  });
});

test('preserves a UTF-8 character split across stderr chunks', async () => {
  await withFake(`
const bytes = Buffer.from('before € after\\n');
process.stderr.write(bytes.subarray(0, 8));
setTimeout(() => {
  process.stderr.write(bytes.subarray(8));
  process.stdout.write('{"outcome":"complete"}');
}, 30);
`, async (dir) => {
    const result = await runSession(config(dir), new AbortController().signal);
    assert.deepEqual(result.stderrTail, ['before € after']);
  });
});

test('reports empty or whitespace stdout as missing and unsuccessful exit separately', async () => {
  for (const output of ['', ' \n\t']) {
    await withFake(`process.stdout.write(${JSON.stringify(output)});`, async (dir) => {
      assert.deepEqual(await runSession(config(dir), new AbortController().signal), { kind: 'missing-response', stderrTail: [] });
    });
  }
  await withFake(`process.stdout.write('{"outcome":"complete"}'); process.exit(7);`, async (dir) => {
    assert.deepEqual(await runSession(config(dir), new AbortController().signal), { kind: 'exit-failed', status: 7, stderrTail: [] });
  });
});

test('reports a launch failure without creating a temporary response file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-missing-'));
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const result = await runSession(config(dir), new AbortController().signal);
    assert.equal(result.kind, 'launch-failed');
    assert.deepEqual(result.stderrTail, []);
    assert.deepEqual(readdirSync(dir), []);
  } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

test('times out and terminates a hung session, while no timeout permits completion', async () => {
  await withFake(`
const fs = require('node:fs');
fs.writeFileSync(process.env.AFK_FAKE_RECORD, String(process.pid));
process.on('SIGINT', () => { fs.writeFileSync(process.env.AFK_FAKE_RECORD + '.signal', 'SIGINT'); process.exit(0); });
setTimeout(() => { process.stdout.write('{"outcome":"complete"}'); process.exit(0); }, 1500);
`, async (dir) => {
    const timed = await runSession(config(dir, { sessionTimeout: 0.8 }), new AbortController().signal);
    assert.deepEqual(timed, { kind: 'timed-out' });
    assert.equal(readFileSync(join(dir, 'record.json.signal'), 'utf8'), 'SIGINT');
    const pid = Number(readFileSync(join(dir, 'record.json'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const normal = await runSession(config(dir), new AbortController().signal);
    assert.deepEqual(normal, { kind: 'ok', finalMessage: '{"outcome":"complete"}', stderrTail: [] });
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
    const pending = runSession(config(dir), controller.signal);
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
    assert.deepEqual(await runSession(config(dir), controller.signal), { kind: 'aborted' });
    assert.equal(existsSync(join(dir, 'record.json')), false);
  });
});
