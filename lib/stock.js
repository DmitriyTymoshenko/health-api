'use strict'

const { dateStatus } = require('./cycle-status')
const { daysBetweenDateStrings, addDaysToDateString, formatDateKyiv } = require('./training-program')
const { resolveServingsPerDay } = require('./servings')

/**
 * #1489 (stage E of #1485, design E2): stock is a DERIVED value, not a
 * decrementing counter — no cron writes it. `PATCH /:id/stock` (the one
 * `routes/supplement_catalog.js` edit this stage is allowed to make) anchors
 * a new count to today (Kyiv): `stock_anchor_date` + `stock_anchor_count`.
 * This function recomputes `remaining` at READ time by walking every Kyiv
 * day in `[anchor_date, today)` (today itself is excluded — that day's dose
 * hasn't been "consumed" yet from the anchor's point of view) and
 * subtracting `servings_per_day` for each day the item counted as consuming
 * a dose: `item.active !== false` (current constant — supplement_catalog is
 * a live doc, not a per-day log, so there's no history to walk day-by-day;
 * an item currently inactive is treated as having consumed nothing since
 * the anchor) AND (no cycle for this supplement, OR the cycle's pure DATE
 * status — `dateStatus()`, not the manual-override-aware `cycleStatus()` —
 * was 'active' that day; a cycle in its pause window doesn't consume stock).
 *
 * Legacy fallback: an item that already has `stock_remaining` set (from
 * before this stage — e.g. catalog id 13, Ashwagandha, 60/60 live) but no
 * anchor fields yet is anchored to `item.updated_at` (or today, if that's
 * also missing) with `anchor_count = stock_remaining` — equivalent to "the
 * stock count was just set right now", so it starts fresh instead of
 * decrementing over unknown history.
 *
 * @param {object} item a supplement_catalog doc
 * @param {object|null} cycle the relevant supplement_cycles doc for this
 *   item's supplement_id, or null if none
 * @param {string} todayStr YYYY-MM-DD, Kyiv day
 * @returns {{remaining: number|null, days_left: number|null, buy_prominent: boolean, servings_per_day: number}}
 */
function computeStock(item, cycle, todayStr) {
  const servingsPerDay = resolveServingsPerDay(item)

  let anchorDate = item.stock_anchor_date
  let anchorCount = Number(item.stock_anchor_count)

  if (!anchorDate || !Number.isFinite(anchorCount)) {
    if (item.stock_remaining === undefined || item.stock_remaining === null) {
      return { remaining: null, days_left: null, buy_prominent: false, servings_per_day: servingsPerDay }
    }
    anchorCount = Number(item.stock_remaining)
    anchorDate = item.updated_at ? formatDateKyiv(new Date(item.updated_at)) : todayStr
  }

  const totalDays = Math.max(0, daysBetweenDateStrings(anchorDate, todayStr))
  let consumedDays = 0
  if (item.active !== false) {
    for (let i = 0; i < totalDays; i++) {
      const dayStr = addDaysToDateString(anchorDate, i)
      if (!cycle) {
        consumedDays++
      } else if (dateStatus(cycle, new Date(dayStr)) === 'active') {
        consumedDays++
      }
    }
  }

  const remaining = Math.max(0, anchorCount - servingsPerDay * consumedDays)
  const daysLeft = servingsPerDay > 0 ? remaining / servingsPerDay : null
  const buyProminent = daysLeft !== null && daysLeft < 7

  return { remaining, days_left: daysLeft, buy_prominent: buyProminent, servings_per_day: servingsPerDay }
}

module.exports = { computeStock }
