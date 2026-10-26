import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SessionConfig {
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  sessionTimeout?: number;
}

export type SessionResult =
  | { kind: 'ok'; finalMessage: string }
  | { kind: 'launch-failed'; message: string }
  | { kind: 'exit-failed'; status: number | null }
  | { kind: 'timed-out' }
  | { kind: 'aborted' };

export type Activity = (stream: 'stdout' | 'stderr', chunk: Buffer) => void;

const defaultActivity: Activity = (stream, chunk) => {
  (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
};

const skillInstructions = 'Use the available code skill for this iteration. Implement one task and follow its response protocol.\n---\n';

/** Run one new Codex conversation, leaving all run policy to the caller. */
export async function runSession(config: SessionConfig, signal: AbortSignal, activity: Activity = defaultActivity): Promise<SessionResult> {
  if (signal.aborted) return { kind: 'aborted' };

  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'afk-last-message-'));
  } catch (error) {
    return { kind: 'launch-failed', message: String(error) };
  }
  const lastMessagePath = join(tempDir, 'last-message');
  const args = ['exec', '--approve-for-me', '--output-last-message', lastMessagePath];
  if (config.model !== undefined) args.push('--model', config.model);
  if (config.reasoningEffort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`);
  args.push('-');

  try {
    return await new Promise<SessionResult>((resolve) => {
      const child = spawn('codex', args, { cwd: config.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let launchError: Error | undefined;
      let stopped: 'timeout' | 'abort' | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let terminate: NodeJS.Timeout | undefined;
      let kill: NodeJS.Timeout | undefined;

      // The child leads its own process group, so descendants are signalled too.
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

      child.stdout.on('data', (chunk: Buffer) => activity('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => activity('stderr', chunk));
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
        if (launchError) return resolve({ kind: 'launch-failed', message: launchError.message });
        if (status !== 0) return resolve({ kind: 'exit-failed', status });
        let finalMessage = '';
        try { finalMessage = readFileSync(lastMessagePath, 'utf8'); }
        catch { /* A missing final response is reported by the run policy. */ }
        resolve({ kind: 'ok', finalMessage });
      });
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
