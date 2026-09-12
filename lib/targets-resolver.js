/**
 * THE single day-level target resolver (#1295).
 *
 * BASE RULE (contexts/dashboards.md): one metric = one definition = one source.
 * Before #1295 the calorie/TDEE/protein/water/weight goals each lived in up to 4
 * places (personal_profile, user_settings, the `goals` collection, hardcoded JSX
 * constants) and disagreed by up to 24% on the same day. This module is the ONE
 * place that turns `personal_profile` (+ the day's weight/WHOOP data) into every
 * goal number the API exposes. Every route that needs "the day's target" calls
 * `resolveDayTargets(db, date)` — no route re-derives any of this math locally.
 *
 * Math for kcal/protein/sat-fat/sugar/fiber lives in lib/nutrition-targets.js
 * (unchanged by #1295 — see that module for the per-field sourcing story). This
 * module adds the two pieces nutrition-targets.js does not own (water, weight
 * goal) and assembles the full per-day contract GET /api/targets returns.
 */

const {
  resolveTdeeKcal,
  resolveDeficitKcal,
  resolveGoalMode,
  stableDayKcalBasis,
  satFatLimitG,
  sugarLimitG,
  fiberGoalG,
  resolveProteinGoalG,
  resolveWeightKg,
} = require('./nutrition-targets')
const { calcWaterGoal } = require('../notify')

/**
 * Macro split for carbs/fat as a % of the day's kcal target.
 *
 * Copied verbatim from routes/recommendations.js (pre-#1295) — the SAME two
 * constants that file already used to derive targetCarbs/targetFat from
 * targetCalories. #1295's scope is CONSOLIDATING the source, not revising the
 * split method itself (that is #965/#966, explicitly owner-deferred — see the
 * #1295 ticket "Обмеження").
 */
const CARB_PCT_OF_KCAL = 0.407
const FAT_PCT_OF_KCAL = 0.266
const KCAL_PER_G_CARB = 4
const KCAL_PER_G_FAT = 9

/**
 * Canonical weight-goal fallback (owner default, #1295 triage 2026-09-12).
 *
 * `personal_profile.weight_goal_kg`/`weight_goal_date` is the canon (it already
 * drives every kcal/protein calc via the SAME document) — these two constants
 * are ONLY the fallback for a profile that has neither field set. Before #1295
 * this fallback was duplicated as a raw `96` literal in personal_profile.js and
 * disagreed with the live profile document (90/2026-10-15) and the separate
 * `goals` collection (96/2026-10-31) — three numbers for one goal. If Dmytro
 * picks a different number before qa_review, this is the ONE constant to change.
 */
const DEFAULT_WEIGHT_GOAL_KG = 90
const DEFAULT_WEIGHT_GOAL_DATE = '2026-10-15'

/**
 * Resolve the weight-loss target (kg + deadline), honouring an explicit profile
 * value and falling back to the owner default above.
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {{weight_goal_kg: number, weight_goal_date: string}}
 */
function resolveWeightGoal(profile) {
  const kg = Number(profile?.weight_goal_kg)
  return {
    weight_goal_kg: Number.isFinite(kg) && kg > 0 ? kg : DEFAULT_WEIGHT_GOAL_KG,
    weight_goal_date: profile?.weight_goal_date || DEFAULT_WEIGHT_GOAL_DATE,
  }
}

/**
 * Derive carbs/fat targets (grams) from an already-resolved day kcal target.
 *
 * PURE function, no DB — extracted so a route that already computes its OWN
 * kcal basis (e.g. routes/nutrition.js summaryHandler, which must NOT gain a
 * new `whoop_cycles` dependency — see its route-level test's collection
 * allowlist) can still share this exact macro-split math instead of
 * re-declaring the two percentage constants a second time.
 *
 * @param {number} kcal the day's calorie target (e.g. stableDayKcalBasis(profile))
 * @returns {{carbs_g: number, fat_g: number}}
 */
function deriveCarbsFatFromKcal(kcal) {
  return {
    carbs_g: Math.round((kcal * CARB_PCT_OF_KCAL) / KCAL_PER_G_CARB),
    fat_g: Math.round((kcal * FAT_PCT_OF_KCAL) / KCAL_PER_G_FAT),
  }
}

/**
 * Resolve the water goal (ml) for a given day.
 *
 * Delegates to notify.js's calcWaterGoal — the SAME formula routes/water.js
 * already uses for `/api/water/today` (this was already single-sourced; #1295
 * only makes the OTHER targets share the discipline this one already had).
 * `weightKg` falsy (no weight data anywhere) -> calcWaterGoal's own 2500 ml
 * fallback, which matches personal_profile's own default `water_goal_ml`.
 *
 * @param {number} weightKg resolved body weight (see resolveWeightKg), 0 if unknown
 * @param {number} [strain] whoop_cycles.strain for the day, 0 if unknown/no cycle
 * @returns {number} ml
 */
function resolveWaterGoalMl(weightKg, strain) {
  return calcWaterGoal(weightKg || null, Number(strain) || 0)
}

/**
 * THE single resolver for every day-level health/nutrition target (#1295).
 *
 * One DB round-trip per input (profile, latest weight, the day's WHOOP cycle),
 * then pure math shared with every consumer. Every field here is STABLE for the
 * whole day — none of them read a live/partial WHOOP burn (that was the root
 * cause of the calorie ceiling swinging 1444 -> 2400 across one day, #1295).
 *
 * @param {object} db Mongo db handle (getDB())
 * @param {string} date YYYY-MM-DD (Kyiv-day convention used everywhere else in this API)
 * @returns {Promise<object>} the full targets contract (see routes/targets.js)
 */
async function resolveDayTargets(db, date) {
  const [profile, latestWeightEntry, whoopCycle] = await Promise.all([
    db.collection('personal_profile').findOne({ _type: 'profile' }),
    // Same convention as every other route in this API (recommendations.js,
    // nutrition.js, goals.js, personal_profile.js): the LATEST weight_log entry
    // overall, not the latest as-of `date`. Preserved as-is — #1295 consolidates
    // the SOURCE of the target math, not this pre-existing (and unrelated)
    // "which weight entry" convention.
    db.collection('weight_log').findOne({}, { sort: { date: -1 } }),
    db.collection('whoop_cycles').findOne({ date }),
  ])
  const p = profile || {}
  const weightKg = resolveWeightKg(p, latestWeightEntry?.weight_kg)
  const kcal = stableDayKcalBasis(p)
  const proteinG = resolveProteinGoalG(p, weightKg) || 150 // last-resort guard: no weight data anywhere
  const { carbs_g: carbsG, fat_g: fatG } = deriveCarbsFatFromKcal(kcal)
  const { weight_goal_kg, weight_goal_date } = resolveWeightGoal(p)

  return {
    date,
    tdee_kcal: resolveTdeeKcal(p),
    deficit_kcal: resolveDeficitKcal(p),
    goal_mode: resolveGoalMode(p),
    kcal,
    protein_g: proteinG,
    carbs_g: carbsG,
    fat_g: fatG,
    sat_fat_g: satFatLimitG(kcal),
    sugar_g: sugarLimitG(kcal),
    fiber_g: fiberGoalG(kcal),
    water_ml: resolveWaterGoalMl(weightKg, whoopCycle?.strain),
    weight_kg: weightKg || null,
    weight_goal_kg,
    weight_goal_date,
  }
}

module.exports = {
  resolveDayTargets,
  resolveWeightGoal,
  resolveWaterGoalMl,
  deriveCarbsFatFromKcal,
  DEFAULT_WEIGHT_GOAL_KG,
  DEFAULT_WEIGHT_GOAL_DATE,
  CARB_PCT_OF_KCAL,
  FAT_PCT_OF_KCAL,
}
