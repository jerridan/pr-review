// A percentile bootstrap with a fixed seed (D8 phase 2). The same input
// always gives the same interval, so two reports of one run agree.

/** The seed of every bootstrap of the by-pass report. */
export const BOOTSTRAP_SEED = 20261114;
/** The number of resamples of every bootstrap of the by-pass report. */
export const BOOTSTRAP_RESAMPLES = 10000;
/** The level of every interval of the by-pass report. */
export const BOOTSTRAP_LEVEL = 0.9;

/**
 * A pseudo-random number generator (mulberry32). It gives numbers from 0
 * up to, but not including, 1. The same seed gives the same sequence.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The resamples of "n" items: each resample draws "n" indices with
 * replacement. No item gives no resample.
 */
export function resamples(
  n: number,
  count = BOOTSTRAP_RESAMPLES,
  seed = BOOTSTRAP_SEED,
): number[][] {
  if (n === 0) return [];
  const random = seededRandom(seed);
  return Array.from({ length: count }, () =>
    Array.from({ length: n }, () => Math.floor(random() * n)),
  );
}

/**
 * The percentile interval of "values" at "level". Each tail holds the
 * same number of values: round(N * (1 - level) / 2). The interval runs from
 * the first value after the lower tail to the last value before the upper
 * tail, in sorted order. A value can be Infinity. No value gives null ends.
 */
export function percentileInterval(
  values: number[],
  level = BOOTSTRAP_LEVEL,
): { lower: number | null; upper: number | null } {
  if (values.length === 0) return { lower: null, upper: null };
  const sorted = [...values].sort((a, b) => a - b);
  const tail = Math.round((sorted.length * (1 - level)) / 2);
  return {
    lower: sorted[tail] ?? null,
    upper: sorted[sorted.length - 1 - tail] ?? null,
  };
}
