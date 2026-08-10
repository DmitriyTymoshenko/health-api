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
 *
 * `recomp` is NEW in #966 (owner decision via @lisa, 2026-08-09 18:13:57): the mode
 * existed as a concept but had no member here, so a profile carrying it silently
 * normalised to weight_loss. It now has its OWN protein coefficient (the highest of
 * the five) — see PROTEIN_G_PER_KG_BY_GOAL. It deliberately gets NO entry in
 * GOAL_KCAL_RULES; see that table's note for why.
 */
const GOAL_MODES = ['weight_loss', 'muscle_gain', 'maintenance', 'recomp', 'endurance']
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
 *
 * ⚠️ `recomp` (added to GOAL_MODES by #966) is INTENTIONALLY ABSENT from this table.
 * The owner's #966 decision covers PROTEIN only; nobody has decided what a recomp day's
 * calorie base should be. An absent key falls through the `|| GOAL_KCAL_RULES[
 * DEFAULT_GOAL_MODE]` guard in goalKcalDelta() and behaves exactly like weight_loss
 * (dir -1, owner's own deficit_kcal) — measured: tdee 2429, deficit 500 -> basis 1929,
 * byte-identical to the pre-#966 value, because `recomp` used to normalise to
 * weight_loss anyway. Inventing `recomp: { dir: ... }` here would be a per-mode
 * coefficient the owner never approved (§4a source integrity), so the silent fallback
 * is made LOUD instead: pinned by a characterization test in nutrition_goal_modes.test.ts
 * ("recomp gets its own protein coefficient but NOT its own kcal rule").
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
 * Protein target: grams per kilogram of body weight, PER GOAL MODE (#966).
 *
 * Replaces #961's single `PROTEIN_G_PER_KG = 1.6`, which was correct only for the one
 * state the profile happened to be in (weight_loss). Keyed by `personal_profile.
 * primary_goal` — the SAME field GOAL_KCAL_RULES uses, so one mode switch moves the
 * calorie base and the protein goal together and they can never disagree (BASE RULE).
 *
 * DELIBERATELY its own table, not merged with GOAL_KCAL_RULES: a g/kg-of-bodyweight
 * coefficient and a signed kcal direction are different quantities from different
 * sources, and #966's owner decision covers only this one (see GOAL_KCAL_RULES' note
 * on `recomp`). Same no-accidental-coupling reasoning as SUGAR_KCAL_SHARE vs
 * SAT_FAT_KCAL_SHARE above.
 *
 * SOURCE OF THE NUMBERS — owner decision, task #966, relayed by @lisa 2026-08-09
 * 18:13:57 ("так, онови під останні що пропонувались"), canonical copy in the #966
 * DESCRIPTION. It SUPERSEDES the earlier "final" table of comment 18:08:17
 * (2.2/1.9/1.7/2.1/1.3) — that comment says "це фінал" and is wrong about the numbers.
 * The first four come from evidence-based ISSN/USDA bands, NOT the Koliada course:
 * a deliberate owner departure from Lisa's "coefficients come from the course" rule,
 * recorded in comment 18:07:33 — not a sourcing mistake. `endurance` is the only one
 * still from the course.
 *
 * Grams below are at the live 98.2 kg from the ticket (the actual weight_log value on
 * 2026-08-10 is 98.0 kg, which rounds to the same targets).
 */
const PROTEIN_G_PER_KG_BY_GOAL = {
  /** Cutting: TOP of the ISSN 2.0–2.4 band — preserve muscle in a deficit without the
   *  2.4 extreme. 98.2 kg -> 196 g. Owner, #966 (via @lisa 18:13:57). */
  weight_loss: 2.0,
  /** Bulk: above Мацюпа's 1.3–1.5 (vault 04.04:124) but below the 2.2 top of the
   *  evidence band — leaves room for carbs on a surplus. 98.2 kg -> 177 g. Owner, #966. */
  muscle_gain: 1.8,
  /** Maintenance: LOWER bound of the 1.6–1.8 band — no reason to overpay in protein
   *  without a goal. 98.2 kg -> 157 g. Owner, #966. (== the old #961 constant.) */
  maintenance: 1.6,
  /** Recomposition: the HIGHEST of the five — holding muscle while cutting fat at the
   *  same time is the hardest mode. 98.2 kg -> 216 g. Owner, #966; the course has zero
   *  coverage of recomp (`grep -ric "recompos"` over 04.0x = 0), so this is explicitly
   *  an owner decision, not a distilled one. */
  recomp: 2.2,
  /** Endurance: middle of the course band 1.2–1.4 (vault 04.01:104) — the ONLY row still
   *  sourced from the Koliada course; never re-reviewed against ISSN. 98.2 kg -> 128 g. */
  endurance: 1.3,
}

/**
 * Fiber target: grams per 1000 kcal of the day's calorie basis.
 *
 * Source: vault EN/00-09 System & Personal/04 Health/04.02 Koliada-Nutrition-Part2 —
 * USDA/WHO "Fiber: 14 g per 1000 kcal".
 */
const FIBER_G_PER_1000_KCAL = 14

/**
 * The g/kg protein coefficient for a profile's goal mode (#966).
 *
 * Goes through resolveGoalMode(), so an absent/unknown/misspelt `primary_goal` lands on
 * DEFAULT_GOAL_MODE (weight_loss) exactly like every other goal-aware function here —
 * one normalisation rule for the whole module, never a second `includes()` check.
 *
 * @param {object} [profile] personal_profile document (may be null)
 * @returns {number} grams of protein per kg of body weight
 */
function proteinGPerKg(profile) {
  return PROTEIN_G_PER_KG_BY_GOAL[resolveGoalMode(profile)]
}

/**
 * Protein DAILY GOAL in grams (auto-calculated from body weight AND goal mode).
 *
 * Feed it a resolved weight in kg (see resolveWeightKg) — this function does no
 * fallback of its own beyond degrading to 0 on bad input, same defensive pattern as
 * satFatLimitG/sugarLimitG.
 *
 * `profile` is the SECOND argument and optional on purpose: every caller already holds
 * the profile document (verified by grep — 3 call sites, all of them read it), and
 * omitting it degrades to DEFAULT_GOAL_MODE rather than to a hardcoded number. Callers
 * MUST pass it — a call site that "works" without it is silently pinned to weight_loss,
 * which is how #961's single constant became wrong for four of five modes.
 *
 * @param {number} weightKg
 * @param {object} [profile] personal_profile document — supplies primary_goal
 * @returns {number} grams, rounded to a whole number
 */
function proteinGoalG(weightKg, profile) {
  const kg = Number(weightKg)
  if (!Number.isFinite(kg) || kg <= 0) return 0
  return Math.round(kg * proteinGPerKg(profile))
}

/**
 * Resolves the AUTO-CALCULATED protein goal, honouring an explicit owner override.
 *
 * Priority: `profile.daily_protein_goal_g` (explicit number the owner typed via
 * PUT /api/profile) wins outright; otherwise proteinGoalG(weightKg, profile). Mirrors the
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
  return proteinGoalG(weightKg, profile)
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
  PROTEIN_G_PER_KG_BY_GOAL,
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
  proteinGPerKg,
  proteinGoalG,
  resolveProteinGoalG,
  resolveWeightKg,
  fiberGoalG,
  goalStatus,
}
