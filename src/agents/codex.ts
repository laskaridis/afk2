import type { AgentAdapter } from './types.js';

export const codex: AgentAdapter = {
  name: 'codex',
  executable: 'codex',
  buildArgs({ model, effort }) {
    const args = ['exec', '--approve-for-me'];
    if (model !== undefined) args.push('--model', model);
    if (effort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    args.push('-');
    return args;
  },
  extractFinalMessage(stdout) {
    return stdout.trim() ? { kind: 'message', text: stdout } : { kind: 'missing' };
  },
};
