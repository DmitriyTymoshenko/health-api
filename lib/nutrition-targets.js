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

/** Historical TDEE fallback — the value personal_profile.js ships as its default. */
const DEFAULT_TDEE_KCAL = 2429
/** Historical deficit fallback — the value personal_profile.js ships as its default. */
const DEFAULT_DEFICIT_KCAL = 500

/**
 * THE canonical goal-mode field, and THE canonical deficit field (owner decision, #968).
 *
 * Goal mode lives in `personal_profile.primary_goal` — already read/written by
 * GET|PUT /api/profile and by the PersonalProfile UI tab selector. #968 only WIRES it
 * into the math; it does not rename or re-home it.
 *
 * Deficit canon is `personal_profile.deficit_kcal`, NOT `user_settings.daily_deficit_goal`:
 *   - it lives in the SAME document as primary_goal, so a future mode switch (#966)
 *     writes one document and cannot desync the goal from its magnitude;
 *   - it already feeds this module, i.e. both GET /api/nutrition/summary and
 *     /api/recommendations (BASE RULE: one metric = one definition = one source);
 *   - `user_settings.daily_deficit_goal` is a DIFFERENT quantity: routes/settings.js
 *     snapshots it per DATE into `daily_plans`, and GET /api/settings/plan?date= answers
 *     "which deficit was active on that day" — a historical plan for the weight-trend
 *     page, not the current nutrition norm.
 */
const GOAL_MODES = ['weight_loss', 'muscle_gain', 'maintenance', 'endurance']
/** Mode assumed when `primary_goal` is missing/unknown — preserves pre-#968 behaviour. */
const DEFAULT_GOAL_MODE = 'weight_loss'

/**
 * How the day's calorie base moves relative to TDEE, per goal mode.
 *
 * `dir` is a SIGN only. Magnitudes stay owner-controlled (`deficit_kcal`) — #968
 * deliberately invents NO per-mode coefficient; the full per-mode matrix is #966.
 *   -1  subtract the deficit  (today's universal behaviour, unchanged)
 *    0  base === TDEE         (definitional for "maintenance"; before #968 it was
 *                              physically unreachable, because `deficit_kcal || 500`
 *                              turned a deliberate 0 back into 500)
 *   +1  ADD a surplus         (the capability stableDayKcalBasis lacked entirely)
 *
 * `surplusPctOfTdee` is the ONLY per-mode number here, and it is sourced, not invented:
 * vault EN/00-09 System & Personal/04 Health/04.04 — Мацюпа, muscle gain = +10% of TDEE
 * (2429 × 1.1 = 2672). An explicit `profile.surplus_kcal` always wins over it.
 *
 * `endurance` keeps dir -1 — that is exactly what it does TODAY (every mode currently
 * subtracts). Whether endurance deserves its own magnitude is an open question in #966,
 * so this table preserves the status quo instead of guessing.
 */
const GOAL_KCAL_RULES = {
  weight_loss: { dir: -1 },
  endurance: { dir: -1 },
  maintenance: { dir: 0 },
  muscle_gain: { dir: 1, surplusPctOfTdee: 0.1 },
}

/**
 * TDEE for the day, with the historical fallback.
 *
 * `||` (not `??`) on purpose: a TDEE of 0 is not a meaningful value, it is missing
 * data — unlike a deficit of 0, which is a real, expressible intent (maintenance).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {number} kcal
 */
function resolveTdeeKcal(profile) {
  return Number(profile?.tdee_kcal) || DEFAULT_TDEE_KCAL
}

/**
 * The day's calorie DEFICIT magnitude (always non-negative).
 *
 * `??`, never `||` — this is defect #1 of #968: `0 || 500 === 500`, so before this fix
 * a deliberate "no deficit" was silently rewritten to 500 kcal and `maintenance` was
 * physically unreachable. `??` only falls back when the field is absent.
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {number} kcal, >= 0
 */
function resolveDeficitKcal(profile) {
  const raw = Number(profile?.deficit_kcal ?? DEFAULT_DEFICIT_KCAL)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DEFICIT_KCAL
  return raw
}

/**
 * Resolve the goal mode, normalised to a known member of GOAL_MODES.
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {'weight_loss'|'muscle_gain'|'maintenance'|'endurance'}
 */
function resolveGoalMode(profile) {
  const goal = profile?.primary_goal
  return GOAL_MODES.includes(goal) ? goal : DEFAULT_GOAL_MODE
}

/**
 * SIGNED kcal delta the goal mode applies to the day's energy baseline.
 *
 * This is the whole of #968's "sign" work: negative = cut, 0 = maintain, positive =
 * build. Every consumer that used to hardcode `- deficit` now ADDS this instead, so one
 * mode switch moves every surface at once (BASE RULE).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {number} kcal — negative for a deficit, positive for a surplus, 0 for maintenance
 */
function goalKcalDelta(profile) {
  const rule = GOAL_KCAL_RULES[resolveGoalMode(profile)] || GOAL_KCAL_RULES[DEFAULT_GOAL_MODE]
  if (rule.dir === 0) return 0
  if (rule.dir > 0) {
    const explicit = Number(profile?.surplus_kcal)
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit)
    return Math.round(resolveTdeeKcal(profile) * rule.surplusPctOfTdee)
  }
  return -resolveDeficitKcal(profile)
}

/**
 * Resolve the day's CALORIE TARGET.
 *
 * Priority: WHOOP burn (if a real cycle exists) + goal delta, else the explicit profile
 * goal, else TDEE + goal delta, else the historical default (2429 − 500).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @param {number} [caloriesBurned] whoop_cycles.calories_burned for the day
 * @returns {number} kcal target, rounded
 */
function resolveDayKcalTarget(profile, caloriesBurned) {
  const delta = goalKcalDelta(profile)
  // A WHOOP cycle still filling up early in the day reports an unusably low burn,
  // so only trust it once it passes basal-metabolism scale.
  if (caloriesBurned && caloriesBurned > 1200) {
    return Math.round(caloriesBurned + delta)
  }
  // `||` (not `??`) stays here on purpose: `daily_kcal_goal: 0` is not an expressible
  // intent (a zero-calorie day), unlike `deficit_kcal: 0`. Different field, different rule.
  return Math.round(profile?.daily_kcal_goal || resolveTdeeKcal(profile) + delta)
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
 * SIGN (#968): the basis is `TDEE + goalKcalDelta(profile)`, not `TDEE − deficit`.
 * Before #968 this function could only ever SUBTRACT, so `muscle_gain` was unreachable
 * except by typing a manual `daily_kcal_goal` — which put the mode and the number in two
 * places that could disagree. Measured on the live profile (tdee 2429): weight_loss
 * +500 deficit → 1929 (unchanged), maintenance → 2429, muscle_gain → 2672 (+10%).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {number} kcal basis, stable for the whole day
 */
function stableDayKcalBasis(profile) {
  // `||` (not `??`) on daily_kcal_goal — see resolveDayKcalTarget for why this field
  // keeps `||` while the deficit does not.
  return Math.round(profile?.daily_kcal_goal || resolveTdeeKcal(profile) + goalKcalDelta(profile))
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

/**
 * Protein target: grams per kilogram of body weight.
 *
 * DELIBERATELY its own constant, not shared with SAT_FAT_KCAL_SHARE/SUGAR_KCAL_SHARE
 * (same reasoning as those two): a weight-based coefficient and a calorie-share
 * coefficient are different quantities that happen to both be "0.1-ish scale" norms —
 * no accidental coupling.
 *
 * Source: vault EN/00-09 System & Personal/04 Health/04.01 Koliada-Nutrition-Part1 —
 * "схуднення на гіпокалорійній дієті: 1.6–2.4 г/кг зберігає м'язи". The live profile
 * (2026-08-09) is `primary_goal=weight_loss`, `deficit_kcal=500` — exactly this case.
 * 1.6 is the LOWER bound of that band (task #961 scope: fixed coefficient for the
 * current deficit/weight-loss state; per-goal-type switching (cutting/recomp/bulk/
 * maintenance) is explicitly OUT of scope — see #961 triage comment and #963).
 */
const PROTEIN_G_PER_KG = 1.6

/**
 * Fiber target: grams per 1000 kcal of the day's calorie basis.
 *
 * Source: vault EN/00-09 System & Personal/04 Health/04.02 Koliada-Nutrition-Part2 —
 * USDA/WHO "Fiber: 14 g per 1000 kcal".
 */
const FIBER_G_PER_1000_KCAL = 14

/**
 * Protein DAILY GOAL in grams (auto-calculated from body weight).
 *
 * Feed it a resolved weight in kg (see resolveWeightKg) — this function does no
 * fallback of its own beyond degrading to 0 on bad input, same defensive pattern as
 * satFatLimitG/sugarLimitG.
 *
 * @param {number} weightKg
 * @returns {number} grams, rounded to a whole number
 */
function proteinGoalG(weightKg) {
  const kg = Number(weightKg)
  if (!Number.isFinite(kg) || kg <= 0) return 0
  return Math.round(kg * PROTEIN_G_PER_KG)
}

/**
 * Resolves the AUTO-CALCULATED protein goal, honouring an explicit owner override.
 *
 * Priority: `profile.daily_protein_goal_g` (explicit number the owner typed via
 * PUT /api/profile) wins outright; otherwise proteinGoalG(weightKg). Mirrors the
 * override-then-fallback shape of resolveDayKcalTarget (`daily_kcal_goal` wins over
 * tdee-deficit) — SINGLE SOURCE for every caller that needs "the" protein goal
 * (routes/nutrition.js summary endpoint AND its Telegram digest use this, not two
 * separate override checks).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @param {number} weightKg resolved body weight (see resolveWeightKg)
 * @returns {number} grams, rounded to a whole number
 */
function resolveProteinGoalG(profile, weightKg) {
  const explicit = Number(profile?.daily_protein_goal_g)
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit)
  return proteinGoalG(weightKg)
}

/**
 * Resolves the body weight (kg) used for the protein goal.
 *
 * Priority: latest `weight_log` entry (the actual measured weight) → an explicit
 * `profile.weight_goal_kg` (target weight, used only when no measurement exists at
 * all — e.g. a brand-new profile) → 0 (caller must treat 0 as "incomplete").
 *
 * STABILITY: like stableDayKcalBasis, this must be one number for the whole day.
 * It naturally is — `weight_log` holds at most one entry per date and does not
 * change based on time-of-day the way a live WHOOP burn does, so calling this
 * repeatedly through the day with the same inputs always returns the same value
 * (there is no clock read inside this function at all).
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @param {number} [latestWeightKg] weight_log's most recent `weight_kg` field
 * @returns {number} kg, or 0 if no weight is resolvable anywhere
 */
function resolveWeightKg(profile, latestWeightKg) {
  const fromLog = Number(latestWeightKg)
  if (Number.isFinite(fromLog) && fromLog > 0) return fromLog
  const fromProfile = Number(profile?.weight_goal_kg)
  if (Number.isFinite(fromProfile) && fromProfile > 0) return fromProfile
  return 0
}

/**
 * Fiber DAILY GOAL in grams (14 g / 1000 kcal of the day's calorie basis).
 *
 * Feed it stableDayKcalBasis(profile) — the SAME basis sat-fat/sugar ceilings use,
 * so a fiber goal can never be computed from a different day target than the other
 * nutrition metrics on the same screen.
 *
 * @param {number} targetKcal day calorie basis
 * @returns {number} grams, rounded to a whole number
 */
function fiberGoalG(targetKcal) {
  const kcal = Number(targetKcal)
  if (!Number.isFinite(kcal) || kcal <= 0) return 0
  return Math.round((kcal * FIBER_G_PER_1000_KCAL) / 1000)
}

/**
 * Shared threshold ladder for every "consumed vs daily GOAL (to be REACHED)" status.
 *
 * The INVERSE of limitStatus: protein and fiber are targets to hit, not ceilings to
 * stay under, so ≥100% is 'ok' here (limitStatus calls that 'danger'). A separate
 * ladder — NOT a reused limitStatus — because reusing it would require the caller to
 * invert consumed/limit at the call site, which is exactly the kind of silent
 * flip that produces a wrong colour on screen (BASE RULE: one metric, one definition,
 * and a goal is not a limit wearing a costume).
 *
 * @param {number} consumedG
 * @param {number} goalG
 * @returns {'ok'|'warning'|'danger'} ≥100% ok · 80–100% warning · else danger
 */
function goalStatus(consumedG, goalG) {
  if (!goalG || goalG <= 0) return 'ok'
  const pct = (Number(consumedG) || 0) / goalG
  if (pct >= 1) return 'ok'
  if (pct >= 0.8) return 'warning'
  return 'danger'
}

module.exports = {
  SAT_FAT_KCAL_SHARE,
  KCAL_PER_G_FAT,
  SUGAR_KCAL_SHARE,
  KCAL_PER_G_CARB,
  PROTEIN_G_PER_KG,
  FIBER_G_PER_1000_KCAL,
  DEFAULT_TDEE_KCAL,
  DEFAULT_DEFICIT_KCAL,
  GOAL_MODES,
  DEFAULT_GOAL_MODE,
  GOAL_KCAL_RULES,
  resolveTdeeKcal,
  resolveDeficitKcal,
  resolveGoalMode,
  goalKcalDelta,
  resolveDayKcalTarget,
  stableDayKcalBasis,
  satFatLimitG,
  satFatStatus,
  sugarLimitG,
  sugarStatus,
  proteinGoalG,
  resolveProteinGoalG,
  resolveWeightKg,
  fiberGoalG,
  goalStatus,
}
