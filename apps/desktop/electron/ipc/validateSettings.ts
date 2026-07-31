import type { AppSettings } from '@lineage/core';

/**
 * Reject settings that cannot be honoured, instead of storing them.
 *
 * setSettings JSON.stringify'd whatever arrived. The Settings field uses
 * `<Input type="number" min="1000">`, whose min/max are NOT enforced outside a
 * form submit, and `parseInt(v) || 20000`, which passes -1 through because -1
 * is truthy. Every engine consumer then reads `serviceModelMaxTokens || 20000`,
 * so -1 survives all of them and reaches all five providers as max_tokens: -1
 * — every call 400s. It also inverts the preflight estimate, which clamps to
 * Math.max(1, ...) and quotes a CHEAPER run: the modal rendered ≈ $0.0041 - $0.0039.
 *
 * `settings:set(null)` was worse: getSettings threw on it, fell into the
 * defaults branch, and wrote defaults OVER the user's saved settings.
 */
const SETTINGS_LIMITS: Record<string, { min: number; max: number }> = {
  globalParallelLimit: { min: 1, max: 512 },
  serviceModelMaxTokens: { min: 1, max: 1_000_000 },
  retries: { min: 0, max: 20 },
};

export function validateSettings(settings: unknown): AppSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('settings must be an object');
  }
  // COPY: this used to coerce in place, rewriting the caller's object. The
  // shipped test passed `{ ...ok }`, whose spread is exactly what hid it.
  const s: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const [key, { min, max }] of Object.entries(SETTINGS_LIMITS)) {
    const v = s[key];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${key} must be a whole number between ${min} and ${max} (got ${JSON.stringify(v)})`);
    }
    s[key] = n;
  }
  if (s.serviceModel !== undefined && s.serviceModel !== null) {
    const m = s.serviceModel as Record<string, unknown>;
    if (typeof m !== 'object' || Array.isArray(m) || typeof m.provider !== 'string' || typeof m.model !== 'string') {
      throw new Error('serviceModel must be { provider, model }');
    }
  }
  return s as unknown as AppSettings;
}

