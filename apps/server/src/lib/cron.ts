/**
 * Five-field cron matching (minute hour day-of-month month day-of-week), in UTC, for the schedules in
 * jobs/registry.ts: `*`, numbers, lists (1,15), ranges (1-5) and steps (*\/5, 0-30/10).
 */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b ?? (stepRaw ? max : a);
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

export function cronMatches(expr: string, at: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`"${expr}" is not a five-field cron expression`);
  const dow = at.getUTCDay();
  return (
    fieldMatches(f[0], at.getUTCMinutes(), 0, 59) &&
    fieldMatches(f[1], at.getUTCHours(), 0, 23) &&
    fieldMatches(f[2], at.getUTCDate(), 1, 31) &&
    fieldMatches(f[3], at.getUTCMonth() + 1, 1, 12) &&
    (fieldMatches(f[4], dow, 0, 7) || (dow === 0 && fieldMatches(f[4], 7, 0, 7)))
  );
}
