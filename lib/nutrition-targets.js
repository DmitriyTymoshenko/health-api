/**
 * Shared nutrition target math — ONE definition, used by every route that needs it.
 *
 * BASE RULE (contexts/dashboards.md): one metric = one definition = one source.
 * Both routes/nutrition.js (GET /summary) and routes/recommendations.js need the
 * day's calorie target and the saturated-fat limit; they MUST NOT re-derive it.
 */

/** Saturated fat must stay at or below this share of daily calories (Koliada course 04.01/04.04). */
const SAT_FAT_KCAL_SHARE = 0.1
/** Kilocalories per gram of fat. */
const KCAL_PER_G_FAT = 9

/**
 * Resolve the day's CALORIE TARGET.
 *
 * Priority: WHOOP burn (if a real cycle exists) − deficit, else profile goal,
 * else TDEE − deficit, else the historical default (2429 − 500).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @param {number} [caloriesBurned] whoop_cycles.calories_burned for the day
 * @returns {number} kcal target, rounded
 */
function resolveDayKcalTarget(profile, caloriesBurned) {
  const tdee = profile?.tdee_kcal || 2429
  const deficit = profile?.deficit_kcal || 500
  // A WHOOP cycle still filling up early in the day reports an unusably low burn,
  // so only trust it once it passes basal-metabolism scale.
  if (caloriesBurned && caloriesBurned > 1200) {
    return Math.round(caloriesBurned - deficit)
  }
  return Math.round(profile?.daily_kcal_goal || tdee - deficit)
}

/**
 * Saturated-fat DAILY LIMIT in grams.
 *
 * Derived from the day's calorie TARGET, never from calories consumed so far:
 * a consumed-based limit moves through the day, so eggs at breakfast
 * (250 kcal → limit 2.8 g) would render "3 / 2.8 g → DANGER" — a false alarm
 * that resolves itself by lunch. The target basis is stable for the whole day.
 *
 * @param {number} targetKcal day calorie target
 * @returns {number} grams, rounded to a whole number
 */
function satFatLimitG(targetKcal) {
  const kcal = Number(targetKcal)
  if (!Number.isFinite(kcal) || kcal <= 0) return 0
  return Math.round((kcal * SAT_FAT_KCAL_SHARE) / KCAL_PER_G_FAT)
}

/**
 * Status of saturated-fat intake against the limit.
 * @param {number} consumedG
 * @param {number} limitG
 * @returns {'ok'|'warning'|'danger'} ≥100% danger · 80–100% warning · else ok
 */
function satFatStatus(consumedG, limitG) {
  if (!limitG || limitG <= 0) return 'ok'
  const pct = (Number(consumedG) || 0) / limitG
  if (pct >= 1) return 'danger'
  if (pct >= 0.8) return 'warning'
  return 'ok'
}

module.exports = {
  SAT_FAT_KCAL_SHARE,
  KCAL_PER_G_FAT,
  resolveDayKcalTarget,
  satFatLimitG,
  satFatStatus,
}
