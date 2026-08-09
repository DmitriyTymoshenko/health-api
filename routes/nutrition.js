const { Router } = require('express')
const https = require('https')
const {
  stableDayKcalBasis,
  satFatLimitG,
  satFatStatus,
  sugarLimitG,
  sugarStatus,
} = require('../lib/nutrition-targets')

const TELEGRAM_BOT_TOKEN = '' // notifications disabled per user request
const TELEGRAM_OWNER_ID = process.env.OWNER_TELEGRAM_ID || '455440443'

function progressBar(current, target, length = 10) {
  const pct = Math.min(current / target, 1)
  const filled = Math.round(pct * length)
  return '█'.repeat(filled) + '░'.repeat(length - filled)
}

function getMealLabel(mealType) {
  const labels = { breakfast: 'сніданок', lunch: 'обід', snack: 'перекус', dinner: 'вечеря' }
  return labels[mealType] || mealType
}

function getNextMealType(currentMealType) {
  const order = ['breakfast', 'lunch', 'snack', 'dinner']
  const idx = order.indexOf(currentMealType)
  if (idx === -1 || idx === order.length - 1) return null
  return order[idx + 1]
}

function getNextMealByHour() {
  const kyivHour = parseInt(new Date().toLocaleString('uk', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }))
  if (kyivHour < 11) return 'breakfast'
  if (kyivHour < 15) return 'lunch'
  if (kyivHour < 18) return 'snack'
  return 'dinner'
}

function sendTelegramMessage(token, chatId, text) {
  if (!token) return
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }
  const req = https.request(options, (res) => {
    res.resume() // drain response
  })
  req.on('error', () => {}) // fire-and-forget, ignore errors
  req.write(body)
  req.end()
}

async function sendMealTelegramNotification(db, doc) {
  try {
    if (!TELEGRAM_BOT_TOKEN) return

    const today = doc.date || new Date().toISOString().split('T')[0]

    // Get today's totals
    const todayEntries = await db.collection('nutrition_log').find({ date: today }).toArray()
    const totals = todayEntries.reduce(
      (acc, e) => {
        acc.kcal += e.kcal || e.calories || 0
        acc.protein_g += e.protein_g || 0
        acc.fat_g += e.fat_g || 0
        acc.carbs_g += e.carbs_g || 0
        return acc
      },
      { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }
    )

    // Get profile targets
    const DEFAULT_KCAL = 1929
    const DEFAULT_PROTEIN = 150
    let kcalTarget = DEFAULT_KCAL
    let proteinTarget = DEFAULT_PROTEIN

    const profile = await db.collection('personal_profile').findOne({ _type: 'profile' })
    if (profile) {
      if (profile.daily_kcal_goal) {
        kcalTarget = profile.daily_kcal_goal
      } else if (profile.tdee_kcal && profile.deficit_kcal) {
        kcalTarget = profile.tdee_kcal - profile.deficit_kcal
      }
      if (profile.daily_protein_goal_g) proteinTarget = profile.daily_protein_goal_g
    }

    // Also check WHOOP for dynamic calorie target
    const whoopCycle = await db.collection('whoop_cycles').findOne({ date: today })
    const caloriesBurned = whoopCycle?.calories_burned
    const deficitGoal = profile?.deficit_kcal || 500
    if (caloriesBurned && caloriesBurned > 1200) {
      kcalTarget = Math.round(caloriesBurned - deficitGoal)
    }

    const kcalPct = Math.round((totals.kcal / kcalTarget) * 100)
    const proteinPct = Math.round((totals.protein_g / proteinTarget) * 100)
    const remainingKcal = Math.max(0, kcalTarget - totals.kcal)
    const remainingProtein = Math.max(0, proteinTarget - totals.protein_g)

    const mealLabel = getMealLabel(doc.meal_type)
    const proteinBar = progressBar(totals.protein_g, proteinTarget)

    // Meal plan for remaining meals
    const allMeals = ['breakfast', 'lunch', 'snack', 'dinner']
    const loggedMealTypes = new Set(todayEntries.map(e => e.meal_type))
    const remainingMeals = allMeals.filter(m => !loggedMealTypes.has(m))

    const mealBudgets = { breakfast: 0.25, lunch: 0.35, snack: 0.15, dinner: 0.25 }
    const remainingPctTotal = remainingMeals.reduce((s, m) => s + mealBudgets[m], 0) || 1

    const mealOptions = {
      breakfast: [
        { name: 'Омлет з сиром і шинкою', cal: 370, pro: 26 },
        { name: 'Протеінова гранола + молоко', cal: 450, pro: 22 },
        { name: 'Pro Feel + 2 яйця', cal: 280, pro: 30 },
      ],
      lunch: [
        { name: 'Куряче філе 200г + гречка', cal: 430, pro: 48 },
        { name: 'Лосось 200г + овочі', cal: 480, pro: 42 },
        { name: 'Яловичина 150г + картопля', cal: 520, pro: 38 },
      ],
      snack: [
        { name: 'Pro Feel', cal: 114, pro: 19 },
        { name: 'Fitwin батончик', cal: 219, pro: 20 },
        { name: 'Грецький йогурт 200г', cal: 160, pro: 20 },
      ],
      dinner: [
        { name: 'Риба на грилі + броколі', cal: 320, pro: 42 },
        { name: 'Куряче філе 200г + салат', cal: 300, pro: 44 },
        { name: 'Сирники 3шт зі сметаною', cal: 420, pro: 24 },
      ],
    }

    const mealEmoji = { breakfast: '🌅', lunch: '☀️', snack: '🍎', dinner: '🌙' }
    const nums = ['①', '②', '③']

    let text = `🍽️ *${doc.food_name}* — ${mealLabel}\n`
    text += `${Math.round(doc.kcal || 0)} ккал | Б: ${Math.round(doc.protein_g || 0)}г | Ж: ${Math.round(doc.fat_g || 0)}г | В: ${Math.round(doc.carbs_g || 0)}г\n\n`
    const whoopSuffix = caloriesBurned ? ` 🔥 спалено ${caloriesBurned}` : ''
    text += `📊 *День: ${Math.round(totals.kcal)} / ${kcalTarget} ккал* (${kcalPct}%)${whoopSuffix}\n`
    text += `Білок: ${Math.round(totals.protein_g)}г / ${proteinTarget}г ${proteinBar} ${proteinPct}%\n`

    if (remainingMeals.length > 0) {
      text += `\n📋 *План на сьогодні:*\n`
      for (const meal of remainingMeals) {
        const calBudget = Math.round(remainingKcal * (mealBudgets[meal] / remainingPctTotal))
        const proBudget = Math.round(remainingProtein * (mealBudgets[meal] / remainingPctTotal))
        const emoji = mealEmoji[meal] || '🍽️'
        const label = getMealLabel(meal)
        text += `\n${emoji} *${label.charAt(0).toUpperCase() + label.slice(1)}* (~${calBudget} ккал | ${proBudget}г Б)\n`
        const opts = (mealOptions[meal] || []).slice(0, 3)
        opts.forEach((o, i) => {
          text += `${nums[i]} ${o.name} — ${o.cal} ккал | ${o.pro}г Б\n`
        })
      }
    }

    sendTelegramMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID, text)
  } catch (_err) {
    // fire-and-forget — never block the main request
  }
}

module.exports = function (getDB) {
  const router = Router()

  // GET /api/nutrition
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date, limit = 50, skip = 0 } = req.query
      const filter = date ? { date } : {}
      const data = await db.collection('nutrition_log')
        .find(filter)
        .sort({ date: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/nutrition/today?date=YYYY-MM-DD
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const today = req.query.date || new Date().toISOString().split('T')[0]
      const data = await db.collection('nutrition_log')
        .find({ date: today })
        .sort({ meal_type: 1 })
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/nutrition/summary?date=YYYY-MM-DD (also /summary/today for backward compat)
  router.get('/summary/today', async (req, res) => { req.query.date = new Date().toISOString().split('T')[0]; return summaryHandler(req, res) })
  router.get('/summary', summaryHandler)
  async function summaryHandler(req, res) {
    try {
      const db = getDB()
      const today = req.query.date || new Date().toISOString().split('T')[0]
      const data = await db.collection('nutrition_log').find({ date: today }).toArray()

      const summary = data.reduce(
        (acc, item) => {
          acc.kcal += item.kcal || item.calories || 0
          acc.protein_g += item.protein_g || 0
          acc.carbs_g += item.carbs_g || 0
          acc.fat_g += item.fat_g || 0
          acc.fiber_g += item.fiber_g || 0
          acc.sugar_g += item.sugar_g || 0
          acc.sat_fat_g += item.sat_fat_g || 0
          // incompleteness: any item lacking sat_fat_g means the day's sat_fat total is underestimated
          if (item.sat_fat_g == null) acc.sat_fat_incomplete = true
          // same for sugar: an entry logged before sugar was tracked drags the day's
          // total DOWN, which would render a green 'ok' on a day that actually breached
          // the ceiling — the exact case the metric exists for.
          if (item.sugar_g == null) acc.sugar_incomplete = true
          return acc
        },
        { date: today, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sat_fat_g: 0, sat_fat_incomplete: false, sugar_incomplete: false, items: data.length }
      )

      // Round to 1 decimal
      summary.kcal = Math.round(summary.kcal)
      summary.protein_g = Math.round(summary.protein_g * 10) / 10
      summary.carbs_g = Math.round(summary.carbs_g * 10) / 10
      summary.fat_g = Math.round(summary.fat_g * 10) / 10
      summary.fiber_g = Math.round(summary.fiber_g * 10) / 10
      summary.sugar_g = Math.round(summary.sugar_g * 10) / 10
      summary.sat_fat_g = Math.round(summary.sat_fat_g * 10) / 10

      // DAILY CEILINGS — saturated fat (Koliada norm: ≤10% of calories; 9 kcal/g)
      // and sugar (WHO: ≤10% of calories; 4 kcal/g).
      // Math lives in lib/nutrition-targets.js — the SAME helper recommendations.js
      // uses, so a limit can never drift between the two surfaces (BASE RULE).
      // Basis is the STABLE profile target, never the intraday WHOOP burn.
      const profile = await db.collection('personal_profile').findOne({ _type: 'profile' })
      const kcalBasis = stableDayKcalBasis(profile)
      summary.sat_fat_goal_g = satFatLimitG(kcalBasis)
      summary.sat_fat_status = satFatStatus(summary.sat_fat_g, summary.sat_fat_goal_g)
      summary.sugar_goal_g = sugarLimitG(kcalBasis)
      summary.sugar_status = sugarStatus(summary.sugar_g, summary.sugar_goal_g)

      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }

  // POST /api/nutrition
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      doc.created_at = new Date()
      // Normalize field names: support both protein/fat/carbs and protein_g/fat_g/carbs_g
      if (doc.protein !== undefined && doc.protein_g === undefined) doc.protein_g = doc.protein
      if (doc.fat !== undefined && doc.fat_g === undefined) doc.fat_g = doc.fat
      if (doc.carbs !== undefined && doc.carbs_g === undefined) doc.carbs_g = doc.carbs
      if (doc.sat_fat !== undefined && doc.sat_fat_g === undefined) doc.sat_fat_g = doc.sat_fat
      if (doc.name && !doc.food_name) doc.food_name = doc.name

      const result = await db.collection('nutrition_log').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })

      // Fire-and-forget Telegram notification
      sendMealTelegramNotification(db, doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })


  // GET /api/nutrition/meal-suggest
  // Extensive list of common foods for suggestions
  const COMMON_FOODS = [
    // High protein
    { name: 'Куряча грудка варена', kcal_per_100g: 165, protein_per_100g: 31, fat_per_100g: 3.6, carbs_per_100g: 0, sugar_per_100g: 0, tags: ['protein'] },
    { name: 'Яловичина тушкована', kcal_per_100g: 218, protein_per_100g: 25, fat_per_100g: 12, carbs_per_100g: 0, sugar_per_100g: 0, tags: ['protein'] },
    { name: 'Лосось запечений', kcal_per_100g: 208, protein_per_100g: 20, fat_per_100g: 13, carbs_per_100g: 0, sugar_per_100g: 0, tags: ['protein', 'fat'] },
    { name: 'Творог 5%', kcal_per_100g: 121, protein_per_100g: 17, fat_per_100g: 5, carbs_per_100g: 1.8, sugar_per_100g: 1.8, tags: ['protein'] },
    { name: 'Яйця варені', kcal_per_100g: 155, protein_per_100g: 13, fat_per_100g: 11, carbs_per_100g: 1.1, sugar_per_100g: 1.1, tags: ['protein', 'fat'] },
    { name: 'Грецький йогурт 2%', kcal_per_100g: 59, protein_per_100g: 10, fat_per_100g: 0.4, carbs_per_100g: 3.6, sugar_per_100g: 3.2, tags: ['protein'] },
    { name: 'Тунець у воді', kcal_per_100g: 96, protein_per_100g: 21, fat_per_100g: 0.5, carbs_per_100g: 0, sugar_per_100g: 0, tags: ['protein'] },
    { name: 'Індичка варена', kcal_per_100g: 189, protein_per_100g: 29, fat_per_100g: 7, carbs_per_100g: 0, sugar_per_100g: 0, tags: ['protein'] },
    // High carbs
    { name: 'Гречка варена', kcal_per_100g: 92, protein_per_100g: 3.4, fat_per_100g: 0.6, carbs_per_100g: 20, sugar_per_100g: 0.9, tags: ['carbs'] },
    { name: 'Рис варений', kcal_per_100g: 130, protein_per_100g: 2.7, fat_per_100g: 0.3, carbs_per_100g: 28, sugar_per_100g: 0.1, tags: ['carbs'] },
    { name: 'Вівсянка на воді', kcal_per_100g: 88, protein_per_100g: 3, fat_per_100g: 1.7, carbs_per_100g: 15, sugar_per_100g: 0.5, tags: ['carbs'] },
    { name: 'Банан', kcal_per_100g: 89, protein_per_100g: 1.1, fat_per_100g: 0.3, carbs_per_100g: 23, sugar_per_100g: 12.2, tags: ['carbs'] },
    { name: 'Картопля варена', kcal_per_100g: 77, protein_per_100g: 2, fat_per_100g: 0.1, carbs_per_100g: 17, sugar_per_100g: 0.8, tags: ['carbs'] },
    { name: 'Хліб цільнозерновий', kcal_per_100g: 247, protein_per_100g: 9, fat_per_100g: 3, carbs_per_100g: 43, sugar_per_100g: 5, tags: ['carbs'] },
    { name: 'Макарони варені', kcal_per_100g: 131, protein_per_100g: 5, fat_per_100g: 0.9, carbs_per_100g: 25, sugar_per_100g: 0.6, tags: ['carbs'] },
    // Healthy fats
    { name: 'Авокадо', kcal_per_100g: 160, protein_per_100g: 2, fat_per_100g: 15, carbs_per_100g: 9, sugar_per_100g: 0.7, tags: ['fat'] },
    { name: 'Грецькі горіхи', kcal_per_100g: 654, protein_per_100g: 15, fat_per_100g: 65, carbs_per_100g: 14, sugar_per_100g: 2.6, tags: ['fat'] },
    { name: 'Мигдаль', kcal_per_100g: 579, protein_per_100g: 21, fat_per_100g: 50, carbs_per_100g: 22, sugar_per_100g: 4.4, tags: ['fat', 'protein'] },
    // Vegetables
    { name: 'Броколі варена', kcal_per_100g: 35, protein_per_100g: 2.4, fat_per_100g: 0.4, carbs_per_100g: 7, sugar_per_100g: 1.4, tags: ['vegs'] },
    { name: 'Шпинат', kcal_per_100g: 23, protein_per_100g: 2.9, fat_per_100g: 0.4, carbs_per_100g: 3.6, sugar_per_100g: 0.4, tags: ['vegs'] },
    { name: 'Огірок', kcal_per_100g: 16, protein_per_100g: 0.7, fat_per_100g: 0.1, carbs_per_100g: 3.6, sugar_per_100g: 1.7, tags: ['vegs'] },
    { name: 'Помідор', kcal_per_100g: 18, protein_per_100g: 0.9, fat_per_100g: 0.2, carbs_per_100g: 3.9, sugar_per_100g: 2.6, tags: ['vegs'] },
    // Mixed
    { name: 'Омлет з 2 яєць', kcal_per_100g: 154, protein_per_100g: 11, fat_per_100g: 12, carbs_per_100g: 1, sugar_per_100g: 0.7, tags: ['protein', 'fat'] },
    { name: 'Протеїновий шейк', kcal_per_100g: 110, protein_per_100g: 22, fat_per_100g: 1.5, carbs_per_100g: 3, sugar_per_100g: 1.5, tags: ['protein'] },
  ]

  router.get('/meal-suggest', async (req, res) => {
    try {
      const db = getDB()
      const { meal_type, kcal, protein_g, carbs_g, fat_g } = req.query
      const targetKcal = parseFloat(kcal) || 500
      const targetProtein = parseFloat(protein_g) || 30
      const targetCarbs = parseFloat(carbs_g) || 50
      const targetFat = parseFloat(fat_g) || 15

      // Fetch library foods
      const libraryFoods = await db.collection('foods_library').find({}).toArray()
      // #926: a foods_library doc can be missing `name` (a partial/broken write — 1 of 172 docs
      // in prod as of 2026-08-07, use_count:0, not a systemic writer bug). Drop such docs before
      // any .toLowerCase()/dedup logic below, instead of crashing the whole endpoint on one bad row.
      const libraryNormalized = libraryFoods
        .filter(f => typeof f?.name === 'string' && f.name.trim())
        .map(f => ({
          name: f.name,
          kcal_per_100g: f.kcal_per_100g,
          protein_per_100g: f.protein_per_100g,
          fat_per_100g: f.fat_per_100g,
          carbs_per_100g: f.carbs_per_100g,
          sugar_per_100g: f.sugar_per_100g || 0,
          fiber_per_100g: f.fiber_per_100g || 0,
          source: 'library',
        }))

      // Always merge library + COMMON_FOODS, dedup by name (library takes priority)
      const existingNames = new Set(libraryNormalized.map(f => f.name.toLowerCase()))
      const commonFoodsNorm = COMMON_FOODS
        .filter(f => !existingNames.has(f.name.toLowerCase()))
        .map(f => ({ ...f, source: 'common' }))
      const allFoods = [...libraryNormalized, ...commonFoodsNorm]

      // Score each food — MACRO FIT is the primary metric, calories secondary
      const scored = allFoods
        .filter(food => food.kcal_per_100g > 0)
        .map(food => {
          // Calculate amount to hit target kcal
          const idealAmount = Math.min(500, Math.max(30, Math.round((targetKcal / food.kcal_per_100g) * 100)))
          const amount = idealAmount
          const actualKcal = Math.round(food.kcal_per_100g * amount / 100)
          const actualProtein = Math.round(food.protein_per_100g * amount / 100 * 10) / 10
          const actualFat = Math.round(food.fat_per_100g * amount / 100 * 10) / 10
          const actualCarbs = Math.round(food.carbs_per_100g * amount / 100 * 10) / 10
          const actualSugar = Math.round((food.sugar_per_100g || 0) * amount / 100 * 10) / 10
          const actualFiber = Math.round((food.fiber_per_100g || 0) * amount / 100 * 10) / 10

          // Macro fit score (weighted: protein matters most for this user)
          const proteinDev = targetProtein > 0 ? Math.abs(actualProtein - targetProtein) / targetProtein : 0
          const carbsDev = targetCarbs > 0 ? Math.abs(actualCarbs - targetCarbs) / targetCarbs : 0
          const fatDev = targetFat > 0 ? Math.abs(actualFat - targetFat) / targetFat : 0
          // Protein weight 50%, carbs 30%, fat 20%
          const weightedDev = proteinDev * 0.5 + carbsDev * 0.3 + fatDev * 0.2
          const fit_score = Math.round((1 / (1 + weightedDev)) * 1000) / 1000

          return {
            food_name: food.name,
            amount_g: amount,
            kcal: actualKcal,
            protein_g: actualProtein,
            fat_g: actualFat,
            carbs_g: actualCarbs,
            sugar_g: actualSugar,
            fiber_g: actualFiber,
            fit_score,
            source: food.source,
          }
        })

      // Sort by fit_score desc, return top 6
      scored.sort((a, b) => b.fit_score - a.fit_score)
      res.json(scored.slice(0, 6))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/nutrition/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('nutrition_log').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      )
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' })
      const updated = await db.collection('nutrition_log').findOne({ _id: new ObjectId(req.params.id) })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })


  // DELETE /api/nutrition/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('nutrition_log').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
// This file will be modified to add foods_library routes separately
