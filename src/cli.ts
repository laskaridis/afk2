import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RunOptions {
  prompt: string;
  cwd: string;
  maxIterations: number;
  sessionTimeout?: number;
  model?: string;
  reasoningEffort?: string;
}

export type Invocation =
  | { kind: 'options'; options: RunOptions }
  | { kind: 'help'; text: string }
  | { kind: 'error'; category: 'input' | 'option'; message: string };

export const usage = `Usage: afk [options] [prompt]

Prompt sources (choose exactly one):
  [prompt]                     Launch prompt as one positional argument
  --prompt-file <path>         Read the launch prompt from a file
  stdin                        Read the launch prompt from piped input

Options:
  --cwd <directory>            Workspace directory (default: current directory)
  --model <model>              Override the Codex model
  --reasoning-effort <effort>   Override Codex reasoning effort
  --max-iterations <count>     Maximum session launches (default: 10)
  --session-timeout <seconds>  Timeout for each session (default: none)
  -h, --help                   Show this help

Exit codes:
  0  Feature completed, or help displayed
  1  Input error, blocker, execution error, or iteration limit
  2  Session timeout
  130  Interrupted by Ctrl+C
`;

export const missingPromptMessage = 'Missing prompt: provide an argument, --prompt-file, or piped stdin.';

/** Largest delay setTimeout accepts (2^31-1 ms), in seconds. */
const maxSessionTimeout = 2147483;

const optionError = (message: string): Invocation => ({ kind: 'error', category: 'option', message });
const inputError = (message: string): Invocation => ({ kind: 'error', category: 'input', message });

/** stdin is null when attached to a terminal; a string when piped. */
export function parseInvocation(argv: string[], stdin: string | null, cwd: string): Invocation {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help', text: usage };

  let positional: string | undefined;
  let promptFile: string | undefined;
  let workspace = cwd;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let maxIterations = 10;
  let sessionTimeout: number | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      if (positional !== undefined) return inputError('Multiple prompt sources were provided.');
      positional = argument;
      continue;
    }
    if (!['--prompt-file', '--cwd', '--model', '--reasoning-effort', '--max-iterations', '--session-timeout'].includes(argument)) {
      return optionError(`Unknown option: ${argument}`);
    }
    const value = argv[++index];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return optionError(`${argument} requires a value.`);
    }
    switch (argument) {
      case '--prompt-file':
        if (promptFile !== undefined) return inputError('Multiple prompt sources were provided.');
        promptFile = value;
        break;
      case '--cwd': workspace = resolve(cwd, value); break;
      case '--model': model = value; break;
      case '--reasoning-effort': reasoningEffort = value; break;
      case '--max-iterations': {
        const count = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(count)) {
          return optionError('--max-iterations requires a positive integer.');
        }
        maxIterations = count;
        break;
      }
      case '--session-timeout': {
        const seconds = Number(value);
        if (!/^\d+(\.\d+)?$/.test(value) || seconds <= 0) {
          return optionError('--session-timeout requires positive seconds.');
        }
        if (seconds > maxSessionTimeout) {
          return optionError(`--session-timeout must not exceed ${maxSessionTimeout} seconds.`);
        }
        sessionTimeout = seconds;
        break;
      }
    }
  }

  try {
    if (!statSync(workspace).isDirectory()) return optionError(`Workspace is not a directory: ${workspace}`);
  } catch {
    return optionError(`Workspace directory is unavailable: ${workspace}`);
  }

  const sourceCount = Number(positional !== undefined) + Number(promptFile !== undefined) + Number(stdin !== null);
  if (sourceCount > 1) return inputError('Multiple prompt sources were provided.');
  if (sourceCount === 0) return inputError(missingPromptMessage);

  let prompt = positional ?? stdin ?? '';
  if (promptFile !== undefined) {
    try {
      prompt = readFileSync(resolve(cwd, promptFile), 'utf8');
    } catch {
      return inputError(`Cannot read prompt file: ${promptFile}`);
    }
  }
  if (!prompt.trim()) return inputError('Empty prompt: provide non-whitespace text.');

  return {
    kind: 'options',
    options: {
      prompt, cwd: workspace, maxIterations,
      ...(sessionTimeout !== undefined && { sessionTimeout }),
      ...(model !== undefined && { model }),
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    },
  };
}
