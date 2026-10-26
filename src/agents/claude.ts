import type { AgentAdapter, FinalMessageResult } from './types.js';

export const claude: AgentAdapter = {
  name: 'claude',
  executable: 'claude',
  buildArgs({ model, effort }) {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'auto'];
    if (model !== undefined) args.push('--model', model);
    if (effort !== undefined) args.push('--effort', effort);
    return args;
  },
  extractFinalMessage(stdout): FinalMessageResult {
    if (!stdout.trim()) return { kind: 'missing' };
    let value: unknown;
    try { value = JSON.parse(stdout); }
    catch { return { kind: 'invalid', reason: 'agent output could not be parsed' }; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'missing' };
    const result = value as Record<string, unknown>;
    if (result.is_error === true) {
      const subtype = typeof result.subtype === 'string' && result.subtype.trim() ? result.subtype : 'unknown';
      return { kind: 'error', reason: `reported subtype: ${subtype}` };
    }
    return typeof result.result === 'string' && result.result.trim()
      ? { kind: 'message', text: result.result }
      : { kind: 'missing' };
  },
};
