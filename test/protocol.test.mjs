import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResponse } from '../dist/protocol.js';

test('accepts repeat and complete with only their outcome field', () => {
  assert.deepEqual(parseResponse('  {"outcome":"repeat"}\n'), { outcome: 'repeat' });
  assert.deepEqual(parseResponse('\n{"outcome":"complete"}  '), { outcome: 'complete' });
});

test('accepts blocked and fail with their required detail text', () => {
  assert.deepEqual(parseResponse('{"outcome":"blocked","blocker_text":"Need a task list"}'), {
    outcome: 'blocked', blocker_text: 'Need a task list',
  });
  assert.deepEqual(parseResponse('{"outcome":"fail","failure_summary":"A test failed"}'), {
    outcome: 'fail', failure_summary: 'A test failed',
  });
});

test('rejects anything other than one bare JSON object', () => {
  for (const input of [
    '',
    '  ',
    'Done: {"outcome":"complete"}',
    '{"outcome":"complete"} Done',
    '```json\n{"outcome":"complete"}\n```',
    '{"outcome":"complete"} {"outcome":"repeat"}',
    'null',
    '[]',
    '"complete"',
    '1',
  ]) {
    assert.deepEqual(parseResponse(input), { kind: 'violation' }, input);
  }
});

test('rejects missing fields, invalid detail fields, and extra fields', () => {
  for (const input of [
    '{}',
    '{"outcome":"repeat","extra":1}',
    '{"outcome":"complete","blocker_text":"irrelevant"}',
    '{"outcome":"blocked"}',
    '{"outcome":"blocked","blocker_text":""}',
    '{"outcome":"blocked","blocker_text":7}',
    '{"outcome":"blocked","blocker_text":"reason","extra":1}',
    '{"outcome":"fail"}',
    '{"outcome":"fail","failure_summary":""}',
    '{"outcome":"fail","failure_summary":null}',
    '{"outcome":"fail","failure_summary":"reason","extra":1}',
    '{"outcome":"unknown"}',
  ]) {
    assert.deepEqual(parseResponse(input), { kind: 'violation' }, input);
  }
});
