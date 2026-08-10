const { Router } = require('express')
const { proteinGoalG, goalKcalDelta } = require('../lib/nutrition-targets')

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
    weight_goal_kg: 96,
    weight_goal_date: '2026-10-01',
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
      const latestWeight = await db.collection('weights').findOne({}, { sort: { date: -1 } })

      const weight = latestWeight?.weight_kg || profile.weight_start || 100
      const height = profile.height_cm || 186
      const age = new Date().getFullYear() - (profile.birth_year || 1995)

      // BMI
      const bmi = weight / Math.pow(height / 100, 2)

      // BMR (Mifflin-St Jeor for male)
      const bmr = 10 * weight + 6.25 * height - 5 * age + 5

      // TDEE
      const activityMultipliers = {
        sedentary: 1.2,
        light: 1.375,
        moderate: 1.55,
        active: 1.725,
        very_active: 1.9,
      }
      const tdee = Math.round(bmr * (activityMultipliers[profile.activity_level] || 1.55))

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
      const toGoal = weight - (profile.weight_goal_kg || 96)
      const daysToGoal = toGoal > 0 && dailyDeficit > 0
        ? Math.round((toGoal * 7700) / dailyDeficit)
        : 0

      res.json({
        weight_kg: weight,
        bmi: Math.round(bmi * 10) / 10,
        bmi_category: bmi < 18.5 ? 'Дефіцит' : bmi < 25 ? 'Норма' : bmi < 30 ? 'Надлиш.' : 'Ожиріння',
        bmr_kcal: Math.round(bmr),
        tdee_kcal: tdee,
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
