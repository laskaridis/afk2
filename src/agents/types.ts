export type FinalMessageResult =
  | { kind: 'message'; text: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

export interface AgentAdapter {
  name: string;
  executable: string;
  buildArgs(input: { cwd: string; model?: string; effort?: string }): string[];
  extractFinalMessage(stdout: string): FinalMessageResult;
}
