const { Router } = require('express')
const https = require('https')
const { requireFields, validateDate, normalizeNutrition } = require('../lib/validate')
const {
  stableDayKcalBasis,
  resolveDeficitKcal,
  satFatLimitG,
  satFatStatus,
  resolveSugarLimitG,
  sugarStatus,
  resolveProteinGoalG,
  resolveWeightKg,
  resolveFiberGoalG,
  goalStatus,
  rangeStatus,
} = require('../lib/nutrition-targets')
// #1295 — protein/fat/carbs macro math now shares ONE definition with GET /api/targets
// and routes/recommendations.js (deriveMacroRangesG, #1396), instead of Nutrition.jsx
// deriving them a second time client-side from its OWN local calorie projection.
// PURE — no DB — so this stays off the `whoop_cycles` collection (route-level test's
// allowlist).
const { deriveMacroRangesG } = require('../lib/targets-resolver')
const { aggregateDay, macroContribution } = require('../lib/nutrition-aggregate')

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
        const m = macroContribution(e)
        acc.kcal += m.kcal
        acc.protein_g += m.protein_g
        acc.fat_g += m.fat_g
        acc.carbs_g += m.carbs_g
        return acc
      },
      { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }
    )

    const profile = await db.collection('personal_profile').findOne({ _type: 'profile' })

    // Protein target: SINGLE SOURCE via resolveProteinGoalG (#961) — no more local
    // 150 g constant. Honours an explicit profile.daily_protein_goal_g override;
    // otherwise auto-calculated from the latest weight_log entry x the goal mode's g/kg (#966).
    const latestWeightEntry = await db.collection('weight_log').findOne({}, { sort: { date: -1 } })
    const weightKg = resolveWeightKg(profile, latestWeightEntry?.weight_kg)
    const proteinTarget = resolveProteinGoalG(profile, weightKg) || 150 // last-resort guard: no weight data anywhere (fresh/empty DB) — avoid a divide-by-zero progress bar below

    const whoopCycle = await db.collection('whoop_cycles').findOne({ date: today })
    const caloriesBurned = whoopCycle?.calories_burned

    // Calorie target: SINGLE SOURCE via stableDayKcalBasis (#1295) — this digest used
    // to re-derive it via resolveDayKcalTarget (WHOOP-burn-adjusted), which made the
    // Telegram digest's own target float during the day exactly like /api/recommendations
    // did before #1295 (1444 at noon -> 2400 at night for the SAME day). Every other
    // target-facing surface (recommendations, nutrition/summary, goals/streaks,
    // water/today, profile/metrics) now shares this SAME stable basis via
    // lib/targets-resolver.js — this fire-and-forget digest already holds `profile` in
    // scope, so it calls stableDayKcalBasis directly instead of the full async resolver.
    const kcalTarget = stableDayKcalBasis(profile)

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

      // Sums both on-disk formats (flat modern + legacy nested items[]) — see
      // lib/nutrition-aggregate.js for why (#862: legacy nested-items records were
      // silently contributing 0 kcal/protein/carbs/fat to the day total).
      const summary = aggregateDay(today, data)

      // DAILY CEILINGS — saturated fat (Koliada norm: ≤10% of calories; 9 kcal/g)
      // and sugar (WHO: ≤10% of calories; 4 kcal/g).
      // Math lives in lib/nutrition-targets.js — the SAME helper recommendations.js
      // uses, so a limit can never drift between the two surfaces (BASE RULE).
      // Basis is the STABLE profile target, never the intraday WHOOP burn.
      const profile = await db.collection('personal_profile').findOne({ _type: 'profile' })
      const kcalBasis = stableDayKcalBasis(profile)
      summary.kcal_goal = kcalBasis
      summary.deficit_kcal = resolveDeficitKcal(profile)
      summary.sat_fat_goal_g = satFatLimitG(kcalBasis)
      summary.sat_fat_status = satFatStatus(summary.sat_fat_g, summary.sat_fat_goal_g)
      summary.sugar_goal_g = resolveSugarLimitG(profile, kcalBasis)
      summary.sugar_status = sugarStatus(summary.sugar_g, summary.sugar_goal_g)

      // DAILY GOALS — protein/fat as weight-derived RANGES with a midpoint POINT,
      // carbs as the residual (#1396, owner decision 2026-09-16, supersedes #966's
      // per-mode protein matrix). Weight resolved BEFORE this block (moved up from
      // its old #961/#966 position) because carbs/fat/protein now all derive from
      // the SAME weight+kcal pair via deriveMacroRangesG — SINGLE SOURCE with
      // GET /api/targets and GET /api/recommendations. Still only
      // `personal_profile` + `weight_log` — no new `whoop_cycles` dependency (route
      // test's collection allowlist).
      const latestWeightEntry = await db.collection('weight_log').findOne({}, { sort: { date: -1 } })
      const weightKg = resolveWeightKg(profile, latestWeightEntry?.weight_kg)
      const macros = deriveMacroRangesG(kcalBasis, weightKg, profile)

      summary.protein_goal_g = macros.protein_point_g
      summary.protein_goal_min_g = macros.protein_min_g
      summary.protein_goal_max_g = macros.protein_max_g
      summary.protein_status = rangeStatus(summary.protein_g, macros.protein_min_g, macros.protein_max_g)
      // Flags "no weight anywhere to auto-calculate from" (empty weight_log AND no
      // profile.weight_goal_kg) — distinct from sat_fat_incomplete/sugar_incomplete,
      // which flag missing LOGGED-ENTRY fields, not a missing GOAL input.
      summary.protein_incomplete = weightKg <= 0

      summary.fat_goal_g = macros.fat_point_g
      summary.fat_goal_min_g = macros.fat_min_g
      summary.fat_goal_max_g = macros.fat_max_g
      summary.fat_status = rangeStatus(summary.fat_g, macros.fat_min_g, macros.fat_max_g)

      summary.carbs_goal_g = macros.carbs_point_g
      summary.carbs_goal_min_g = macros.carbs_min_g
      summary.carbs_goal_max_g = macros.carbs_max_g

      // Fiber (14 g/1000 kcal) — a target to REACH, not a ceiling, so it uses
      // goalStatus (the inverse ladder of limitStatus), never satFatStatus/sugarStatus.
      summary.fiber_goal_g = resolveFiberGoalG(profile, kcalBasis)
      summary.fiber_status = goalStatus(summary.fiber_g, summary.fiber_goal_g)

      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }

  // POST /api/nutrition
  // #1297: `normalizeNutrition` runs FIRST so the `name` → `food_name` alias
  // (still supported by the in-handler normalization below) resolves BEFORE
  // `requireFields` checks for it — otherwise a legacy caller sending `name`
  // would be wrongly 400'd. Confirmed live writers (Nutrition.jsx submitFood/
  // addSuggestedFood, Today.jsx saveNutriQuick, PhotoRecognize.jsx handleLog)
  // all send food_name/kcal/meal_type unconditionally — grepped 2026-09-12,
  // `grep -rn "API}/nutrition\`" health-dashboard/src`. `nutrition_log` had 4
  // documents missing food_name before this fix (#1297 audit).
  router.post('/', normalizeNutrition, requireFields('food_name', 'kcal', 'meal_type'), validateDate, async (req, res) => {
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

  // GET /api/nutrition/frequent — #873 Частина 2(а): «Мої продукти» ranked by
  // REAL usage frequency straight from nutrition_log (never foods_library's
  // use_count, which was silently stuck at 0/1 for 49/50 foods — see the
  // /api/foods/:id/log-use fix). Each entry carries the LAST-used portion so the
  // frontend can add it in a single tap with no modal/amount re-entry.
  router.get('/frequent', async (req, res) => {
    try {
      const db = getDB()
      const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50)
      const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365)
      const sinceDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

      const logs = await db.collection('nutrition_log')
        .find({ date: { $gte: sinceDate } })
        .sort({ date: -1 }) // most recent first, so the FIRST occurrence per name is the last use
        .toArray()

      const byName = new Map()
      for (const e of logs) {
        const name = typeof e.food_name === 'string' ? e.food_name.trim() : ''
        if (!name) continue
        if (!byName.has(name)) byName.set(name, { name, count: 0, last: e })
        byName.get(name).count += 1
      }

      const top = [...byName.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map(({ name, count, last }) => ({
          food_name: name,
          use_count: count,
          last_date: last.date,
          last_meal_type: last.meal_type || null,
          last_amount_g: last.amount_g ?? null,
          last_food_id: last.food_id ?? null,
          last_kcal: last.kcal ?? null,
          last_protein_g: last.protein_g ?? null,
          last_fat_g: last.fat_g ?? null,
          last_carbs_g: last.carbs_g ?? null,
          last_fiber_g: last.fiber_g ?? null,
          last_sugar_g: last.sugar_g ?? null,
          last_sat_fat_g: last.sat_fat_g ?? null,
        }))

      res.json(top)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/nutrition/repeat — #873 Частина 2(б): «Повторити вчорашній
  // сніданок / вчорашній день». `date` = the day being populated (the date the
  // user is viewing — same "viewed date, not real today" discipline as
  // submitFood(), #872-1 class); source day is ALWAYS `date - 1 calendar day`.
  // `meal_type` optional — omitted copies the whole day, present copies just
  // that one meal. Calendar-day subtraction on the YYYY-MM-DD STRING (no
  // timezone conversion) — dates are already stored as Kyiv-day strings
  // everywhere in this API, so a plain -1 day is correct and boundary-free.
  router.post('/repeat', async (req, res) => {
    try {
      const db = getDB()
      const { date, meal_type } = req.body
      if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' })
      }
      const sourceDateObj = new Date(date + 'T00:00:00Z')
      sourceDateObj.setUTCDate(sourceDateObj.getUTCDate() - 1)
      const sourceDate = sourceDateObj.toISOString().split('T')[0]

      const filter = meal_type ? { date: sourceDate, meal_type } : { date: sourceDate }
      const sourceEntries = await db.collection('nutrition_log').find(filter).toArray()

      if (sourceEntries.length === 0) {
        return res.json({ inserted: 0, source_date: sourceDate, entries: [] })
      }

      const now = new Date()
      const docs = sourceEntries.map((e) => {
        // eslint-disable-next-line no-unused-vars
        const { _id, created_at, date: _oldDate, ...rest } = e
        return { ...rest, date, created_at: now, repeated_from_date: sourceDate }
      })
      const result = await db.collection('nutrition_log').insertMany(docs)
      const inserted = docs.map((d, i) => ({ ...d, _id: result.insertedIds[i] }))
      res.status(201).json({ inserted: inserted.length, source_date: sourceDate, entries: inserted })
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

      // #873 Частина 2(в): HISTORY FIRST — Дмитро's own nutrition_log for this
      // meal_type, aggregated into per-100g macros + HIS OWN average real amount_g.
      // Previously this endpoint only knew library + an abstract COMMON_FOODS list
      // with no fiber data and no realistic portion bound — the kcal-target division
      // alone could suggest 500g of anything (task #873 premise). Real logged amounts
      // fix both: they carry fiber (unlike COMMON_FOODS) and give a sane portion range.
      const historyFilter = meal_type
        ? { meal_type, amount_g: { $gt: 0 }, kcal: { $gt: 0 } }
        : { amount_g: { $gt: 0 }, kcal: { $gt: 0 } }
      const historyLogs = await db.collection('nutrition_log').find(historyFilter).toArray()
      const historyByName = new Map()
      for (const e of historyLogs) {
        const name = typeof e.food_name === 'string' ? e.food_name.trim() : ''
        const amount = Number(e.amount_g)
        if (!name || !Number.isFinite(amount) || amount <= 0) continue
        const kcalPer100 = (Number(e.kcal) || 0) / amount * 100
        if (!Number.isFinite(kcalPer100) || kcalPer100 <= 0) continue
        if (!historyByName.has(name)) {
          historyByName.set(name, { name, n: 0, kcal100: 0, protein100: 0, fat100: 0, carbs100: 0, sugar100: 0, fiber100: 0, amountSum: 0 })
        }
        const agg = historyByName.get(name)
        agg.n += 1
        agg.kcal100 += kcalPer100
        agg.protein100 += (Number(e.protein_g) || 0) / amount * 100
        agg.fat100 += (Number(e.fat_g) || 0) / amount * 100
        agg.carbs100 += (Number(e.carbs_g) || 0) / amount * 100
        agg.sugar100 += (Number(e.sugar_g) || 0) / amount * 100
        agg.fiber100 += (Number(e.fiber_g) || 0) / amount * 100
        agg.amountSum += amount
      }
      const historyNormalized = [...historyByName.values()].map(a => ({
        name: a.name,
        kcal_per_100g: Math.round(a.kcal100 / a.n),
        protein_per_100g: Math.round((a.protein100 / a.n) * 10) / 10,
        fat_per_100g: Math.round((a.fat100 / a.n) * 10) / 10,
        carbs_per_100g: Math.round((a.carbs100 / a.n) * 10) / 10,
        sugar_per_100g: Math.round((a.sugar100 / a.n) * 10) / 10,
        fiber_per_100g: Math.round((a.fiber100 / a.n) * 10) / 10,
        avg_amount_g: Math.round(a.amountSum / a.n),
        use_count: a.n,
        source: 'history',
      }))
      const historyNames = new Set(historyNormalized.map(f => f.name.toLowerCase()))

      // Fetch library foods — skip names already covered by history (history carries
      // Дмитро's OWN averaged macros/amount for that exact name, a strictly more
      // realistic signal than the generic library entry of the same name).
      const libraryFoods = await db.collection('foods_library').find({}).toArray()
      // #926: a foods_library doc can be missing `name` (a partial/broken write — 1 of 172 docs
      // in prod as of 2026-08-07, use_count:0, not a systemic writer bug). Drop such docs before
      // any .toLowerCase()/dedup logic below, instead of crashing the whole endpoint on one bad row.
      const libraryNormalized = libraryFoods
        .filter(f => typeof f?.name === 'string' && f.name.trim())
        .filter(f => !historyNames.has(f.name.trim().toLowerCase()))
        .map(f => ({
          name: f.name,
          kcal_per_100g: f.kcal_per_100g,
          protein_per_100g: f.protein_per_100g,
          fat_per_100g: f.fat_per_100g,
          carbs_per_100g: f.carbs_per_100g,
          sugar_per_100g: f.sugar_per_100g || 0,
          fiber_per_100g: f.fiber_per_100g || 0,
          // #873 Частина 2(д): serving_size_g doubles as the realistic-portion anchor
          // when a library food has no logged history yet.
          avg_amount_g: Number.isFinite(f.serving_size_g) && f.serving_size_g > 0 ? f.serving_size_g : null,
          source: 'library',
        }))

      // COMMON_FOODS is now a LAST-RESORT fallback, not an equal partner (#873 —
      // Дмитро's own history/library must win whenever there is enough real data to
      // suggest from) — only topped up when history+library together are too thin.
      const MIN_REAL_CANDIDATES = 3
      const realCandidates = [...historyNormalized, ...libraryNormalized]
      const existingNames = new Set(realCandidates.map(f => f.name.toLowerCase()))
      const commonFoodsNorm = realCandidates.length < MIN_REAL_CANDIDATES
        ? COMMON_FOODS.filter(f => !existingNames.has(f.name.toLowerCase())).map(f => ({ ...f, avg_amount_g: null, source: 'common' }))
        : []
      const allFoods = [...realCandidates, ...commonFoodsNorm]

      // Score each food — MACRO FIT is the primary metric, calories secondary
      const scored = allFoods
        .filter(food => food.kcal_per_100g > 0)
        .map(food => {
          // Calculate amount to hit target kcal, but clamp to a REALISTIC portion when
          // a real average/serving amount is known (history or library serving_size_g):
          // [0.5x, 1.6x] of that real amount — a food normally eaten at ~150g must never
          // be suggested at 500g just because the kcal math wants it (#873 premise). No
          // known real amount (COMMON_FOODS fallback only) keeps the old [30,500] band.
          const idealFromTarget = Math.round((targetKcal / food.kcal_per_100g) * 100)
          const amount = food.avg_amount_g
            ? Math.min(Math.round(food.avg_amount_g * 1.6), Math.max(Math.round(food.avg_amount_g * 0.5), idealFromTarget))
            : Math.min(500, Math.max(30, idealFromTarget))
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
