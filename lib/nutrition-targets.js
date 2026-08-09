/**
 * Shared nutrition target math — ONE definition, used by every route that needs it.
 *
 * BASE RULE (contexts/dashboards.md): one metric = one definition = one source.
 * Both routes/nutrition.js (GET /summary) and routes/recommendations.js need the
 * day's calorie target, the saturated-fat limit and the sugar limit; they MUST NOT
 * re-derive any of them.
 */

/** Saturated fat must stay at or below this share of daily calories (Koliada course 04.01/04.04). */
const SAT_FAT_KCAL_SHARE = 0.1
/** Kilocalories per gram of fat. */
const KCAL_PER_G_FAT = 9

/**
 * Free sugars must stay at or below this share of daily calories (WHO: ≤10% of energy).
 *
 * DELIBERATELY a constant of its own, even though it currently equals
 * SAT_FAT_KCAL_SHARE: the two shares come from DIFFERENT sources (WHO free-sugar
 * guidance vs the Koliada course's saturated-fat norm) and the 0.1 match is a
 * coincidence. One shared constant would mean revising one norm silently moves the
 * other metric's ceiling.
 */
const SUGAR_KCAL_SHARE = 0.1
/** Kilocalories per gram of carbohydrate (sugar is a carbohydrate). */
const KCAL_PER_G_CARB = 4

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
 * Calorie basis for every DAILY CEILING (saturated fat, sugar) — deliberately NOT
 * resolveDayKcalTarget().
 *
 * Renamed from satFatLimitBasisKcal on 2026-08-09 (#953): the basis is now shared by
 * two metrics, so a sat-fat-specific name had become misleading. Behaviour unchanged.
 *
 * A ceiling must be one number for the whole day. Two bases move during the day
 * and both produce false alarms:
 *   - calories CONSUMED: eggs at breakfast (250 kcal -> 2.8 g) render "3 / 2.8 g DANGER";
 *   - WHOOP calories BURNED so far: measured live on 2026-08-07 at 12:07 the cycle
 *     read 1579 kcal (day only half over) -> target 1079 -> a 12 g ceiling, while the
 *     completed previous day gave 21 g. The limit would shrink every morning and grow
 *     every evening, and /health's Today page (which projects burn to end-of-day)
 *     would disagree with /summary — one metric, two numbers.
 * So every ceiling uses the STABLE profile target only.
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {number} kcal basis, stable for the whole day
 */
function stableDayKcalBasis(profile) {
  const tdee = profile?.tdee_kcal || 2429
  const deficit = profile?.deficit_kcal || 500
  return Math.round(profile?.daily_kcal_goal || tdee - deficit)
}

/**
 * Saturated-fat DAILY LIMIT in grams.
 *
 * Feed it stableDayKcalBasis(profile) — see that function for why the basis must
 * be the stable profile target and not a live/consumed figure.
 *
 * @param {number} targetKcal day calorie basis
 * @returns {number} grams, rounded to a whole number
 */
function satFatLimitG(targetKcal) {
  const kcal = Number(targetKcal)
  if (!Number.isFinite(kcal) || kcal <= 0) return 0
  return Math.round((kcal * SAT_FAT_KCAL_SHARE) / KCAL_PER_G_FAT)
}

/**
 * Sugar DAILY LIMIT in grams (WHO ≤10% of energy, 4 kcal/g).
 *
 * Feed it stableDayKcalBasis(profile) — the same basis the saturated-fat ceiling
 * uses, so the two ceilings can never be computed from two different day targets.
 *
 * @param {number} targetKcal day calorie basis
 * @returns {number} grams, rounded to a whole number
 */
function sugarLimitG(targetKcal) {
  const kcal = Number(targetKcal)
  if (!Number.isFinite(kcal) || kcal <= 0) return 0
  return Math.round((kcal * SUGAR_KCAL_SHARE) / KCAL_PER_G_CARB)
}

/**
 * Shared threshold ladder for every "consumed vs daily ceiling" status.
 *
 * ONE definition on purpose: sat-fat and sugar sit next to each other on the same
 * screen, so two copies of these numbers would eventually drift and the same %
 * would render two different colours (BASE RULE: one metric = one definition).
 *
 * @param {number} consumedG
 * @param {number} limitG
 * @returns {'ok'|'warning'|'danger'} ≥100% danger · 80–100% warning · else ok
 */
function limitStatus(consumedG, limitG) {
  if (!limitG || limitG <= 0) return 'ok'
  const pct = (Number(consumedG) || 0) / limitG
  if (pct >= 1) return 'danger'
  if (pct >= 0.8) return 'warning'
  return 'ok'
}

/**
 * Status of saturated-fat intake against the limit.
 * @param {number} consumedG
 * @param {number} limitG
 * @returns {'ok'|'warning'|'danger'} ≥100% danger · 80–100% warning · else ok
 */
function satFatStatus(consumedG, limitG) {
  return limitStatus(consumedG, limitG)
}

/**
 * Status of sugar intake against the limit — same ladder as saturated fat.
 * @param {number} consumedG
 * @param {number} limitG
 * @returns {'ok'|'warning'|'danger'} ≥100% danger · 80–100% warning · else ok
 */
function sugarStatus(consumedG, limitG) {
  return limitStatus(consumedG, limitG)
}

module.exports = {
  SAT_FAT_KCAL_SHARE,
  KCAL_PER_G_FAT,
  SUGAR_KCAL_SHARE,
  KCAL_PER_G_CARB,
  resolveDayKcalTarget,
  stableDayKcalBasis,
  satFatLimitG,
  satFatStatus,
  sugarLimitG,
  sugarStatus,
}
