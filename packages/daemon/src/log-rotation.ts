/**
 * Daily rotation policy for the launcher's daemon-log sink
 * (~/.config/supergit/daemon-YYYY-MM-DD.log). The launcher used to pipe
 * the daemon's stdout/stderr into one append-only daemon.log that grew
 * forever; this turns it into one file per calendar day, capped to the
 * newest `keep` files so disk use stays bounded no matter how chatty the
 * daemon is.
 *
 * Pure on purpose: it takes the directory listing + today's date and
 * returns the decision (which file to write, which to delete). The
 * launcher does the actual readdir / unlink / open-append.
 */

/** A dated daemon log: `daemon-YYYY-MM-DD.log`. The date is lexically
 *  sortable, so a plain string sort is chronological. */
const DATED_LOG_RE = /^daemon-\d{4}-\d{2}-\d{2}\.log$/;

export interface RotationPlan {
  /** File the daemon should write to this run, e.g. daemon-2026-05-31.log */
  activeName: string;
  /** Dated logs to delete so only `keep` newest remain (active included). */
  deleteNames: string[];
}

/**
 * @param existing  directory listing (bare filenames) of the log dir
 * @param today     today's date as "YYYY-MM-DD"
 * @param keep      how many dated logs to retain (including today's)
 */
export function planLogRotation(
  existing: string[],
  today: string,
  keep = 5,
): RotationPlan {
  const activeName = `daemon-${today}.log`;

  // Dated logs only, newest first.
  const dated = existing.filter((n) => DATED_LOG_RE.test(n)).sort().reverse();

  // Keep today's file plus the newest others up to the limit.
  const kept = new Set<string>([activeName]);
  for (const name of dated) {
    if (kept.size >= keep) break;
    kept.add(name);
  }

  const deleteNames = dated.filter((n) => !kept.has(n));
  return { activeName, deleteNames };
}
