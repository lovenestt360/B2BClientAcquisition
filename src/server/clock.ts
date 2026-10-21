let override: (() => Date) | null = null;

/**
 * Current time; tests can pin it with setClock(). In simulation mode only (and never when
 * automated outreach is allowed), SIMULATION_CLOCK=<ISO time> pins the clock so contact-hour
 * rules can be exercised at any time of day.
 */
export function now(): Date {
  if (override) return override();
  const sim = process.env.SIMULATION_CLOCK;
  if (sim && process.env.SIMULATION_MODE !== "false" && process.env.ALLOW_AUTOMATED_OUTREACH !== "true") {
    const d = new Date(sim);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function setClock(fn: (() => Date) | null) {
  override = fn;
}
