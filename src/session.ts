import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { codex } from './agents/codex.js';
import type { AgentAdapter } from './agents/types.js';

export interface SessionConfig {
  adapter?: AgentAdapter;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  sessionTimeout?: number;
}

export type SessionResult =
  | { kind: 'ok'; finalMessage: string; stderrTail: string[] }
  | { kind: 'missing-response'; stderrTail: string[] }
  | { kind: 'invalid-response'; reason: string; stderrTail: string[] }
  | { kind: 'launch-failed'; message: string; stderrTail: string[] }
  | { kind: 'exit-failed'; status: number | null; stderrTail: string[] }
  | { kind: 'timed-out' }
  | { kind: 'aborted' };

const skillInstructions = 'Use the available code skill for this iteration. Implement one task and follow its response protocol.\n---\n';

/** Run one new agent conversation, leaving all run policy to the caller. */
export async function runSession(config: SessionConfig, signal: AbortSignal): Promise<SessionResult> {
  if (signal.aborted) return { kind: 'aborted' };
  const adapter = config.adapter ?? codex;
  const args = adapter.buildArgs({ cwd: config.cwd, model: config.model, effort: config.reasoningEffort });

  return await new Promise<SessionResult>((resolve) => {
    const child = spawn(adapter.executable, args, { cwd: config.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let launchError: Error | undefined;
    let stopped: 'timeout' | 'abort' | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let terminate: NodeJS.Timeout | undefined;
    let kill: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [];
    const stderrTail: string[] = [];
    const stderrDecoder = new StringDecoder('utf8');
    let stderrRemainder = '';

    const signalGroup = (name: NodeJS.Signals) => {
      try { process.kill(-child.pid!, name); }
      catch { child.kill(name); }
    };

    const stop = (reason: 'timeout' | 'abort') => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      stopped = reason;
      signalGroup('SIGINT');
      terminate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalGroup('SIGTERM');
      }, 2000);
      kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
      }, 5000);
    };

    const onAbort = () => stop('abort');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (config.sessionTimeout !== undefined && !stopped) {
      timeout = setTimeout(() => stop('timeout'), config.sessionTimeout * 1000);
    }

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const lines = (stderrRemainder + stderrDecoder.write(chunk)).split('\n');
      stderrRemainder = lines.pop() ?? '';
      for (const line of lines) {
        stderrTail.push(line.replace(/\r$/, ''));
        if (stderrTail.length > 20) stderrTail.shift();
      }
    });
    child.stdin.on('error', () => {});
    if (!stopped) child.stdin.end(`${skillInstructions}${config.prompt}`);
    else child.stdin.end();
    child.on('error', (error) => { launchError = error; });
    child.on('close', (status) => {
      signal.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      if (terminate) clearTimeout(terminate);
      if (kill) clearTimeout(kill);
      if (stopped === 'abort') return resolve({ kind: 'aborted' });
      if (stopped === 'timeout') return resolve({ kind: 'timed-out' });
      stderrRemainder += stderrDecoder.end();
      if (stderrRemainder) {
        stderrTail.push(stderrRemainder.replace(/\r$/, ''));
        if (stderrTail.length > 20) stderrTail.shift();
      }
      if (launchError) return resolve({ kind: 'launch-failed', message: launchError.message, stderrTail });
      if (status !== 0) return resolve({ kind: 'exit-failed', status, stderrTail });
      const final = adapter.extractFinalMessage(Buffer.concat(stdout).toString('utf8'));
      if (final.kind === 'missing') return resolve({ kind: 'missing-response', stderrTail });
      if (final.kind === 'invalid') return resolve({ kind: 'invalid-response', reason: final.reason, stderrTail });
      resolve({ kind: 'ok', finalMessage: final.text, stderrTail });
    });
  });
}
