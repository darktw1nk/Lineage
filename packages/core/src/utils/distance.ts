// Distance calculation utilities for exact-match grading

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  return dp[m][n];
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

