/**
 * The adaptive generation-size range, as the form has to handle it.
 *
 * The engine wants either a complete `{ min, max }` or nothing at all: a
 * half-filled range silently disables itself, so the user would type "4",
 * see no error, and get fixed sizing anyway. Typing a range is inherently
 * half-finished at some point, so the rule is: an incomplete or contradictory
 * range is HELD in the form (so the field the user is typing in keeps its
 * value) but reported as not yet active, and only a valid pair is committed.
 *
 * Lives outside the component because it is decision logic, not markup — the
 * desktop package has no jsdom, so anything only reachable through a rendered
 * component cannot be tested here.
 */
export interface PopulationRange { min?: number; max?: number }

/** What the config's populationRange should become after one field edit. */
export function nextPopulationRange(
  current: PopulationRange | undefined,
  field: 'min' | 'max',
  raw: string,
): PopulationRange | undefined {
  const other = field === 'min' ? current?.max : current?.min;
  if (raw.trim() === '') {
    // Clearing one half with the other half empty turns the feature off
    // entirely, rather than leaving `{min: undefined, max: undefined}` behind
    // for the engine to interpret.
    if (other === undefined) return undefined;
    return field === 'min' ? { max: other } : { min: other };
  }
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return current;
  const next = field === 'min' ? { min: value, max: other } : { min: other, max: value };
  return next;
}

/** True only when the engine will actually act on this range. */
export function isActiveRange(range: PopulationRange | undefined): range is { min: number; max: number } {
  return !!range
    && typeof range.min === 'number' && typeof range.max === 'number'
    && Number.isInteger(range.min) && Number.isInteger(range.max)
    && range.min >= 2 && range.max >= range.min;
}

/** The line under the field: what this setting will actually do. */
export function adaptiveRangeHint(
  range: PopulationRange | undefined,
  generationSize: number,
): string {
  if (!range || (range.min === undefined && range.max === undefined)) {
    return `Off — every generation is exactly ${generationSize} candidates, whether or not the run is still improving`;
  }
  if (range.min === undefined || range.max === undefined) {
    return 'Enter both a minimum and a maximum — a half-filled range is ignored';
  }
  if (range.min < 2 || range.max < 2) {
    return 'Minimum must be at least 2 — a generation of 1 cannot breed';
  }
  if (range.max < range.min) {
    return `Maximum (${range.max}) must be at least the minimum (${range.min})`;
  }
  return `Generations widen toward ${range.max} while fitness keeps improving and narrow toward ${range.min} once it flattens. Cost is estimated at the ${range.max}-candidate worst case.`;
}
