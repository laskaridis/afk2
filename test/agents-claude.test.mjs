import assert from 'node:assert/strict';
import test from 'node:test';
import { claude } from '../dist/agents/claude.js';

test('Claude uses print mode, JSON output, auto permissions, and only supplied overrides', () => {
  assert.equal(claude.name, 'claude');
  assert.equal(claude.executable, 'claude');
  assert.deepEqual(claude.buildArgs({ cwd: '/workspace' }),
    ['-p', '--output-format', 'json', '--permission-mode', 'auto']);
  assert.deepEqual(claude.buildArgs({ cwd: '/workspace', model: 'custom-model', effort: 'custom-effort' }),
    ['-p', '--output-format', 'json', '--permission-mode', 'auto', '--model', 'custom-model', '--effort', 'custom-effort']);
});

test('Claude extracts a non-empty result and reports missing results', () => {
  assert.deepEqual(claude.extractFinalMessage(JSON.stringify({ result: '{"outcome":"complete"}' })),
    { kind: 'message', text: '{"outcome":"complete"}' });
  for (const stdout of ['', '  \n', '{}', '{"result":""}', JSON.stringify({ result: '  \n' }), '{"result":42}', 'null', '[]']) {
    assert.deepEqual(claude.extractFinalMessage(stdout), { kind: 'missing' }, stdout);
  }
});

test('Claude reports unparseable output and structured errors with subtype', () => {
  assert.deepEqual(claude.extractFinalMessage('not JSON'),
    { kind: 'invalid', reason: 'agent output could not be parsed' });
  assert.deepEqual(claude.extractFinalMessage(JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'ignored' })),
    { kind: 'error', reason: 'reported subtype: error_max_turns' });
});
