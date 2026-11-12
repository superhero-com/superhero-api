import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

export const SHORTS_SCRATCH_CONFIG = Symbol('SHORTS_SCRATCH_CONFIG');
export function shortsScratchConfig(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.SHORTS_WORKER_TMP_DIR || tmpdir();
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = env[name] ?? String(fallback),
      value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(`Invalid ${name}`);
    return value;
  };
  if (!isAbsolute(directory))
    throw new Error('Worker scratch directory must be absolute');
  return {
    directory,
    minFreeBytes: integer(
      'SHORTS_WORKER_MIN_FREE_BYTES',
      67108864,
      1048576,
      100_000_000_000,
    ),
    minFreeInodes: integer(
      'SHORTS_WORKER_MIN_FREE_INODES',
      128,
      128,
      1_000_000,
    ),
    maxUsedPercent: integer('SHORTS_WORKER_MAX_USED_PERCENT', 85, 50, 99),
  };
}
export type ShortsScratchConfig = ReturnType<typeof shortsScratchConfig>;
