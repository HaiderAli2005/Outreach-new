import { cronMatches } from "../lib/cron.js";
import { withLock } from "../lib/locks.js";
import { logger } from "../lib/logger.js";
import { JOBS } from "./registry.js";

/**
 * Runs every job in the registry on its own schedule, inside the API. For a machine with no Cloud Scheduler (your
 * PC); in production the scheduler calls /api/v1/jobs/:name/run instead. Checks once a minute, and each job takes
 * the same lock the jobs route takes, so a job never runs twice at once.
 */
export function startJobsInProcess(): () => void {
  let last = -1;
  const tick = () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === last) return;
    last = minute;
    for (const [name, job] of Object.entries(JOBS)) {
      if (!cronMatches(job.schedule, now)) continue;
      void withLock(`job:${name}`, job.lockMs, job.run)
        .then((r) => r.ran && logger.debug({ job: name }, "job ran"))
        .catch((err) => logger.error({ err, job: name }, "job failed"));
    }
  };
  const timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
