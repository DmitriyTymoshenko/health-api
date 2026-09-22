'use strict'

// #1492 (stage H of #1485, REQ-10): extracted from routes/labs.js's own
// `GET /api/labs/reminders` handler (was inline) so the new weekly digest
// (lib/labs-digest.js) can consume the SAME bucketing logic instead of a
// second copy — the task explicitly says "не дублюй логіку, споживай".
// Behavior is byte-identical to the pre-extraction inline code: same
// latest-per-biomarker fold, same daysLeft math, same overdue/soon/upcoming
// buckets and sort order, same summary shape. routes/labs.js's own handler
// now calls `computeLabsReminders()` with the constants it already owns
// (REFERENCE_RANGES/RETEST_INTERVALS/getStatus) — existing labs tests
// (labs.test.ts, labs_excluded_1415.test.ts) exercise the route unchanged
// and stay green, proving the extraction is 1:1.
//
// `computeLabsReminders` is intentionally pure and takes referenceRanges/
// retestIntervals/getStatus as PARAMETERS rather than requiring
// `../routes/labs.js` itself: routes/labs.js requires THIS file, so a
// top-level `require('../routes/labs.js')` here would create a circular
// require where routes/labs.js's `module.exports` is still the default `{}`
// (it gets reassigned to `makeRouter` only at the very end of that file) —
// the destructure would silently resolve to `undefined`. `fetchLabsReminders`
// below (the DB-aware convenience used by labs-digest.js, which is NOT
// required by routes/labs.js, so no cycle exists on that path) still needs
// those constants — it requires routes/labs.js LAZILY (inside the function
// body), which resolves after the full module graph has already loaded, by
// which point routes/labs.js's exports are the complete, final object.

/**
 * @param {Array<object>} allLabResults lab_results docs, `excluded:true` already
 *   filtered by the caller, sorted date DESC (same precondition the original
 *   inline route code relied on for first-seen-wins per biomarker).
 * @param {Record<string, object>} referenceRanges keyed by biomarker key, `{name, ...}`.
 * @param {Record<string, number>} retestIntervals keyed by biomarker key, interval in days.
 * @param {(key: string, value: number) => string} getStatus
 * @param {Date} today reference "now" (injectable for tests).
 * @returns {{overdue: object[], soon: object[], upcoming: object[], never: object[], summary: object}}
 */
function computeLabsReminders(allLabResults, referenceRanges, retestIntervals, getStatus, today = new Date()) {
  const latest = {}
  for (const entry of allLabResults) {
    for (const [key, val] of Object.entries(entry.values || {})) {
      if (!latest[key]) {
        latest[key] = { value: val, date: entry.date }
      }
    }
  }

  const overdue = []  // daysLeft <= 0
  const soon = []     // daysLeft 1-30
  const upcoming = [] // daysLeft > 30
  const never = []    // no data at all

  for (const [key, intervalDays] of Object.entries(retestIntervals)) {
    const ref = referenceRanges[key]
    const name = ref?.name || key

    if (!latest[key]) {
      never.push({ key, name, intervalDays })
      continue
    }

    const lastDate = new Date(latest[key].date)
    const nextDate = new Date(lastDate)
    nextDate.setDate(nextDate.getDate() + intervalDays)
    const daysLeft = Math.ceil((nextDate - today) / 86400000)

    const item = {
      key, name, intervalDays,
      lastDate: latest[key].date,
      lastValue: latest[key].value,
      nextDate: nextDate.toISOString().split('T')[0],
      daysLeft,
      status: getStatus(key, latest[key].value),
    }

    if (daysLeft <= 0) overdue.push(item)
    else if (daysLeft <= 30) soon.push(item)
    else upcoming.push(item)
  }

  overdue.sort((a, b) => a.daysLeft - b.daysLeft)
  soon.sort((a, b) => a.daysLeft - b.daysLeft)
  upcoming.sort((a, b) => a.daysLeft - b.daysLeft)

  return {
    overdue,
    soon,
    upcoming,
    never,
    summary: {
      total: Object.keys(retestIntervals).length,
      overdueCount: overdue.length,
      soonCount: soon.length,
      upcomingCount: upcoming.length,
      neverCount: never.length,
    },
  }
}

/**
 * DB-aware convenience: runs the SAME Mongo query `GET /api/labs/reminders`
 * uses, then delegates to `computeLabsReminders`. Lazy-requires
 * `../routes/labs.js` for REFERENCE_RANGES/RETEST_INTERVALS/getStatus — see
 * the circular-require note above.
 */
async function fetchLabsReminders(db, now = new Date()) {
  // eslint-disable-next-line global-require
  const { getStatus, REFERENCE_RANGES, RETEST_INTERVALS } = require('../routes/labs.js')
  const all = await db.collection('lab_results').find({ excluded: { $ne: true } }).sort({ date: -1 }).toArray()
  return computeLabsReminders(all, REFERENCE_RANGES, RETEST_INTERVALS, getStatus, now)
}

module.exports = { computeLabsReminders, fetchLabsReminders }
