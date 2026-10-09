/**
 * The site log's limits, in a module of their own so the log object and the
 * payload assembly can both read them without importing each other.
 */

/** 10% of the Durable Object free allowance per UTC day. */
export const LOG_BUDGET_REF = { requests: 10000, rows: 10000, read: 500000 };

/**
 * Tiers of the log's read share (LOG_BUDGET_REF.read), as fractions of it. From the first, nothing new is read from
 * the events table; from the second, panels that need the events rest entirely; at the whole share, Site Backend rests.
 */
export const READ_TIERS = [0.3, 0.6];

/** Stored events a day (any kind except a failure); past it, new ones are counted and not stored. */
export const EVENTS_PER_DAY = 5000;

/** The most rows one load of the in-memory window may read. */
export const WINDOW_ROWS = 5000;

/** Past this, the oldest days of visits are condensed into daily summaries. */
export const GUARD_BYTES = 750 * 1024 * 1024;
