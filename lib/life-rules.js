'use strict'

// #1519 (SPEC #1518 §5, M3) — pure, DB-free logic for habit/rule state, kept
// separate from routes/life_habits.js so it is unit-testable without a Mongo
// stub (same split as lib/volume-by-muscle.js / lib/exercise-trends.js vs
// their route files).

/**
 * "Habit done today" = ALL its active rules have `done:true` OR
 * `two_minute_version:true` for that day (SPEC §5 — AND across rules, a habit
 * is a bundle of concrete rules, not one combined toggle).
 *
 * `checksByRuleId` maps rule `_id` string -> check doc for the day in
 * question (or undefined/null if no check-in exists yet).
 *
 * Returns:
 *   - `null`  — no active rules at all (nothing to assess yet)
 *   - `true`  — every active rule satisfied
 *   - `false` — at least one active rule has an explicit check-in that is
 *               neither done nor a two-minute version (SPEC Q2: an ABSENT
 *               check-in is neutral, not a false — see `ruleCheckState`)
 */
function habitDoneToday(activeRules, checksByRuleId) {
  if (!activeRules || activeRules.length === 0) return null
  let anyUnmet = false
  let anyUnknown = false
  for (const rule of activeRules) {
    const check = checksByRuleId[String(rule._id)]
    if (!check) {
      anyUnknown = true
      continue
    }
    if (!(check.done === true || check.two_minute_version === true)) {
      anyUnmet = true
    }
  }
  if (anyUnmet) return false
  if (anyUnknown) return null // SPEC Q2 default: neutral unchecked, not a failure
  return true
}

/**
 * Per-rule check state for the "Сьогодні" card — SPEC Q2 default: an absent
 * check-in is a neutral `null`, never silently coerced to `false`.
 */
function ruleCheckState(check) {
  if (!check) return { done: null, two_minute_version: null }
  return {
    done: check.done === true ? true : check.done === false ? false : null,
    two_minute_version: check.two_minute_version === true,
  }
}

/**
 * "Days clean" (break habits only, SPEC §5 table) — count of consecutive
 * Kyiv days, ending today, with NO active rule marked `done:false`. Absence
 * of any check-in on a day counts as clean by default (MVP has no explicit
 * "slip" reason/trigger — that is v2).
 *
 * `dayHasFailureFlags` — ordered oldest-to-newest array of booleans, one per
 * day AFTER the habit's creation day up to and including today; `true` means
 * that day had >=1 active-rule check with `done:false`. The creation day
 * itself is day 0 and is NOT part of this array (SPEC table starts counting
 * at "+1").
 *
 * A single `true` (failure) resets the running count to 0 as of that day —
 * this is a plain left-to-right fold, matching the table byte-for-byte:
 *   created -> 0; +1 clean -> 1; +2 no check-in -> 2; +3 failure -> 0; +4 clean -> 1.
 */
function computeDaysClean(dayHasFailureFlags) {
  let count = 0
  for (const hasFailure of dayHasFailureFlags) {
    count = hasFailure ? 0 : count + 1
  }
  return count
}

module.exports = { habitDoneToday, ruleCheckState, computeDaysClean }
