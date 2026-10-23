/** Constants shared by the sales routes and jobs (kept apart so jobs.ts stays light). */

/** Changes this long before a POS cursor are re-sent (late-committing transactions). */
export const CURSOR_OVERLAP_MS = 5 * 60_000
/** POS cursors older than this answer a full bootstrap (tombstones are kept longer). */
export const CURSOR_MAX_AGE_MS = 30 * 86_400_000
/** Recent customers sent to a register for offline lookup. */
export const BOOTSTRAP_CUSTOMERS = 200
