'use strict'

/**
 * WHOOP-forecast-aware kcal basis (#1504) — the layer ABOVE resolveDayTypeAwareKcalBasis.
 *
 * PROBLEM (Lisa queue #6567, 2026-09-25, Dmytro via Lisa): the #1099 day-type-average
 * basis is a WEEKDAY ANALOG — it never looks at today's own WHOOP cycle, by design
 * (#1295 compatibility). On 25.09 (Fri) that gave a target of 2979-500=2479 kcal ALL
 * DAY, even after the 19:23 sync showed the actual cycle at 2038 kcal (both workouts
 * already done) — a ~450 kcal gap Dmytro noticed by comparing his own arithmetic
 * ("з'їм 2335, спалю ~2500, дефіцит буде 200-300, не 500") against the app's number.
 * His own framing: "коли вже є обідня синхронізація — треба орієнтуватись на
 * фактичний прогноз за день".
 *
 * ⚠️ THIS IS A DELIBERATE, SCOPED REVERSAL of #1295's invariant ("kcal is STABLE for
 * the whole day, never reads a live/partial WHOOP burn") — not a regression of it.
 * #1295 killed `resolveDayKcalTarget(profile, caloriesBurned)` (nutrition-targets.js)
 * because `caloriesBurned + delta` swung 1444 (noon, partial) -> 2400 (night, full) on
 * the SAME day — the partial number was being read as if it were the day's total.
 * This module does not repeat that mistake: it never treats the live partial burn as
 * the day's total. It treats it as ONE known data point and adds a FORECAST for the
 * remaining hours, so the number only moves by the size of the forecast term, not by
 * the gap between "burn so far" and "burn so far, extrapolated to a full day" done
 * naively. See resolveKcalBasisWithForecast()'s doc for the exact formula.
 *
 * WHEN THIS LAYER ENGAGES ("first sync of the day", operationalized):
 * The description frames the switch as a clock time ("до 13:23 Kyiv"), but the real
 * cron schedule has FOUR syncs/day (07:23, 09:41, 13:23, 19:23 Kyiv — crontab, #1028/
 * #1030/#1323) and a clock-time cutoff would be arbitrary (which of the four is "the"
 * first sync depends on wake time, sleep length, etc — no fixed boundary exists).
 * Instead this reuses the EXACT threshold the pre-#1295 resolveDayKcalTarget() already
 * used to decide a live cycle carries real signal ("only trust it once it passes
 * basal-metabolism scale", nutrition-targets.js): `calories_burned > 1200`. Measured
 * against 25.09's real data (whoop_cycles + whoop_workouts, see task #1504 closing
 * comment): the cycle is normally still under this floor through the 07:23/09:41
 * crons (mostly sleep + at most one short morning workout), and clears it once the
 * day's real activity has accumulated — which is what "до 13:23 fallback, після —
 * forecast" was actually describing in Dmytro's own words, just not tied to a
 * specific clock minute. This degrades gracefully: whichever cron happens to be the
 * one that pushes the cycle over 1200 kcal is "the first sync that matters" for THIS
 * cycle, no hardcoded time needed.
 *
 * DAY-BOUNDARY HANDLING (Apex triage #1504, acceptance point 4): this module
 * deliberately does NOT derive any elapsed-time math from `whoop_cycles.start`. The
 * persona lesson from #825/#1324 stands: WHOOP cycle-start times cluster within
 * *minutes* of local midnight in EITHER direction with no safe constant offset — using
 * it to compute "hours elapsed in the Kyiv day" would silently mis-attribute a chunk of
 * the partial burn. Instead: `cycle.calories_burned` is taken as-is (whatever the cycle
 * has actually recorded, regardless of exactly when in the last ~24h it happened), and
 * only the REMAINING hours of the *Kyiv calendar day* (now -> next Kyiv midnight, via
 * wall-clock `now`, never `cycle.start`/`cycle.end`) are forecast forward. This is a
 * deliberate simplification: it does not need to know precisely which hours the
 * partial burn covers, only how many hours of today are left to add more.
 */

const { formatDateKyiv } = require('./training-program')
const { resolveDayTypeAwareKcalBasis } = require('./day-type-kcal')
const { resolveTdeeKcal, goalKcalDelta } = require('./nutrition-targets')

/**
 * Same threshold pre-#1295 resolveDayKcalTarget() (lib/nutrition-targets.js) used to
 * decide a live WHOOP burn carries real signal ("once it passes basal-metabolism
 * scale") — reused here by VALUE, not re-invented, and not by calling that superseded
 * function (which stays uncalled-by-new-code per its own doc comment). See the file
 * doc comment above for how this operationalizes "first sync of the day".
 */
const MIN_TRUSTED_PARTIAL_BURN_KCAL = 1200

/**
 * #1492 convention (habits/lisa.md, low-stock/reminders digest task): a walk does not
 * count as "the planned workout happened" — reused here for the SAME reason: a casual
 * walk logged by WHOOP must not silently cancel a planned gym/box/tennis session's
 * expected calorie addition.
 */
const NON_WORKOUT_SPORT_NAME = 'walking'

/**
 * Hours elapsed since Kyiv midnight, fractional (e.g. 19:23:00 -> 19.383).
 * Wall-clock only — never derived from any WHOOP timestamp (see file doc comment).
 *
 * @param {Date} now
 * @returns {number} hours, 0 <= h < 24
 */
function kyivHoursSinceMidnight(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0)
  return get('hour') + get('minute') / 60 + get('second') / 3600
}

/**
 * Expected kcal addition from a planned-but-not-yet-happened workout today (Apex
 * triage #1504, acceptance point 5). Source is `activity_plans` (routes/activity_plan.js)
 * — per Apex's explicit triage instruction, NOT `habits/lisa.md` prose (measured
 * 2026-09-21, #1099: the collection is empty in production today, so this is a
 * no-op most of the time — implemented anyway per instruction, and it is the ONLY
 * live, queryable plan source this API has).
 *
 * "Already happened" = at least one `whoop_workouts` row for the date that is NOT a
 * walk (#1492 convention above) — if the real workout is already in the cycle, its
 * calories are already inside `cycle.calories_burned` and adding the plan's estimate
 * again would double-count it. No attempt to match plan `type` to WHOOP `sport_name`
 * one-to-one (activity_plans carries free-text `type`/`name`, WHOOP an enumerated
 * `sport_name` — no reliable mapping exists with zero live data to derive one from);
 * ANY non-walk workout today is treated as "today's planned activity, done".
 *
 * @param {object} db Mongo db handle
 * @param {string} date YYYY-MM-DD (Kyiv-day convention)
 * @returns {Promise<number>} kcal, >= 0
 */
async function resolvePlannedWorkoutAdditionKcal(db, date) {
  const plans = await db.collection('activity_plans').find({ date, done: false }).toArray()
  if (!plans || plans.length === 0) return 0

  const workoutsToday = await db.collection('whoop_workouts').find({ date }).toArray()
  const hasRealWorkoutToday = (workoutsToday || []).some((w) => w.sport_name !== NON_WORKOUT_SPORT_NAME)
  if (hasRealWorkoutToday) return 0

  return plans.reduce((sum, p) => sum + (Number(p.calories_est) || 0), 0)
}

/**
 * THE forecast-aware kcal basis (#1504) — sits ABOVE resolveDayTypeAwareKcalBasis
 * (#1099), which sits above stableDayKcalBasis (#1295). Every consumer that used to
 * call `resolveDayTypeAwareKcalBasis` directly for "today's kcal number" MUST call
 * this instead (lib/targets-resolver.js AND routes/nutrition.js summaryHandler — see
 * task #1504 closing comment for the full consumer list), so a Wednesday's number
 * cannot disagree between /api/recommendations and /api/nutrition/summary (BASE RULE).
 *
 * Guards, in order:
 *   1. An explicit `profile.daily_kcal_goal` override — same as #1099's own guard 1,
 *      untouched: an owner-typed number is never second-guessed by a forecast either.
 *   2. No `whoop_cycles` doc for `date`, or its `calories_burned` is not yet above
 *      MIN_TRUSTED_PARTIAL_BURN_KCAL -> `day_type_avg` (the existing #1099 basis,
 *      UNCHANGED — this is the "before first sync" fallback).
 *   3. Otherwise -> `whoop_forecast`:
 *      - PAST day, or TODAY once the cycle has CLOSED (`cycle.end != null`): the
 *        cycle's own total IS the day's actual burn — `kcal = calories_burned +
 *        goalKcalDelta(profile)`. This is Apex triage #1504's default "past days"
 *        rule, and it falls out of the SAME formula below with hoursRemaining=0,
 *        not a separate branch (no copy of the math).
 *      - TODAY, cycle still OPEN: `kcal = calories_burned
 *          + (resolveTdeeKcal(profile) / 24) * hoursRemainingInKyivDay(now)
 *          + resolvePlannedWorkoutAdditionKcal(db, date)
 *          + goalKcalDelta(profile)`.
 *        The remaining-hours rate is TDEE/24 (a flat "typical hour" baseline), NOT
 *        `calories_burned so far / hours so far` — the average-so-far rate is
 *        inflated by any workout(s) already completed today and would overstate the
 *        REST of the day, which is usually far closer to resting metabolism than to
 *        the day's average. TDEE already represents "typical whole-day expenditure
 *        including typical activity", the closest existing named number to a
 *        rest-of-day baseline (Apex triage #1504: "profile BMR / rest-day basis ÷
 *        24" — TDEE is the rest-day basis already used everywhere else in this app).
 *
 * @param {object} db Mongo db handle (getDB())
 * @param {object} [profile] personal_profile document (may be null)
 * @param {string} date YYYY-MM-DD (Kyiv-day convention used everywhere else in this API)
 * @param {object} [opts]
 * @param {Date} [opts.now] injectable "now" for tests — real callers never pass this
 * @param {object|null} [opts.cycle] the date's whoop_cycles doc, if the caller already
 *   fetched it (lib/targets-resolver.js does, for `water_ml`'s strain) — avoids a
 *   second identical `findOne({date})` round trip. Omit to let this function fetch it.
 * @returns {Promise<{kcal: number, basis: 'day_type_avg'|'whoop_forecast'}>}
 */
async function resolveKcalBasisWithForecast(db, profile, date, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date()

  if (profile?.daily_kcal_goal) {
    return { kcal: await resolveDayTypeAwareKcalBasis(db, profile, date), basis: 'day_type_avg' }
  }

  const cycle = 'cycle' in opts ? opts.cycle : await db.collection('whoop_cycles').findOne({ date })
  const forecastable =
    cycle && Number.isFinite(cycle.calories_burned) && cycle.calories_burned > MIN_TRUSTED_PARTIAL_BURN_KCAL

  if (!forecastable) {
    return { kcal: await resolveDayTypeAwareKcalBasis(db, profile, date), basis: 'day_type_avg' }
  }

  const isOpenToday = cycle.end == null && date === formatDateKyiv(now)

  let projectedBurn = cycle.calories_burned
  if (isOpenToday) {
    const hoursRemaining = Math.max(0, 24 - kyivHoursSinceMidnight(now))
    const hourlyRate = resolveTdeeKcal(profile) / 24
    const plannedAddition = await resolvePlannedWorkoutAdditionKcal(db, date)
    projectedBurn += hourlyRate * hoursRemaining + plannedAddition
  }

  return { kcal: Math.round(projectedBurn + goalKcalDelta(profile)), basis: 'whoop_forecast' }
}

module.exports = {
  MIN_TRUSTED_PARTIAL_BURN_KCAL,
  NON_WORKOUT_SPORT_NAME,
  kyivHoursSinceMidnight,
  resolvePlannedWorkoutAdditionKcal,
  resolveKcalBasisWithForecast,
}
