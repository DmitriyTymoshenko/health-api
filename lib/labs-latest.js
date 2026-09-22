'use strict'

// #1488 (stage C of #1485): reusable "most recent value per biomarker, with
// age_days" computation for the new recommendations route
// (routes/supplement_catalog.js). Reuses `getStatus`/`REFERENCE_RANGES` by
// NAME from routes/labs.js (already exported there as test-only exports,
// #870) instead of re-declaring the ~30-line reference-range table — one
// source, per the #966/#988 lesson ("a stub of the same typo only proves the
// typo"). `routes/labs.js`'s OWN `GET /latest` handler is left untouched
// (already tested/working) — this file exists for the NEW consumer, not to
// refactor that route.

const { formatDateKyiv, daysBetweenDateStrings } = require('./training-program')
const { getStatus, REFERENCE_RANGES } = require('../routes/labs.js')

/**
 * Pure: given ALL lab_results docs (excluded:true already filtered by the
 * caller, ideally sorted date DESC so the FIRST occurrence of a key wins —
 * same precondition routes/labs.js's own /latest handler relies on) and
 * today's Kyiv date string, returns { [marker]: {value, date, age_days,
 * source, status, ref} } — byte-identical shape to `GET /api/labs/latest`.
 */
function computeLatestLabs(allLabResults, todayStr) {
  const latest = {}
  for (const entry of allLabResults) {
    for (const [key, val] of Object.entries(entry.values || {})) {
      if (!latest[key]) {
        latest[key] = {
          value: val,
          date: entry.date,
          age_days: daysBetweenDateStrings(entry.date, todayStr),
          source: entry.source || 'manual',
          status: getStatus(key, val),
          ref: REFERENCE_RANGES[key] || null,
        }
      }
    }
  }
  return latest
}

/** Convenience: db -> latest labs, using the same Mongo query labs.js uses. */
async function fetchLatestLabs(db, now = new Date()) {
  const all = await db.collection('lab_results').find({ excluded: { $ne: true } }).sort({ date: -1 }).toArray()
  return computeLatestLabs(all, formatDateKyiv(now))
}

module.exports = { getStatus, REFERENCE_RANGES, computeLatestLabs, fetchLatestLabs }
