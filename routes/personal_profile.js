const { Router } = require('express')
const { proteinGoalG, goalKcalDelta, resolveTdeeKcal } = require('../lib/nutrition-targets')
// #1295 — weight-goal fallback constants now live in ONE place (lib/targets-resolver.js),
// shared with GET /api/targets. DEFAULT_PROFILE below used to hardcode its own 96/2026-10-01
// pair, disagreeing with both the live profile document (90/2026-10-15) and the `goals`
// collection (96/2026-10-31) — three numbers for one goal.
const { resolveWeightGoal, DEFAULT_WEIGHT_GOAL_KG, DEFAULT_WEIGHT_GOAL_DATE } = require('../lib/targets-resolver')

module.exports = function (getDB) {
  const router = Router()

  const DEFAULT_PROFILE = {
    // Personal
    name: 'Дмитро',
    birth_year: 1995,
    gender: 'male',

    // Body
    height_cm: 186,
    wrist_cm: null,
    body_type: null, // ectomorph | mesomorph | endomorph

    // Health
    blood_type: null,
    allergies: [],
    chronic_conditions: [],
    medications: [],

    // Fitness
    activity_level: 'moderate', // sedentary | light | moderate | active | very_active
    fitness_level: 'intermediate', // beginner | intermediate | advanced
    training_days_per_week: 3,
    primary_goal: 'weight_loss', // weight_loss | muscle_gain | maintenance | recomp | endurance (#966)

    // Nutrition preferences
    diet_type: 'none', // none | keto | paleo | vegan | vegetarian | mediterranean
    meal_count_per_day: 3,
    water_goal_ml: 2500,
    excluded_foods: [],

    // Targets
    weight_goal_kg: DEFAULT_WEIGHT_GOAL_KG,
    weight_goal_date: DEFAULT_WEIGHT_GOAL_DATE,
    body_fat_goal_pct: null,
    daily_kcal_goal: null, // null = auto-calculate from TDEE
    daily_protein_goal_g: null, // null = auto-calculate, per-goal g/kg matrix (#966, lib/nutrition-targets.js)
    daily_steps_goal: 8000,
    sleep_goal_hours: 8,

    // TDEE
    tdee_kcal: 2429,
    deficit_kcal: 500,

    updated_at: null,
  }

  // GET /api/profile
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = await db.collection('personal_profile').findOne({ _type: 'profile' })
      res.json(doc || DEFAULT_PROFILE)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/profile — upsert profile
  router.put('/', async (req, res) => {
    try {
      const db = getDB()
      const { _id, ...update } = req.body
      await db.collection('personal_profile').updateOne(
        { _type: 'profile' },
        { $set: { ...update, _type: 'profile', updated_at: new Date() } },
        { upsert: true }
      )
      const doc = await db.collection('personal_profile').findOne({ _type: 'profile' })
      // #1295: `personal_profile.weight_goal_kg`/`weight_goal_date` is the CANON (it
      // already drives every kcal/protein target); the separate `goals` collection's
      // `type: 'weight'` doc is a legacy display copy that Trends.jsx still reads
      // directly (target_value/deadline for the goal line on the weight chart). A
      // one-time migration synced it to the profile's live value on 2026-09-12 — this
      // keeps it from drifting again on the next profile edit, without making
      // Trends.jsx read a second source.
      if ('weight_goal_kg' in update || 'weight_goal_date' in update) {
        await db.collection('goals').updateOne(
          { type: 'weight' },
          { $set: { target_value: doc.weight_goal_kg, deadline: doc.weight_goal_date, updated_at: new Date() } }
        )
      }
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/profile/metrics — calculated metrics based on profile + current weight
  router.get('/metrics', async (req, res) => {
    try {
      const db = getDB()
      const profile = await db.collection('personal_profile').findOne({ _type: 'profile' }) || DEFAULT_PROFILE
      const latestWeight = await db.collection('weight_log').findOne({}, { sort: { date: -1 } })

      const weight = latestWeight?.weight_kg || profile.weight_start || 100
      const height = profile.height_cm || 186
      const age = new Date().getFullYear() - (profile.birth_year || 1995)

      // BMI
      const bmi = weight / Math.pow(height / 100, 2)

      // BMR (Mifflin-St Jeor for male) — a genuinely different metric from TDEE
      // (activity-adjusted), kept as its own on-the-fly calc; unaffected by #1295.
      const bmr = 10 * weight + 6.25 * height - 5 * age + 5

      // Ideal weight range (BMI 18.5-24.9)
      const idealMin = Math.round(18.5 * Math.pow(height / 100, 2))
      const idealMax = Math.round(24.9 * Math.pow(height / 100, 2))

      // Days to goal at the CURRENT GOAL MODE's daily rate (#968).
      //
      // Was `profile.deficit_kcal || 500`. Converting that to `??` ALONE would have been
      // a crash, not a fix: a maintenance profile (deficit 0) makes this a division by
      // zero -> Infinity -> `d.setDate(d.getDate() + Infinity)` -> Invalid Date ->
      // `.toISOString()` throws RangeError -> HTTP 500 on GET /api/profile/metrics.
      // The `|| 500` was accidentally masking that. So the rate now comes from the
      // SIGNED goal delta, and a non-shrinking mode (maintenance / muscle_gain) honestly
      // reports "no ETA" instead of inventing one from a stale deficit number.
      const dailyDeficit = -goalKcalDelta(profile) // > 0 only while actually cutting
      // #1295: weight-goal fallback now shares the SAME constant as GET /api/targets
      // and WeightProgress.jsx/WeightChart.jsx (90 kg, not the old local `96` literal).
      const { weight_goal_kg: weightGoalKg } = resolveWeightGoal(profile)
      const toGoal = weight - weightGoalKg
      const daysToGoal = toGoal > 0 && dailyDeficit > 0
        ? Math.round((toGoal * 7700) / dailyDeficit)
        : 0

      res.json({
        weight_kg: weight,
        bmi: Math.round(bmi * 10) / 10,
        bmi_category: bmi < 18.5 ? 'Дефіцит' : bmi < 25 ? 'Норма' : bmi < 30 ? 'Надлиш.' : 'Ожиріння',
        bmr_kcal: Math.round(bmr),
        // #1295: was an on-the-fly BMR×activity recompute (3017 live vs the canonical
        // 2701 stored in personal_profile.tdee_kcal — one of the "3 TDEE values" the
        // ticket found). This is now THE SAME stored value every kcal/protein target
        // in the app is built from (lib/nutrition-targets.js resolveTdeeKcal).
        tdee_kcal: resolveTdeeKcal(profile),
        ideal_weight_min: idealMin,
        ideal_weight_max: idealMax,
        kg_to_goal: Math.round(toGoal * 10) / 10,
        days_to_goal: daysToGoal,
        target_date_estimated: (() => {
          const d = new Date()
          d.setDate(d.getDate() + daysToGoal)
          return d.toISOString().slice(0, 10)
        })(),
        // Same formula, THE single source (#961) — was a local Math.round(weight*1.6).
        // `profile` is passed since #966: the coefficient is now per goal mode, and a
        // call without it would silently pin this card to weight_loss (2.0 g/kg) while
        // /api/nutrition/summary showed the mode's real number — one quantity, two
        // screens, two answers (BASE RULE).
        protein_recommended_g: proteinGoalG(weight, profile),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
