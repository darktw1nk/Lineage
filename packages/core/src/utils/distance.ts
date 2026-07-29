// Distance calculation utilities for exact-match grading

/**
 * Levenshtein distance in O(min(m,n)) memory.
 *
 * The full (m+1)x(n+1) matrix allocated ~8.3 bytes per cell, so a 30-character
 * expected value against a 3 MB model output took 777 MB — and a longer
 * reference against a max-tokens reply is enough to OOM-kill the process.
 * Only the previous row is ever read, so two rolling Int32Arrays suffice, and
 * indexing the SHORTER string keeps the rows small.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Iterate rows over the longer string, columns over the shorter one.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const n = short.length;

  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= long.length; i++) {
    curr[0] = i;
    const li = long[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = li === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,          // deletion
        curr[j - 1] + 1,      // insertion
        prev[j - 1] + cost,   // substitution
      );
    }
    const swap = prev; prev = curr; curr = swap;
  }

  return prev[n];
}

export function levenshteinScore0to10(gold: string, pred: string): number {
  const L = Math.max(1, Math.max(gold.length, pred.length));
  const d = levenshtein(gold, pred);
  const s = Math.max(0, 1 - d / L);
  return Math.round(10 * s); // 0..10
}

// JSON structural difference count
export function jsonDiffScore0to10(gold: string, pred: string): number {
  try {
    const goldObj = JSON.parse(gold);
    const predObj = JSON.parse(pred);
    
    const diffs = countStructuralDiffs(goldObj, predObj);
    const totalNodes = countNodes(goldObj);
    const N = Math.max(1, totalNodes);
    
    const score = Math.round(10 * (1 - Math.min(1, diffs / N)));
    return score;
  } catch {
    // Parse failed
    return 0;
  }
}

function countNodes(obj: any): number {
  if (obj === null || obj === undefined) return 1;
  if (typeof obj !== 'object') return 1;
  
  let count = 1;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      count += countNodes(item);
    }
  } else {
    for (const key in obj) {
      count += countNodes(obj[key]);
    }
  }
  return count;
}

function countStructuralDiffs(a: any, b: any): number {
  if (typeof a !== typeof b) return 1;
  if (a === null || b === null) return a === b ? 0 : 1;
  if (typeof a !== 'object') return a === b ? 0 : 1;
  
  let diffs = 0;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= a.length || i >= b.length) {
        diffs += 1;
      } else {
        diffs += countStructuralDiffs(a[i], b[i]);
      }
    }
  } else if (!Array.isArray(a) && !Array.isArray(b)) {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      if (!(key in a) || !(key in b)) {
        diffs += 1;
      } else {
        diffs += countStructuralDiffs(a[key], b[key]);
      }
    }
  } else {
    diffs += 1; // one is array, other is object
  }
  
  return diffs;
}

// Numeric absolute difference score
export function numericAbsScore0to10(gold: string, pred: string, toleranceFactor: number = 0.05): number {
  try {
    const goldNum = parseFloat(gold);
    const predNum = parseFloat(pred);

    // isFinite, not isNaN: parseFloat('1e999') and 'Infinity' both yield
    // Infinity, and Infinity/Infinity later produces NaN — which would poison
    // fitness, sorting, and targetFitness comparisons downstream.
    if (!Number.isFinite(goldNum) || !Number.isFinite(predNum)) return 0;

    const delta = Math.abs(predNum - goldNum);
    const tolerance = Math.max(1, Math.abs(goldNum) * toleranceFactor);

    const score = Math.round(10 * (1 - Math.min(1, delta / (tolerance + delta))));
    return Number.isFinite(score) ? score : 0;
  } catch {
    return 0;
  }
}

