import assert from 'node:assert/strict';
import test from 'node:test';
import { runLoop } from '../dist/run.js';
import { codex } from '../dist/agents/codex.js';
import { adapters } from '../dist/agents/registry.js';

const options = (extra = {}) => ({
  prompt: 'Original prompt', cwd: '/prepared/workspace', maxIterations: 10, ...extra,
});
const ok = (outcome) => ({ kind: 'ok', finalMessage: JSON.stringify(outcome) });

test('repeat starts fresh sequential sessions with the original options', async () => {
  const calls = [];
  let active = false;
  const results = [ok({ outcome: 'repeat' }), ok({ outcome: 'complete' })];
  const runner = async (config) => {
    assert.equal(active, false);
    active = true;
    calls.push(config);
    await Promise.resolve();
    active = false;
    return results.shift();
  };
  const events = [];

  const status = await runLoop(options(), runner, event => events.push(event), new AbortController().signal);

  assert.deepEqual(status, { kind: 'completed' });
  assert.deepEqual(calls, [
    { adapter: codex, prompt: 'Original prompt', cwd: '/prepared/workspace' },
    { adapter: codex, prompt: 'Original prompt', cwd: '/prepared/workspace' },
  ]);
  assert.deepEqual(events.filter(event => event.kind === 'iteration-start').map(event => event.iteration), [1, 2]);
});

test('complete and blocked stop immediately; fail reports its summary and continues', async () => {
  for (const [response, expected] of [
    [{ outcome: 'complete' }, { kind: 'completed' }],
    [{ outcome: 'blocked', blocker_text: 'Provide the task list' }, { kind: 'blocked', blockerText: 'Provide the task list' }],
  ]) {
    let calls = 0;
    const status = await runLoop(options(), async () => { calls++; return ok(response); }, () => {}, new AbortController().signal);
    assert.deepEqual(status, expected);
    assert.equal(calls, 1);
  }
  const events = [];
  const responses = [ok({ outcome: 'fail', failure_summary: 'Tests failed' }), ok({ outcome: 'complete' })];
  assert.deepEqual(await runLoop(options(), async () => responses.shift(), event => events.push(event), new AbortController().signal), { kind: 'completed' });
  assert.deepEqual(events.filter(event => event.kind === 'fail'), [{ kind: 'fail', summary: 'Tests failed' }]);
});

test('each execution-error type retries once with the same prompt and workspace', async () => {
  const errors = [
    [{ kind: 'launch-failed', message: 'ENOENT' }, { kind: 'launch-failed', message: 'ENOENT' }],
    [{ kind: 'exit-failed', status: 7 }, { kind: 'exit-failed', status: 7 }],
    [{ kind: 'ok', finalMessage: '' }, { kind: 'missing-response' }],
    [{ kind: 'ok', finalMessage: 'not JSON' }, { kind: 'invalid-response', reason: 'code skill protocol violation' }],
  ];
  for (const [first, expectedError] of errors) {
    const calls = [];
    const events = [];
    const statuses = [first, ok({ outcome: 'complete' })];
    const status = await runLoop(options({ model: 'chosen', reasoningEffort: 'high', sessionTimeout: 4 }),
      async (config) => { calls.push(config); return statuses.shift(); },
      event => events.push(event), new AbortController().signal);
    assert.deepEqual(status, { kind: 'completed' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(calls[0], {
      adapter: codex, prompt: 'Original prompt', cwd: '/prepared/workspace', model: 'chosen', reasoningEffort: 'high', sessionTimeout: 4,
    });
    assert.deepEqual(events.filter(event => event.kind === 'execution-error'), [{ kind: 'execution-error', error: expectedError, stderrTail: [] }]);
    assert.deepEqual(events.filter(event => event.kind === 'retry'), [{ kind: 'retry', iteration: 2 }]);
  }
});

test('two consecutive execution errors stop, while a valid repeat or fail resets the allowance', async () => {
  const first = { kind: 'launch-failed', message: 'ENOENT' };
  const second = { kind: 'exit-failed', status: 7 };
  let calls = 0;
  assert.deepEqual(await runLoop(options(), async () => { calls++; return calls === 1 ? first : second; }, () => {}, new AbortController().signal),
    { kind: 'execution-error', error: second, stderrTail: [] });
  assert.equal(calls, 2);

  for (const valid of [{ outcome: 'repeat' }, { outcome: 'fail', failure_summary: 'Found a defect' }]) {
    const sequence = [first, ok(valid), second, ok({ outcome: 'complete' })];
    assert.deepEqual(await runLoop(options(), async () => sequence.shift(), () => {}, new AbortController().signal), { kind: 'completed' });
    assert.equal(sequence.length, 0);
  }
});

test('every launch consumes budget, including a retry; final complete and blocked take precedence', async () => {
  for (const final of [ok({ outcome: 'repeat' }), ok({ outcome: 'fail', failure_summary: 'Still failing' }), { kind: 'launch-failed', message: 'ENOENT' }]) {
    let calls = 0;
    const status = await runLoop(options({ maxIterations: 1 }), async () => { calls++; return final; }, () => {}, new AbortController().signal);
    assert.deepEqual(status, { kind: 'iteration-limit', limit: 1 });
    assert.equal(calls, 1);
  }
  for (const [last, expected] of [
    [ok({ outcome: 'complete' }), { kind: 'completed' }],
    [ok({ outcome: 'blocked', blocker_text: 'Need credentials' }), { kind: 'blocked', blockerText: 'Need credentials' }],
  ]) {
    const sequence = [ok({ outcome: 'repeat' }), last];
    assert.deepEqual(await runLoop(options({ maxIterations: 2 }), async () => sequence.shift(), () => {}, new AbortController().signal), expected);
  }
});

test('timeout ends the run without retry and reports its configured duration', async () => {
  let calls = 0;
  const result = await runLoop(options({ sessionTimeout: 3 }), async () => { calls++; return { kind: 'timed-out' }; }, () => {}, new AbortController().signal);
  assert.deepEqual(result, { kind: 'timeout', duration: 3 });
  assert.equal(calls, 1);
});

test('interruption prevents launches and wins over a pending runner result', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  assert.deepEqual(await runLoop(options(), async () => { calls++; return ok({ outcome: 'complete' }); }, () => {}, controller.signal), { kind: 'interrupted' });
  assert.equal(calls, 0);

  for (const sessionResult of [{ kind: 'exit-failed', status: 130 }, ok({ outcome: 'complete' })]) {
    const current = new AbortController();
    let finish;
    const pending = runLoop(options(), async () => { calls++; return await new Promise(resolve => { finish = resolve; }); }, () => {}, current.signal);
    current.abort();
    finish(sessionResult);
    assert.deepEqual(await pending, { kind: 'interrupted' });
  }
  assert.equal(calls, 2);
});

test('interruption during iteration reporting prevents the session launch', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runLoop(options(), async () => { calls++; return ok({ outcome: 'complete' }); },
    () => controller.abort(), controller.signal);
  assert.deepEqual(result, { kind: 'interrupted' });
  assert.equal(calls, 0);
});

test('every launch and retry uses the selected adapter and preserves overrides', async () => {
  const stub = { name: 'stub', executable: 'stub', buildArgs: () => [], extractFinalMessage: () => ({ kind: 'missing' }) };
  adapters.set(stub.name, stub);
  try {
    for (const [agent, expected] of [[undefined, codex], ['codex', codex], ['stub', stub]]) {
      const calls = [];
      const responses = [{ kind: 'launch-failed', message: 'ENOENT' }, ok({ outcome: 'complete' })];
      const status = await runLoop(options({ ...(agent && { agent }), model: 'unmapped-model', reasoningEffort: 'custom-effort' }),
        async config => { calls.push(config); return responses.shift(); }, () => {}, new AbortController().signal);
      assert.deepEqual(status, { kind: 'completed' });
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.adapter, expected);
        assert.equal(call.model, 'unmapped-model');
        assert.equal(call.reasoningEffort, 'custom-effort');
      }
    }
  } finally { adapters.delete(stub.name); }
});

test('execution error events and final status carry only their own stderr tails and invalid reasons', async () => {
  const first = { kind: 'invalid-response', reason: 'agent output could not be parsed', stderrTail: ['first detail'] };
  const second = { kind: 'ok', finalMessage: 'not JSON', stderrTail: ['second detail'] };
  const results = [first, second];
  const events = [];
  const status = await runLoop(options(), async () => results.shift(), event => events.push(event), new AbortController().signal);
  assert.deepEqual(events.filter(event => event.kind === 'execution-error'), [{
    kind: 'execution-error', error: { kind: 'invalid-response', reason: first.reason }, stderrTail: ['first detail'],
  }]);
  assert.deepEqual(status, {
    kind: 'execution-error', error: { kind: 'invalid-response', reason: 'code skill protocol violation' }, stderrTail: ['second detail'],
  });
});

test('successful protocol responses and timeouts never expose agent stderr', async () => {
  for (const result of [
    { ...ok({ outcome: 'complete' }), stderrTail: ['private success detail'] },
    { kind: 'timed-out' },
  ]) {
    const events = [];
    const status = await runLoop(options(), async () => result, event => events.push(event), new AbortController().signal);
    assert.equal(events.some(event => event.kind === 'execution-error'), false);
    assert.equal('stderrTail' in status, false);
  }
});

test('the same results produce the same events and status for different adapters', async () => {
  const other = { name: 'other', executable: 'other', buildArgs: () => [], extractFinalMessage: () => ({ kind: 'missing' }) };
  adapters.set(other.name, other);
  try {
    const outputs = [];
    for (const agent of ['codex', 'other']) {
      const results = [{ kind: 'exit-failed', status: 3, stderrTail: ['detail'] }, ok({ outcome: 'blocked', blocker_text: 'needs work' })];
      const events = [];
      const status = await runLoop(options({ agent }), async () => results.shift(), event => events.push(event), new AbortController().signal);
      outputs.push({ events, status });
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally { adapters.delete(other.name); }
});
