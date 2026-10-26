import assert from 'node:assert/strict';
import test from 'node:test';
import { adapters, defaultAgentName, supportedAgentNames } from '../dist/agents/registry.js';
import { codex } from '../dist/agents/codex.js';

test('the built-in registry defaults to Codex and lists its registered names', () => {
  assert.equal(defaultAgentName, 'codex');
  assert.equal(adapters.get('codex'), codex);
  assert.deepEqual(supportedAgentNames(), [...adapters.keys()]);
});
