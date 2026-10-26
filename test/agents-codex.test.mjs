import assert from 'node:assert/strict';
import test from 'node:test';
import { codex } from '../dist/agents/codex.js';

test('Codex builds a fresh exec command with only requested overrides', () => {
  assert.equal(codex.name, 'codex');
  assert.equal(codex.executable, 'codex');
  assert.deepEqual(codex.buildArgs({ cwd: '/workspace' }), ['exec', '--approve-for-me', '-']);
  assert.deepEqual(codex.buildArgs({ cwd: '/workspace', model: 'chosen', effort: 'high' }),
    ['exec', '--approve-for-me', '--model', 'chosen', '-c', 'model_reasoning_effort="high"', '-']);
});

test('Codex extracts its piped final message and detects missing output', () => {
  assert.deepEqual(codex.extractFinalMessage('{"outcome":"complete"}\n'), { kind: 'message', text: '{"outcome":"complete"}\n' });
  for (const stdout of ['', ' \n\t']) {
    assert.deepEqual(codex.extractFinalMessage(stdout), { kind: 'missing' });
  }
});
