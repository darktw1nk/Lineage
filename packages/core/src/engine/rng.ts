/**
 * Deterministic randomness for reproducible runs.
 *
 * rngFor derives an INDEPENDENT stream per decision site from stable labels,
 * not one shared consumed-in-order stream: fill mutations and operator
 * applications run under Promise.all, so a shared stream's consumption order
 * would depend on async scheduling. Derived streams are scheduling-proof.
 */

/** mulberry32 — tiny deterministic PRNG, good enough for shuffling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit over the label path. */
function hashLabels(labels: Array<string | number>): number {
  let h = 0x811c9dc5;
  const s = labels.map(l => `${typeof l}:${l}`).join('\0');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic stream for one decision site. Undefined seed => Math.random
 * (today's non-reproducible behavior, zero overhead).
 */
export function rngFor(seed: number | undefined, ...labels: Array<string | number>): () => number {
  if (seed === undefined) return Math.random;
  return mulberry32((hashLabels(labels) ^ Math.imul(seed >>> 0, 0x9E3779B1)) >>> 0);
}
