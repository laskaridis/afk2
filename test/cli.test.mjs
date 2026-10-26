import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseInvocation } from '../dist/cli.js';
import { adapters } from '../dist/agents/registry.js';

function withDirectory(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'afk-cli-'));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('uses exactly one positional, file, or piped prompt source', () => withDirectory((cwd) => {
  writeFileSync(join(cwd, 'prompt.txt'), 'Implement the spec\n');
  const defaults = { cwd, maxIterations: 10 };
  assert.deepEqual(parseInvocation(['Implement the spec'], null, cwd), {
    kind: 'options', options: { ...defaults, prompt: 'Implement the spec' },
  });
  assert.deepEqual(parseInvocation(['--prompt-file', 'prompt.txt'], null, cwd), {
    kind: 'options', options: { ...defaults, prompt: 'Implement the spec\n' },
  });
  assert.deepEqual(parseInvocation([], 'Implement the spec\n', cwd), {
    kind: 'options', options: { ...defaults, prompt: 'Implement the spec\n' },
  });
}));

test('rejects multiple, missing, empty, and unreadable prompt sources', () => withDirectory((cwd) => {
  writeFileSync(join(cwd, 'empty.txt'), ' \n');
  const cases = [
    [['one', '--prompt-file', 'empty.txt'], null, /multiple prompt sources/i],
    [['one'], 'two', /multiple prompt sources/i],
    [['--prompt-file', 'empty.txt'], 'two', /multiple prompt sources/i],
    [[], null, /missing prompt/i],
    [[], '', /empty prompt/i],
    [['  '], null, /empty prompt/i],
    [['--prompt-file', 'empty.txt'], null, /empty prompt/i],
    [['--prompt-file', 'absent.txt'], null, /cannot read prompt file/i],
  ];
  for (const [argv, stdin, message] of cases) {
    const result = parseInvocation(argv, stdin, cwd);
    assert.equal(result.kind, 'error');
    assert.equal(result.category, 'input');
    assert.match(result.message, message);
  }
}));

test('selects an existing workspace and captures only supplied overrides', () => withDirectory((cwd) => {
  mkdirSync(join(cwd, 'workspace'));
  assert.deepEqual(parseInvocation([
    '--cwd', 'workspace', '--model', 'chosen', '--reasoning-effort', 'high',
    '--max-iterations', '4', '--session-timeout', '2.5', 'task',
  ], null, cwd), {
    kind: 'options', options: {
      prompt: 'task', cwd: join(cwd, 'workspace'), model: 'chosen',
      reasoningEffort: 'high', maxIterations: 4, sessionTimeout: 2.5,
    },
  });
  for (const path of ['absent', 'workspace/file']) {
    if (path === 'workspace/file') writeFileSync(join(cwd, path), 'x');
    const result = parseInvocation(['--cwd', path, 'task'], null, cwd);
    assert.equal(result.kind, 'error');
    assert.equal(result.category, 'option');
    assert.match(result.message, /directory/i);
  }
}));

test('rejects invalid option values and unknown options', () => withDirectory((cwd) => {
  for (const argv of [
    ['--max-iterations', '0'], ['--max-iterations', '-1'],
    ['--max-iterations', '1.5'], ['--max-iterations', 'abc'],
    ['--session-timeout', '0'], ['--session-timeout', '-2'],
    ['--session-timeout', 'abc'], ['--unknown'],
    ['--reasoning-effort', ''],
  ]) {
    const result = parseInvocation([...argv, 'task'], null, cwd);
    assert.equal(result.kind, 'error', argv.join(' '));
    assert.equal(result.category, 'option', argv.join(' '));
  }
  for (const flag of ['--model', '--cwd', '--prompt-file']) {
    const result = parseInvocation([flag], null, cwd);
    assert.equal(result.kind, 'error');
    assert.equal(result.category, 'option');
  }
}));

test('help takes precedence and describes options and exit codes', () => withDirectory((cwd) => {
  for (const flag of ['--help', '-h']) {
    for (const invalidOptions of [['--unknown'], ['--agent', 'unsupported', '--max-iterations', '0']]) {
      assert.equal(parseInvocation([...invalidOptions, flag], 'prompt', cwd).kind, 'help');
    }
    const result = parseInvocation(['--agent', 'unsupported', '--max-iterations', '0', flag], 'prompt', cwd);
    for (const item of ['--prompt-file', '--cwd', '--agent <name>', '--model', '--reasoning-effort', '--max-iterations', '--session-timeout', 'Exit codes']) {
      assert.match(result.text, new RegExp(item));
    }
    for (const name of adapters.keys()) assert.match(result.text, new RegExp(`\\b${name}\\b`));
    assert.match(result.text, /default: codex/);
    assert.match(result.text, /the coding agent/i);
    assert.match(result.text, /--model[^\n]*passed to the agent unchanged/i);
    assert.match(result.text, /--reasoning-effort[^\n]*passed to the agent unchanged/i);
    assert.doesNotMatch(result.text, /override (?:the )?Codex/i);
  }
}));

test('help lists newly registered agents without other changes', () => withDirectory((cwd) => {
  const stub = { name: 'stub', executable: 'stub', buildArgs: () => [], extractFinalMessage: () => ({ kind: 'missing' }) };
  adapters.set(stub.name, stub);
  try {
    const result = parseInvocation(['--help'], null, cwd);
    assert.equal(result.kind, 'help');
    assert.match(result.text, /stub/);
  } finally { adapters.delete(stub.name); }
}));

test('selects a registered agent and rejects empty or unsupported names', () => withDirectory((cwd) => {
  const stub = { name: 'stub', executable: 'stub', buildArgs: () => [], extractFinalMessage: () => ({ kind: 'missing' }) };
  adapters.set(stub.name, stub);
  try {
    const selected = parseInvocation(['--agent', 'stub', 'task'], null, cwd);
    assert.equal(selected.kind, 'options');
    assert.equal(selected.options.agent, 'stub');
    for (const argv of [['--agent', 'absent', 'task'], ['--agent', '', 'task'], ['--agent'], ['--agent=', 'task']]) {
      const result = parseInvocation(argv, null, cwd);
      assert.equal(result.kind, 'error');
      assert.equal(result.category, 'option');
      assert.match(result.message, /codex/);
      assert.match(result.message, /stub/);
    }
  } finally { adapters.delete(stub.name); }
}));

test('passes model and reasoning effort unchanged and omits absent overrides', () => withDirectory((cwd) => {
  const selected = parseInvocation(['--agent', 'codex', '--model', 'unmapped-model', '--reasoning-effort', 'custom-effort', 'task'], null, cwd);
  assert.equal(selected.kind, 'options');
  assert.equal(selected.options.model, 'unmapped-model');
  assert.equal(selected.options.reasoningEffort, 'custom-effort');
  const defaults = parseInvocation(['task'], null, cwd);
  assert.equal(defaults.kind, 'options');
  assert.equal(defaults.options.agent, undefined);
  assert.equal(Object.hasOwn(defaults.options, 'model'), false);
  assert.equal(Object.hasOwn(defaults.options, 'reasoningEffort'), false);
}));
