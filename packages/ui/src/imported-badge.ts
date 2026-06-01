/**
 * Tooltip text for the "imported" marker shown after a shared session's
 * name in the session list. Pulled out of SessionSearchList so the
 * from/at formatting is unit-testable without a DOM (same pattern as
 * `ahead-age.ts`).
 */

export interface ImportedSource {
  /** Friendly label of the machine the session was imported from.
   *  Absent for native (non-imported) sessions. */
  importedFrom?: string;
  /** ISO-8601 timestamp of when the import happened. Optional — legacy
   *  sidecars predate the field. */
  importedAt?: string;
}

/**
 * Returns the marker tooltip, or `null` when the session wasn't imported
 * (no `importedFrom`) so the caller can skip rendering the icon entirely.
 *
 * Shape: `Imported from <machine>` with ` at <date>` appended when a
 * parseable `importedAt` is present. The date is locale-formatted (no
 * time-of-day — the day is the useful granularity for provenance).
 */
export function importedTooltip(s: ImportedSource): string | null {
  if (!s.importedFrom) return null;
  let text = `Imported from ${s.importedFrom}`;
  if (s.importedAt) {
    const ms = Date.parse(s.importedAt);
    if (!Number.isNaN(ms)) {
      const when = new Date(ms).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      text += ` at ${when}`;
    }
  }
  return text;
}
