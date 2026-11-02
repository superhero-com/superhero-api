import { execFile } from 'node:child_process';

type MediaCommandOptions = {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  encoding?: 'utf8' | 'buffer';
};

export function runShortsMediaCommand(
  program: string,
  args: string[],
  options: MediaCommandOptions & { encoding: 'buffer' },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function runShortsMediaCommand(
  program: string,
  args: string[],
  options: MediaCommandOptions & { encoding?: 'utf8' },
): Promise<{ stdout: string; stderr: string }>;
/** Keep the caller's scratch reservation until the direct media child closes. */
export function runShortsMediaCommand(
  program: string,
  args: string[],
  options: MediaCommandOptions,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const { signal, ...commandOptions } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let closed = false;
    let aborted = false;
    let result:
      | {
          error: Error | null;
          stdout: string | Buffer;
          stderr: string | Buffer;
        }
      | undefined;
    const finish = () => {
      if (!closed || !result) return;
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(signal.reason);
      else if (result.error) reject(result.error);
      else resolve({ stdout: result.stdout, stderr: result.stderr });
    };
    // Node 22 execFile does not forward killSignal to its AbortSignal handler.
    // Handle cancellation ourselves and wait for close even if a callback or
    // error arrives first. Timeouts and output bounds also use SIGKILL.
    const child = execFile(
      program,
      args,
      {
        ...commandOptions,
        encoding: options.encoding ?? 'utf8',
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        result = { error, stdout, stderr };
        finish();
      },
    );
    function abort() {
      aborted = true;
      child.kill('SIGKILL');
    }
    child.once('close', () => {
      closed = true;
      finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
