'use strict'

// #1519 (SPEC #1518 §4, M2) — THE single Kyiv-day helper for the `/me` MVP
// (`life_*` routes). Same conversion already live in routes/goals.js's /streaks
// handler (`toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })`), now
// factored into ONE importable function so no `life_*` route re-implements it —
// lesson #1299: this repo already had 12+ independently-drifted UTC/Kyiv call
// sites before that cleanup. Every `day` field under /api/life/* is this
// function's output, never a raw `Date` or `toISOString().slice(0,10)`.

/**
 * Convert an instant (Date | date-parseable value) to its Kyiv calendar day.
 * `Intl`'s 'sv-SE' locale happens to format as YYYY-MM-DD, so no manual
 * string assembly is needed — same trick routes/goals.js already relies on.
 */
function toKyivDay(date) {
  const d = date instanceof Date ? date : new Date(date)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
}

/** Today's Kyiv calendar day, as of the instant this is called. */
function todayKyiv() {
  return toKyivDay(new Date())
}

/**
 * Add `n` calendar days to an already-resolved Kyiv day string (YYYY-MM-DD).
 * This is pure calendar-string arithmetic, NOT a "what day is it now" boundary
 * computation — the input is already a Kyiv day, not an instant — so it
 * anchors at UTC NOON (far from any midnight/DST edge) purely to get a safe
 * `Date` to increment, then re-formats via `toKyivDay` (never a raw
 * `toISOString().slice(0,10)`, which the day-off-by-one grep in A2 forbids).
 */
function addDaysToKyivDay(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  anchor.setUTCDate(anchor.getUTCDate() + n)
  return toKyivDay(anchor)
}

const KYIV_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** `true` iff `value` is a well-formed YYYY-MM-DD string (format only, no calendar validity check). */
function isValidKyivDayFormat(value) {
  return typeof value === 'string' && KYIV_DAY_RE.test(value)
}

module.exports = { toKyivDay, todayKyiv, addDaysToKyivDay, isValidKyivDayFormat, KYIV_DAY_RE }
