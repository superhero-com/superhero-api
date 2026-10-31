export interface ShortsUploadBudgetLimits {
  uploads: number;
  sourceBytes: number;
}

export function validateUploadBudget(limits: ShortsUploadBudgetLimits) {
  if (
    !Number.isSafeInteger(limits?.uploads) ||
    limits.uploads < 1 ||
    limits.uploads > 1000000 ||
    !Number.isSafeInteger(limits?.sourceBytes) ||
    limits.sourceBytes < 1 ||
    limits.sourceBytes > 1000000000000000
  )
    throw new Error('Invalid retained upload budget');
  return limits;
}

/** Explicit setup input, never an API replica's authority to overwrite shared limits. */
export function shortsUploadBudgetConfig(env: NodeJS.ProcessEnv = process.env) {
  const uploads = env.SHORTS_MAX_RETAINED_UPLOADS;
  const bytes = env.SHORTS_MAX_RETAINED_SOURCE_BYTES;
  if (uploads === undefined && bytes === undefined) return undefined;
  if (!/^\d+$/.test(uploads ?? '') || !/^\d+$/.test(bytes ?? ''))
    throw new Error(
      'Set both retained upload budget limits as positive integers',
    );
  return validateUploadBudget({
    uploads: Number(uploads),
    sourceBytes: Number(bytes),
  });
}
