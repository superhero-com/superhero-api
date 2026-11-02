export const SHORTS_POSTER_POLICY = {
  selection: 'decoded-source-variance-earliest-tie',
  side: 32,
  maxFrames: 14400, // 60 seconds at the maximum accepted input cadence of 240 fps.
  darkBelow: 20,
  brightAbove: 235,
  uniformFraction: 0.98,
  minStandardDeviation: 8,
  blankMax: 2,
  blankMin: 253,
  blankFallback: 'first-source-frame',
  jpegQuality: 2,
} as const;
export const SHORTS_POSTER_MAX_FRAMES = SHORTS_POSTER_POLICY.maxFrames;
export const SHORTS_POSTER_SAMPLE_BYTES = SHORTS_POSTER_POLICY.side ** 2;

/** Choose from decoded source frames; earliest equal scores win deterministically. */
export function shortsPosterFrame(samples: Buffer): number {
  const size = SHORTS_POSTER_SAMPLE_BYTES;
  if (!samples.length || samples.length % size)
    throw new Error('Invalid poster analysis frames');
  if (samples.length / size > SHORTS_POSTER_MAX_FRAMES)
    throw new Error('Source exceeds the decoded frame budget');
  let preferred: number | undefined, fallback: number | undefined;
  let preferredScore = -1,
    fallbackScore = -1;
  for (let offset = 0; offset < samples.length; offset += size) {
    let sum = 0,
      squares = 0,
      dark = 0,
      bright = 0,
      min = 255,
      max = 0;
    for (let pixel = offset; pixel < offset + size; pixel++) {
      const value = samples[pixel];
      sum += value;
      squares += value * value;
      dark += Number(value < SHORTS_POSTER_POLICY.darkBelow);
      bright += Number(value > SHORTS_POSTER_POLICY.brightAbove);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    // Integer variance score avoids unstable ordering for equally useful frames.
    const score = squares * size - sum * sum;
    const index = offset / size;
    if (
      max > SHORTS_POSTER_POLICY.blankMax &&
      min < SHORTS_POSTER_POLICY.blankMin &&
      score > fallbackScore
    ) {
      fallback = index;
      fallbackScore = score;
    }
    if (
      dark < size * SHORTS_POSTER_POLICY.uniformFraction &&
      bright < size * SHORTS_POSTER_POLICY.uniformFraction &&
      score >= SHORTS_POSTER_POLICY.minStandardDeviation ** 2 * size * size &&
      score > preferredScore
    ) {
      preferred = index;
      preferredScore = score;
    }
  }
  // Dark/flat content remains valid; an entirely blank clip keeps its first frame.
  return preferred ?? fallback ?? 0;
}
