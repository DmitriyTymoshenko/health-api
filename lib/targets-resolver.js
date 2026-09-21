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
  satFatLimitG,
  resolveSugarLimitG,
  resolveFiberGoalG,
  resolveProteinGoalG,
  resolveWeightKg,
  proteinGoalRangeG,
  fatGoalRangeG,
  fatGoalG,
  KCAL_PER_G_PROTEIN,
  KCAL_PER_G_FAT,
  KCAL_PER_G_CARB,
} = require('./nutrition-targets')
const { calcWaterGoal } = require('../notify')
// #1099 — day-type-aware kcal basis (weekday-recurring-pattern analog). The ONLY
// call site for `kcal` below; see lib/day-type-kcal.js for the full design note.
const { resolveDayTypeAwareKcalBasis } = require('./day-type-kcal')

/**
 * Last-resort guards — mirror the pre-existing `resolveProteinGoalG(...) || 150`
 * pattern (protein) for the new fat point, so "no weight data anywhere" degrades
 * to a sane fixed number instead of a 0 g point poisoning the carbs residual.
 * 65 g matches the live pre-#1396 fat_g (26.6% of the default 1929 kcal basis),
 * so the guard does not introduce a new number, only a documented fallback for
 * an edge case (empty weight_log AND no profile.weight_goal_kg) that #1396 does
 * not otherwise change.
 */
const FALLBACK_PROTEIN_POINT_G = 150
const FALLBACK_FAT_POINT_G = 65

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
 * Residual carbs grams: whatever the kcal target has left after protein and
 * fat grams are accounted for (#1396 — carbs is the ONLY macro with no
 * independent g/kg rule; it is defined as what remains).
 *
 * Rounding contract (F11, Apex triage #1396): `proteinG`/`fatG` MUST already be
 * ROUNDED integers (from proteinGoalG/fatGoalG/proteinGoalRangeG/fatGoalRangeG)
 * — this function does not round its inputs, only its own result. Computing
 * the residual from the RAW g/kg coefficients instead of the already-rounded
 * grams changes the result by 1 g at the reference point (92.9 kg / 2201 kcal:
 * carbs_max 235 g from rounded 149/74, vs 234 g from raw 148.64/74.32) — always
 * round protein/fat FIRST, then derive carbs from those rounded grams.
 *
 * @param {number} kcal the day's calorie target (e.g. stableDayKcalBasis(profile))
 * @param {number} proteinG already-rounded protein grams for this combination
 * @param {number} fatG already-rounded fat grams for this combination
 * @returns {number} grams, rounded, floored at 0 (a very low kcal target combined
 *   with the protein/fat MAX combination could otherwise go negative)
 */
function carbsResidualG(kcal, proteinG, fatG) {
  const value = (Number(kcal) - proteinG * KCAL_PER_G_PROTEIN - fatG * KCAL_PER_G_FAT) / KCAL_PER_G_CARB
  return Math.max(0, Math.round(value))
}

/**
 * THE single derivation of protein/fat/carbs RANGES + POINTS for a day
 * (#1396 — owner decision 2026-09-16: protein 1.6-2.4 g/kg, fat 0.8-1.0 g/kg,
 * carbs residual from the POINT values). PURE function, no DB — extracted so a
 * route that already computes its OWN kcal basis (e.g. routes/nutrition.js
 * summaryHandler, which must NOT gain a new `whoop_cycles` dependency — see its
 * route-level test's collection allowlist) can still share this exact macro
 * math instead of re-deriving it.
 *
 * Point = the midpoint of each g/kg range, for EVERY goal mode (owner decision,
 * supersedes #966's per-mode protein matrix). `weightKg` drives min/max/point
 * for BOTH macros; `profile` is consulted ONLY for the protein POINT's explicit
 * override (`daily_protein_goal_g`) — min/max are ALWAYS weight-derived, never
 * touched by that override (Apex triage #1396, design decision 2).
 *
 * carbs_max_g pairs with the LOWEST protein+fat combination (P_min, F_min) —
 * the most carbs are left over when protein/fat are at their floor. carbs_min_g
 * pairs with the HIGHEST combination (P_max, F_max) symmetrically.
 *
 * @param {number} kcal the day's calorie target (stableDayKcalBasis(profile))
 * @param {number} weightKg resolved body weight (resolveWeightKg), 0 if unknown
 * @param {object} [profile] personal_profile document — protein override only
 * @returns {{protein_min_g,protein_max_g,protein_point_g,fat_min_g,fat_max_g,
 *   fat_point_g,carbs_min_g,carbs_max_g,carbs_point_g}}
 */
function deriveMacroRangesG(kcal, weightKg, profile) {
  const proteinRange = proteinGoalRangeG(weightKg)
  const fatRange = fatGoalRangeG(weightKg)
  const proteinPoint = resolveProteinGoalG(profile, weightKg) || FALLBACK_PROTEIN_POINT_G
  const fatPoint = fatGoalG(weightKg) || FALLBACK_FAT_POINT_G

  return {
    protein_min_g: proteinRange.min,
    protein_max_g: proteinRange.max,
    protein_point_g: proteinPoint,
    fat_min_g: fatRange.min,
    fat_max_g: fatRange.max,
    fat_point_g: fatPoint,
    carbs_point_g: carbsResidualG(kcal, proteinPoint, fatPoint),
    carbs_max_g: carbsResidualG(kcal, proteinRange.min, fatRange.min),
    carbs_min_g: carbsResidualG(kcal, proteinRange.max, fatRange.max),
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
  // #1099 — day-type-aware basis (weekday-recurring analog on top of the #1295
  // stable basis), NOT the bare stableDayKcalBasis(p) this used to call directly.
  const kcal = await resolveDayTypeAwareKcalBasis(db, p, date)
  // #1396 — protein/fat as weight-derived RANGES + a midpoint POINT, carbs as the
  // residual. protein_g/carbs_g/fat_g below KEEP their pre-existing names and
  // values (the point) for backward compatibility; *_min_g/*_max_g are new
  // siblings (Apex triage #1396, field-naming decision 4).
  const macros = deriveMacroRangesG(kcal, weightKg, p)
  const { weight_goal_kg, weight_goal_date } = resolveWeightGoal(p)

  return {
    date,
    tdee_kcal: resolveTdeeKcal(p),
    deficit_kcal: resolveDeficitKcal(p),
    goal_mode: resolveGoalMode(p),
    kcal,
    protein_g: macros.protein_point_g,
    protein_min_g: macros.protein_min_g,
    protein_max_g: macros.protein_max_g,
    carbs_g: macros.carbs_point_g,
    carbs_min_g: macros.carbs_min_g,
    carbs_max_g: macros.carbs_max_g,
    fat_g: macros.fat_point_g,
    fat_min_g: macros.fat_min_g,
    fat_max_g: macros.fat_max_g,
    sat_fat_g: satFatLimitG(kcal),
    // #873 Частина 1: fiber/sugar now honour an explicit personal_profile
    // override (daily_fiber_goal_g / daily_sugar_goal_g), same pattern as
    // protein's daily_protein_goal_g — previously formula-only, not editable.
    sugar_g: resolveSugarLimitG(p, kcal),
    fiber_g: resolveFiberGoalG(p, kcal),
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
  carbsResidualG,
  deriveMacroRangesG,
  DEFAULT_WEIGHT_GOAL_KG,
  DEFAULT_WEIGHT_GOAL_DATE,
}
