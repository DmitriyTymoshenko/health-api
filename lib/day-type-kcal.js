'use strict'

/**
 * Day-type-aware calorie basis (#1099).
 *
 * PROBLEM: `stableDayKcalBasis` (lib/nutrition-targets.js, #1295) gives every day
 * the SAME kcal target (TDEE + goal delta) regardless of what kind of day it is —
 * a rest Tuesday and a boxing Wednesday get an identical 2201. #1295 was right to
 * kill the LIVE-partial-WHOOP-burn dependency (that made the target swing during
 * the day), but it over-corrected into "one number for every day", which is why
 * Dmytro measured a ~1000 kcal/43% real gap on box days (task #1099 description).
 *
 * DESIGN CHOICE — weekday-recurring pattern, NOT a "planned activity" document:
 * the obvious design ("read today's planned sport from a plan, look up its analog
 * calorie burn") has no live data source in this app. Measured before writing this
 * file (2026-09-21, `whoop_workouts`/`activity_plans`/`training_programs`):
 *   - `activity_plans` (routes/activity_plan.js) — 0 documents. Nobody pre-declares
 *     a future day's sport here; it is not a usable plan source.
 *   - `training_programs` (routes/training_program.js) — has a real recurring
 *     weekly `schedule` (ISO weekday -> day key), but it only covers the 3 GYM
 *     strength days (A/B/home); box/tennis/soccer are not represented at all.
 *   - `whoop_workouts` DOES show a strong recurring WEEKLY pattern by ISO weekday
 *     (90-day sample): Wed 54% boxing / 38% tennis (avg full-day burn 2797 kcal,
 *     n=13), Fri 46% boxing / 54% tennis (2972 kcal, n=13), Sat 0%/23% but still
 *     3142 kcal (n=13, other sports), vs Mon/Tue/Thu/Sun clustering near the TDEE
 *     basis (2386-2612 kcal). Grouping by exact sport-COMBO (the literal "analog
 *     method" hypothesis in #1099) starves fast: most combos have 1-5 analogs in
 *     90 days ("boxing" alone n=5, "boxing+tennis+walking" n=4, dozens of n=1-3
 *     combos), while grouping by ISO WEEKDAY gives ~13 analogs for every single
 *     weekday — always well above the >=5 floor #1099 asked to verify.
 * So the analog cohort here is "closed days sharing this date's ISO weekday over
 * the last LOOKBACK_DAYS", not "days with the same sport set". This is the
 * stronger design #1099 explicitly allows swapping in ("заміняй на рівний/
 * сильніший з обґрунтуванням") — it needs no forward-declared plan at all (there
 * isn't one to read), self-updates as Dmytro's real routine drifts, and every
 * weekday clears the analog-count floor instead of only 2 of 20+ combos doing so.
 *
 * #1295 COMPATIBILITY (mandatory, #1099 constraint): the analog average is built
 * ONLY from CLOSED days strictly BEFORE the requested date — it never reads the
 * requested date's own (possibly still-open/partial) whoop_cycles document. The
 * result is therefore STABLE for the whole day, exactly like stableDayKcalBasis,
 * and does not reintroduce the "1444 at noon -> 2400 at night" bug #1295 fixed.
 */

const { getKyivIsoWeekday, addDaysToDateString } = require('./training-program')
const { goalKcalDelta, stableDayKcalBasis } = require('./nutrition-targets')

/** How far back to look for same-weekday analogs. */
const LOOKBACK_DAYS = 90
/** Minimum analog days required before trusting the weekday average at all. */
const MIN_ANALOG_DAYS = 5
/**
 * Floor for the day-type basis — the lowest FULL (closed) whoop_cycles.calories_burned
 * measured over the 28 days examined during #1099 triage (2026-08-19, see task
 * description). A day-type forecast must never imply a day burns less than the
 * worst recorded full day; this guards the "increment >= 0" contract even if a
 * future data drift ever pulled a weekday average below the historical minimum.
 */
const MIN_FULL_DAY_KCAL = 2099

/** @param {string} dateStr YYYY-MM-DD @returns {number} ISO weekday, 1=Mon..7=Sun (Kyiv calendar) */
function isoWeekdayFromDateString(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return getKyivIsoWeekday(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)))
}

/**
 * Average FULL-day (closed-cycle) calories_burned for every day in the lookback
 * window sharing `date`'s ISO weekday, strictly BEFORE `date`.
 *
 * Filtering (closed/`end` present, matching weekday, finite calories) is done in
 * JS after a single date-ranged fetch, not via extra Mongo query operators — the
 * date range keeps the fetch small (~90 docs) and this shape stays trivially
 * testable against a plain array-returning DB stub.
 *
 * @param {object} db Mongo db handle
 * @param {string} date YYYY-MM-DD (Kyiv-day convention used everywhere in this API)
 * @returns {Promise<number|null>} rounded avg kcal, or null if fewer than
 *   MIN_ANALOG_DAYS qualifying analogs exist
 */
async function resolveWeekdayAnalogFullDayKcal(db, date) {
  const targetWeekday = isoWeekdayFromDateString(date)
  const cutoff = addDaysToDateString(date, -LOOKBACK_DAYS)
  const cycles = await db
    .collection('whoop_cycles')
    .find({ date: { $gte: cutoff, $lt: date } })
    .toArray()

  const analogs = cycles.filter(
    (c) =>
      c &&
      c.end != null &&
      Number.isFinite(c.calories_burned) &&
      typeof c.date === 'string' &&
      isoWeekdayFromDateString(c.date) === targetWeekday
  )
  if (analogs.length < MIN_ANALOG_DAYS) return null

  const avg = analogs.reduce((sum, c) => sum + c.calories_burned, 0) / analogs.length
  return Math.round(avg)
}

/**
 * THE day-type-aware calorie basis (#1099) — the async, DB-touching sibling of
 * `stableDayKcalBasis`. Every consumer that needs "the day's kcal basis" (daily
 * recommendations, nutrition summary, /api/targets, and the new /week endpoint)
 * MUST call this instead of the bare sync function, so the SAME weekday-aware
 * number reaches every surface (BASE RULE: one metric, one definition).
 *
 * Guards, in order:
 *   1. An explicit `profile.daily_kcal_goal` is an outright owner override (same
 *      semantics as `stableDayKcalBasis` itself, #1295) — the analog never
 *      second-guesses a number Dmytro typed himself, and the DB is not even
 *      queried in that case.
 *   2. Fewer than MIN_ANALOG_DAYS same-weekday analogs -> no bump, plain
 *      `stableDayKcalBasis(profile)`.
 *   3. Otherwise the day-type basis is `max(derivedBasis, weekdayAnalog + goalDelta)`,
 *      floored at MIN_FULL_DAY_KCAL — a day-type day can only ADD to the stable
 *      basis, never subtract below it (increment >= 0, #1099 acceptance).
 *
 * @param {object} db Mongo db handle
 * @param {object} [profile] personal_profile document (may be null)
 * @param {string} date YYYY-MM-DD (Kyiv-day convention)
 * @returns {Promise<number>} kcal, rounded
 */
async function resolveDayTypeAwareKcalBasis(db, profile, date) {
  const derivedBasis = stableDayKcalBasis(profile)
  if (profile?.daily_kcal_goal) return derivedBasis

  const weekdayAnalogKcal = await resolveWeekdayAnalogFullDayKcal(db, date)
  if (weekdayAnalogKcal == null) return derivedBasis

  const dayTypeBasis = Math.max(MIN_FULL_DAY_KCAL, Math.round(weekdayAnalogKcal + goalKcalDelta(profile)))
  return Math.max(derivedBasis, dayTypeBasis)
}

module.exports = {
  LOOKBACK_DAYS,
  MIN_ANALOG_DAYS,
  MIN_FULL_DAY_KCAL,
  isoWeekdayFromDateString,
  resolveWeekdayAnalogFullDayKcal,
  resolveDayTypeAwareKcalBasis,
}
