import { describe, it, expect } from 'vitest';
// Import the REAL validator. Re-implementing it here would test the copy,
// not the code that runs — the same mistake as testing a reimplementation of
// setStopReason instead of the function itself.
import { validateSettings } from '../../electron/ipc/validateSettings.js';

/**
 * settings:set stored whatever arrived. The Max Tokens field uses
 * `<Input type="number" min="1000">` — HTML min/max are not enforced outside a
 * form submit — and `parseInt(v) || 20000`, which passes -1 through because -1
 * is truthy. Every engine consumer reads `serviceModelMaxTokens || 20000`, so
 * -1 survived all of them and reached all five providers as max_tokens: -1,
 * 400ing every call, while the preflight clamped to Math.max(1, ...) and quoted
 * a CHEAPER run (the modal rendered an inverted band, high below low).
 *
 * The validator lives in the main process because that is the only chokepoint
 * every caller passes through; the UI clamp is a second line, not the only one.
 */
describe('settings that cannot be honoured are refused', () => {
  it.each([-1, 0, NaN, 0.5, 1e12, Infinity])('rejects serviceModelMaxTokens %s', (v) => {
    expect(() => validateSettings({ serviceModelMaxTokens: v })).toThrow(/serviceModelMaxTokens/);
  });

  it('rejects a null payload rather than overwriting saved settings', () => {
    // getSettings threw on null, fell into the defaults branch, and wrote
    // defaults OVER the user's stored model and limits.
    expect(() => validateSettings(null)).toThrow(/must be an object/);
    expect(() => validateSettings(42 as any)).toThrow(/must be an object/);
    expect(() => validateSettings([] as any)).toThrow(/must be an object/);
  });

  it.each(['five', -5, 999])('rejects a bad globalParallelLimit/retries: %s', (v) => {
    const bad = typeof v === 'string' || v < 0
      ? { globalParallelLimit: v }
      : { retries: v };
    expect(() => validateSettings(bad)).toThrow();
  });

  it('rejects a serviceModel that is not { provider, model }', () => {
    expect(() => validateSettings({ serviceModel: 'not-an-object' })).toThrow(/serviceModel/);
    expect(() => validateSettings({ serviceModel: { provider: 'openai' } })).toThrow(/serviceModel/);
  });

  it('accepts an ordinary settings object unchanged', () => {
    const ok = { globalParallelLimit: 5, serviceModelMaxTokens: 20000, retries: 3,
      serviceModel: { provider: 'openai', model: 'gpt-4o' } };
    expect(validateSettings({ ...ok })).toEqual(ok);
  });
});
