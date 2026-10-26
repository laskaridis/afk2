import { codex } from './codex.js';
import { claude } from './claude.js';
import type { AgentAdapter } from './types.js';

export const defaultAgentName = 'codex';
export const adapters = new Map<string, AgentAdapter>([[codex.name, codex], [claude.name, claude]]);
export const supportedAgentNames = (): string[] => [...adapters.keys()];
