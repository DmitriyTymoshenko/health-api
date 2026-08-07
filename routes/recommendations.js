const { Router } = require('express')
const { resolveDayKcalTarget, satFatLimitBasisKcal, satFatLimitG, satFatStatus } = require('../lib/nutrition-targets')

// High-protein suggestions pool
const HIGH_PROTEIN_POOL = [
  { name: 'Куряче філе 200г', calories: 220, protein: 44, note: 'Краще на пару або гриль' },
  { name: 'Яловичина 150г', calories: 270, protein: 38, note: 'Нежирна частина — вирізка або лопатка' },
  { name: 'Яйця 3шт', calories: 210, protein: 18, note: 'Омлет або варені' },
  { name: 'Pro Feel протеїн', calories: 120, protein: 24, note: 'Сироватковий — засвоюється за 1-2г' },
  { name: 'Сир твердий 50г', calories: 190, protein: 13, note: 'Пармезан або гауда' },
  { name: 'Риба (лосось 150г)', calories: 280, protein: 35, note: 'Омега-3 + повноцінний білок' },
  { name: 'Сирники 3шт', calories: 380, protein: 22, note: 'Казеїновий білок — повільне засвоєння, ідеально на ніч' },
  { name: 'Fitwin', calories: 140, protein: 20, note: 'Комплексний білок' },
  { name: 'Грецький йогурт 200г', calories: 160, protein: 20, note: 'Пробіотики + білок' },
  { name: 'Бобові (сочевиця 150г)', calories: 170, protein: 13, note: 'Рослинний білок + клітковина' },
]

// Evening low-GI suggestions
const LOW_GI_SUGGESTIONS = [
  { name: 'Риба на грилі 200г + овочі', calories: 350, protein: 40, note: 'Низький ГІ, легко засвоюється' },
  { name: 'Сирники з сметаною', calories: 400, protein: 25, note: 'Казеїновий білок — повільне засвоєння, ідеально на ніч' },
  { name: 'Куряче філе + брокколі', calories: 280, protein: 42, note: 'Мінімум вуглеводів, максимум білка' },
  { name: 'Омлет 3 яйця + шпинат', calories: 240, protein: 21, note: 'Легко, без вуглеводів' },
  { name: 'Грецький йогурт + горіхи', calories: 280, protein: 20, note: 'Казеїн + корисні жири на ніч' },
]

// Snack suggestions
const SNACK_SUGGESTIONS = [
  { name: 'Грецький йогурт 150г', calories: 120, protein: 15, note: 'Легкий перекус, пробіотики' },
  { name: 'Яйця 2шт варені', calories: 140, protein: 12, note: 'Зручно взяти з собою' },
  { name: 'Сир + огірок', calories: 180, protein: 12, note: 'Швидко та ситно' },
  { name: 'Горіхи 30г + яблуко', calories: 230, protein: 6, note: 'Корисні жири + клітковина' },
]

// Breakfast suggestions
const BREAKFAST_SUGGESTIONS = [
  { name: 'Омлет 3 яйця + сир', calories: 320, protein: 28, note: 'Відмінний старт дня' },
  { name: 'Вівсянка 60г + протеїн', calories: 350, protein: 28, note: 'Повільні вуглеводи + білок' },
  { name: 'Грецький йогурт 200г + горіхи', calories: 280, protein: 22, note: 'Швидко та поживно' },
  { name: 'Яйця 2шт + авокадо', calories: 300, protein: 16, note: 'Корисні жири + білок' },
]

// Food lists for bioavailability detection
const IRON_RICH_FOODS = ['м\'ясо', 'яловичина', 'печінка', 'шпинат', 'сочевиця', 'квасоля', 'мітбол', 'бургер', 'стейк']
const FAT_SOLUBLE_VITAMIN_FOODS = ['морква', 'солодкий перець', 'перець', 'гарбуз', 'брокколі', 'кукурудза']
const HIGH_GI_FOODS = ['рис', 'картопля', 'хліб', 'чіпси', 'цукор', 'пирі', 'торт', 'пахлав', 'бісквіт', 'попкорн']

// Meal order for the day
const MEAL_ORDER = ['breakfast', 'lunch', 'snack', 'dinner']

// Options database — concrete Ukrainian-relevant meals
function getMealOptions(mealType, calBudget, proBudget, summary) {
  const allOptions = {
    breakfast: [
      { name: 'Омлет з сиром і шинкою', cal: 370, pro: 26, fat: 28, carbs: 2, note: 'Швидко, без вуглеводів' },
      { name: 'Протеінова гранола 100г + молоко', cal: 450, pro: 22, fat: 14, carbs: 50, note: 'Повільні вуглеводи = енергія до обіду' },
      { name: 'Pro Feel + яйця 2шт', cal: 280, pro: 30, fat: 12, carbs: 6, note: 'Легкий сніданок з акцентом на білок' },
      { name: 'Сирники 3шт зі сметаною', cal: 420, pro: 24, fat: 18, carbs: 30, note: 'Казеїновий білок — тримає до обіду' },
      { name: 'Йогурт протеіновий + гранола 50г', cal: 350, pro: 28, fat: 8, carbs: 35, note: 'Швидко і збалансовано' },
    ],
    lunch: [
      { name: 'Куряче філе 200г + гречка 150г', cal: 430, pro: 48, fat: 8, carbs: 40, note: 'Класика — повний амінокислотний профіль' },
      { name: 'Лосось 200г + овочі на грилі', cal: 480, pro: 42, fat: 22, carbs: 12, note: 'Омега-3 + повноцінний білок' },
      { name: 'Боул з тунцем і рисом', cal: 450, pro: 38, fat: 6, carbs: 52, note: 'Низький жир, багато білка' },
      { name: 'Яловичина 150г + картопля', cal: 520, pro: 38, fat: 18, carbs: 38, note: 'Залізо + білок, ситне' },
      { name: 'Курячий суп + хліб', cal: 350, pro: 28, fat: 8, carbs: 32, note: 'Легко засвоюється' },
    ],
    snack: [
      { name: 'Pro Feel 1 упаковка', cal: 114, pro: 19, fat: 0.4, carbs: 9, note: 'Чистий білок, 0 жиру' },
      { name: 'Fitwin батончик', cal: 219, pro: 20, fat: 8, carbs: 6, note: 'Зручно + клітковина' },
      { name: 'Горіхи 30г + яблуко', cal: 230, pro: 6, fat: 16, carbs: 18, note: 'Корисні жири + клітковина' },
      { name: 'Яйця варені 2шт', cal: 140, pro: 12, fat: 10, carbs: 1, note: 'Мінімум калорій, максимум білка' },
      { name: 'Грецький йогурт 200г', cal: 160, pro: 20, fat: 4, carbs: 8, note: 'Пробіотики + казеїн' },
    ],
    dinner: [
      { name: 'Риба на грилі 200г + броколі', cal: 320, pro: 42, fat: 10, carbs: 8, note: 'Ідеально на ніч — низький ГІ' },
      { name: 'Куряче філе 200г + салат', cal: 300, pro: 44, fat: 8, carbs: 6, note: 'Максимум білка, мінімум вуглеводів' },
      { name: 'Сирники 3шт зі сметаною', cal: 420, pro: 24, fat: 18, carbs: 30, note: 'Казеїн на ніч — повільне засвоєння' },
      { name: 'Омлет 3 яйця + овочі', cal: 280, pro: 20, fat: 20, carbs: 8, note: 'Легко, без вуглеводів' },
      { name: 'Яловичина 150г + овочі', cal: 380, pro: 38, fat: 16, carbs: 12, note: 'М\'язовий ріст уночі' },
    ],
  }

  const options = (allOptions[mealType] || allOptions.dinner)
    .map(o => ({ ...o, diff: Math.abs(o.cal - calBudget) }))
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 3)
    .map(({ diff, ...o }) => o)

  return options
}

function getKyivHour() {
  const kyivTime = new Date().toLocaleString('uk', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false })
  return parseInt(kyivTime)
}

function getMealTiming(hour) {
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  if (hour < 18) return 'snack'
  return 'dinner'
}

function containsAny(text, keywords) {
  const lower = (text || '').toLowerCase()
  return keywords.some(kw => lower.includes(kw.toLowerCase()))
}

function selectHighProteinSuggestions(proteinGap, count = 3) {
  // Sort by protein descending if big gap, else mix
  const sorted = proteinGap > 30
    ? [...HIGH_PROTEIN_POOL].sort((a, b) => b.protein - a.protein)
    : HIGH_PROTEIN_POOL
  return sorted.slice(0, count)
}

// Determine last meal type from nutrition entries sorted by created_at
function getLastMealType(entries) {
  if (!entries || entries.length === 0) return null
  const sorted = [...entries].sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
    const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
    return bTime - aTime
  })
  return sorted[0].meal_type || null
}

// Determine next meal based on last meal and time of day
function getNextMeal(lastMeal, currentHour) {
  if (!lastMeal) return getMealTiming(currentHour)
  const idx = MEAL_ORDER.indexOf(lastMeal)
  if (idx === -1 || idx === MEAL_ORDER.length - 1) return null // after dinner or unknown
  return MEAL_ORDER[idx + 1]
}

// Build post_meal_strategy field
function buildPostMealStrategy(entries, remainingCalories, remainingProtein, currentHour) {
  const lastMeal = getLastMealType(entries)
  if (!lastMeal && entries.length === 0) {
    // No meals logged yet
    return {
      last_meal: null,
      message: 'Ще не залогував жодного прийому. Починай із сніданку для запуску метаболізму.',
      next_meal: 'breakfast',
      next_meal_budget: {
        calories: Math.round(remainingCalories * 0.25),
        protein: Math.round(remainingProtein * 0.25),
      },
    }
  }

  const nextMeal = getNextMeal(lastMeal, currentHour)

  // All meals done
  if (!nextMeal) {
    if (remainingCalories > 100) {
      return {
        last_meal: lastMeal,
        message: `Вечеря завершена. Залишилось ${Math.round(remainingCalories)} ккал — можна легкий перекус якщо голодний. Пріоритет — білок.`,
        next_meal: null,
        next_meal_budget: null,
      }
    }
    return {
      last_meal: lastMeal,
      message: 'Відмінний день! Калорійна ціль виконана. Відпочивай — наступний цикл завтра зранку.',
      next_meal: null,
      next_meal_budget: null,
    }
  }

  // Calculate next meal budget
  let nextBudgetCalories, nextBudgetProtein
  if (nextMeal === 'snack') {
    nextBudgetCalories = Math.round(remainingCalories * 0.25)
    nextBudgetProtein = Math.round(remainingProtein * 0.20)
  } else if (nextMeal === 'dinner') {
    nextBudgetCalories = Math.round(remainingCalories * 0.70)
    nextBudgetProtein = Math.round(remainingProtein * 0.80)
  } else if (nextMeal === 'lunch') {
    nextBudgetCalories = Math.round(remainingCalories * 0.45)
    nextBudgetProtein = Math.round(remainingProtein * 0.45)
  } else {
    nextBudgetCalories = Math.round(remainingCalories * 0.30)
    nextBudgetProtein = Math.round(remainingProtein * 0.30)
  }

  const mealNames = {
    breakfast: 'сніданок',
    lunch: 'обід',
    snack: 'перекус',
    dinner: 'вечеря',
  }
  const lastMealName = mealNames[lastMeal] || lastMeal
  const nextMealName = mealNames[nextMeal] || nextMeal

  let message = `Після ${lastMealName}у залишилось ${Math.round(remainingCalories)} ккал.`
  if (remainingProtein > 30) {
    message += ` Наступний ${nextMealName} — пріоритет білок (${Math.round(remainingProtein)}г deficit).`
  } else {
    message += ` Наступний ${nextMealName} — ${nextBudgetCalories} ккал.`
  }
  if (nextMeal === 'dinner') {
    message += ' Уникай вуглеводів після 19:00.'
  }

  return {
    last_meal: lastMeal,
    message,
    next_meal: nextMeal,
    next_meal_budget: {
      calories: nextBudgetCalories,
      protein: nextBudgetProtein,
    },
  }
}

module.exports = function (getDB) {
  const router = Router()

  // GET /api/recommendations?date=YYYY-MM-DD
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || new Date().toISOString().split('T')[0]

      // 1. Fetch today's nutrition
      const nutritionEntries = await db.collection('nutrition_log').find({ date }).toArray()

      // 2. Fetch user profile for targets
      let profile = await db.collection('personal_profile').findOne({ _type: 'profile' })
      if (!profile) {
        // Use defaults matching personal_profile.js defaults
        profile = {
          daily_kcal_goal: null,
          tdee_kcal: 2429,
          deficit_kcal: 500,
          daily_protein_goal_g: 150,
          primary_goal: 'weight_loss',
        }
      }

      // Also try settings for real calorie goal
      const settings = await db.collection('user_settings').findOne({})

      // Get WHOOP calories burned for today
      const whoopCycle = await db.collection('whoop_cycles').findOne({ date })
      const caloriesBurned = whoopCycle?.calories_burned || null

      // Get deficit goal from profile (default 500 kcal)
      const deficitGoal = profile?.deficit_kcal || 500

      // Calculate targets
      // Dynamic calorie target: burned - deficit (if WHOOP data exists)
      // Fall back to profile target if no WHOOP data.
      // Shared helper — GET /api/nutrition/summary derives the SAME target (BASE RULE).
      const targetCalories = resolveDayKcalTarget(profile, caloriesBurned)
      const targetProtein = profile.daily_protein_goal_g || 150
      // Macro split: 33% protein, 40% carbs, 27% fat
      const targetCarbs = Math.round(targetCalories * 0.407 / 4)
      const targetFat = Math.round(targetCalories * 0.266 / 9)
      // Saturated fat is a CEILING, not a goal: ≤10% of the day's calories.
      const targetSatFat = satFatLimitG(satFatLimitBasisKcal(profile))

      // 3. Calculate consumed totals
      const consumed = nutritionEntries.reduce(
        (acc, entry) => {
          acc.calories += entry.kcal || entry.calories || 0
          acc.protein += entry.protein_g || 0
          acc.carbs += entry.carbs_g || 0
          acc.fat += entry.fat_g || 0
          // Historical entries predate sat_fat_g — fall back to 0 and flag the day
          // as incomplete so the UI never presents an understated total as a fact.
          acc.sat_fat += entry.sat_fat_g || 0
          if (entry.sat_fat_g == null) acc.sat_fat_incomplete = true
          return acc
        },
        { calories: 0, protein: 0, carbs: 0, fat: 0, sat_fat: 0, sat_fat_incomplete: false }
      )

      // 4. Calculate gaps
      const remainingCalories = Math.max(0, targetCalories - consumed.calories)
      const remainingProtein = Math.max(0, targetProtein - consumed.protein)
      const remainingCarbs = Math.max(0, targetCarbs - consumed.carbs)
      const remainingFat = Math.max(0, targetFat - consumed.fat)

      // Collect all food names eaten today
      const foodNamesEaten = nutritionEntries.map(e => e.food_name || '')

      // 5. Check bioavailability conditions
      const hasIronRichFood = foodNamesEaten.some(name => containsAny(name, IRON_RICH_FOODS))
      const hasFatSolubleVitaminFood = foodNamesEaten.some(name => containsAny(name, FAT_SOLUBLE_VITAMIN_FOODS))
      const hasHighGIFoodToday = foodNamesEaten.some(name => containsAny(name, HIGH_GI_FOODS))

      // 6. Determine time-based meal recommendations
      const kyivHour = getKyivHour()
      const isEvening = kyivHour >= 18
      const currentMealTiming = getMealTiming(kyivHour)
      const proteinGap = remainingProtein

      // 7. Build meal recommendations
      const meals = []

      if (currentMealTiming === 'breakfast') {
        const suggestions = proteinGap > 20
          ? BREAKFAST_SUGGESTIONS.filter(s => s.protein >= 20).slice(0, 3)
          : BREAKFAST_SUGGESTIONS.slice(0, 3)
        meals.push({
          type: 'breakfast',
          title: 'Сніданок',
          reason: proteinGap > 30
            ? `Великий дефіцит білка (${Math.round(proteinGap)}г залишилось)`
            : `Залишилось ${Math.round(remainingCalories)} ккал`,
          suggestions,
        })
        // Also recommend lunch if calories remaining > 600
        if (remainingCalories > 600) {
          const lunchSuggestions = selectHighProteinSuggestions(proteinGap, 3)
          meals.push({
            type: 'lunch',
            title: 'Обід (план)',
            reason: `Плануйте наперед — ще ${Math.round(remainingCalories - 500)} ккал на обід`,
            suggestions: lunchSuggestions,
          })
        }
      } else if (currentMealTiming === 'lunch') {
        const lunchSuggestions = proteinGap > 30
          ? selectHighProteinSuggestions(proteinGap, 3)
          : BREAKFAST_SUGGESTIONS.slice(0, 3)
        meals.push({
          type: 'lunch',
          title: 'Обід',
          reason: proteinGap > 30
            ? `Великий дефіцит білка (${Math.round(proteinGap)}г залишилось)`
            : `Залишилось ${Math.round(remainingCalories)} ккал`,
          suggestions: lunchSuggestions,
        })
        if (remainingCalories > 400) {
          meals.push({
            type: 'dinner',
            title: 'Вечеря (план)',
            reason: `Вечір — краще білок + овочі, залишилось ~${Math.round(Math.max(0, remainingCalories - 400))} ккал`,
            suggestions: LOW_GI_SUGGESTIONS.slice(0, 3),
          })
        }
      } else if (currentMealTiming === 'snack') {
        meals.push({
          type: 'snack',
          title: 'Перекус',
          reason: `Між обідом і вечерею — легкий перекус до ${Math.min(200, Math.round(remainingCalories / 2))} ккал`,
          suggestions: SNACK_SUGGESTIONS,
        })
        if (remainingCalories > 300) {
          meals.push({
            type: 'dinner',
            title: 'Вечеря (план)',
            reason: `Ввечері — низький ГІ, залишилось ~${Math.round(remainingCalories - 150)} ккал`,
            suggestions: LOW_GI_SUGGESTIONS.slice(0, 3),
          })
        }
      } else {
        // Evening
        const dinnerSuggestions = proteinGap > 20
          ? LOW_GI_SUGGESTIONS.filter(s => s.protein >= 20).concat(LOW_GI_SUGGESTIONS).slice(0, 3)
          : LOW_GI_SUGGESTIONS.slice(0, 3)
        meals.push({
          type: 'dinner',
          title: 'Вечеря',
          reason: remainingCalories > 0
            ? `Залишок ${Math.round(remainingCalories)} ккал, вечір — краще білок + овочі`
            : 'Калорійна ціль виконана — легка вечеря якщо голодний',
          suggestions: dinnerSuggestions,
        })
        // Add high protein if big gap
        if (proteinGap > 30) {
          const proteinSuggestions = selectHighProteinSuggestions(proteinGap, 3)
          meals.unshift({
            type: 'protein_boost',
            title: 'Додатковий білок',
            reason: `Дефіцит білка критичний (${Math.round(proteinGap)}г залишилось)`,
            suggestions: proteinSuggestions,
          })
        }
      }

      // 8. Build bioavailability tips
      const bioavailabilityTips = []

      if (hasIronRichFood) {
        bioavailabilityTips.push({
          icon: '🩸',
          tip: 'Сьогодні їв м\'ясо — залізо добре засвоїлось. Додай вітамін C (лимон, перець) до наступного прийому для максимуму',
        })
      }

      if (hasFatSolubleVitaminFood) {
        bioavailabilityTips.push({
          icon: '🥕',
          tip: 'Їв каротиновмісні продукти — вітамін A засвоїться краще з жиром. Додай авокадо або оливкову олію',
        })
      }

      bioavailabilityTips.push({
        icon: '💊',
        tip: 'Якщо приймаєш вітамін D — їж разом з жирною їжею (авокадо, горіхи, олія)',
      })

      if (isEvening && hasHighGIFoodToday) {
        bioavailabilityTips.push({
          icon: '⚠️',
          tip: 'Сьогодні їв продукти з високим ГІ. Ввечері уникай простих вуглеводів — вибирай білок та овочі',
        })
      }

      if (proteinGap > 40) {
        bioavailabilityTips.push({
          icon: '💪',
          tip: `Критичний дефіцит білка (${Math.round(proteinGap)}г). Сироватковий протеїн засвоюється за 1-2г — ідеально після тренування`,
        })
      }

      // 9. Build daily insight
      let dailyInsight = ''
      if (remainingCalories <= 0) {
        dailyInsight = `Калорійна ціль (${Math.round(targetCalories)} ккал) виконана. ${proteinGap > 20 ? `Ще ${Math.round(proteinGap)}г білка бракує — обери низькокалорійне джерело.` : 'Гарна робота!'}`
      } else {
        const parts = [`На сьогодні ${Math.round(remainingCalories)} ккал залишилось.`]
        if (proteinGap > 30) parts.push(`Пріоритет — білок (${Math.round(proteinGap)}г deficit).`)
        if (isEvening) parts.push('Вечір: уникай простих вуглеводів.')
        else if (currentMealTiming === 'breakfast') parts.push('Зроби хороший сніданок для старту метаболізму.')
        dailyInsight = parts.join(' ')
      }

      // 10. Build post_meal_strategy
      const postMealStrategy = buildPostMealStrategy(
        nutritionEntries,
        remainingCalories,
        remainingProtein,
        kyivHour
      )

      // 10b. Build meal_plan for remaining meals of the day
      const loggedMealTypes = new Set(nutritionEntries.map(e => e.meal_type))
      const allMeals = ['breakfast', 'lunch', 'snack', 'dinner']
      const remainingMeals = allMeals.filter(m => !loggedMealTypes.has(m))

      const mealBudgets = {
        breakfast: { cal_pct: 0.25, pro_pct: 0.25 },
        lunch:     { cal_pct: 0.35, pro_pct: 0.35 },
        snack:     { cal_pct: 0.15, pro_pct: 0.15 },
        dinner:    { cal_pct: 0.25, pro_pct: 0.25 },
      }

      const remainingCalTotal = remainingMeals.reduce((s, m) => s + mealBudgets[m].cal_pct, 0) || 1
      const remainingProTotal = remainingMeals.reduce((s, m) => s + mealBudgets[m].pro_pct, 0) || 1

      const mealPlanSummary = {
        calories_remaining: Math.round(remainingCalories),
        protein_remaining: Math.round(remainingProtein),
      }

      const meal_plan = remainingMeals.map(mealType => {
        const calBudget = Math.round(remainingCalories * (mealBudgets[mealType].cal_pct / remainingCalTotal))
        const proBudget = Math.round(remainingProtein * (mealBudgets[mealType].pro_pct / remainingProTotal))

        return {
          meal_type: mealType,
          label: { breakfast: 'Сніданок', lunch: 'Обід', snack: 'Перекус', dinner: 'Вечеря' }[mealType],
          budget: { calories: calBudget, protein: proBudget },
          options: getMealOptions(mealType, calBudget, proBudget, mealPlanSummary),
        }
      })

      // 11. Build response
      const response = {
        date,
        summary: {
          calories_consumed: Math.round(consumed.calories),
          calories_target: Math.round(targetCalories),
          calories_remaining: Math.round(remainingCalories),
          whoop_calories_burned: caloriesBurned,
          whoop_based: !!caloriesBurned,
          deficit_goal: deficitGoal,
          protein_consumed: Math.round(consumed.protein),
          protein_target: Math.round(targetProtein),
          protein_remaining: Math.round(remainingProtein),
          carbs_consumed: Math.round(consumed.carbs),
          carbs_target: targetCarbs,
          carbs_remaining: Math.round(remainingCarbs),
          fat_consumed: Math.round(consumed.fat),
          fat_target: targetFat,
          fat_remaining: Math.round(remainingFat),
          sat_fat_consumed: Math.round(consumed.sat_fat * 10) / 10,
          sat_fat_limit: targetSatFat,
          sat_fat_remaining: Math.round(Math.max(0, targetSatFat - consumed.sat_fat) * 10) / 10,
          sat_fat_status: satFatStatus(consumed.sat_fat, targetSatFat),
          sat_fat_incomplete: consumed.sat_fat_incomplete,
        },
        meals,
        meal_plan,
        bioavailability_tips: bioavailabilityTips,
        daily_insight: dailyInsight,
        post_meal_strategy: postMealStrategy,
        meta: {
          kyiv_hour: kyivHour,
          meal_timing: currentMealTiming,
          is_evening: isEvening,
          has_iron_rich_food: hasIronRichFood,
          has_high_gi_food: hasHighGIFoodToday,
          entries_count: nutritionEntries.length,
        },
      }

      res.json(response)
    } catch (err) {
      console.error('Recommendations error:', err)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/recommendations/weekly
  router.get('/weekly', async (req, res) => {
    try {
      const db = getDB()

      // Fetch profile for targets
      let profile = await db.collection('personal_profile').findOne({ _type: 'profile' })
      if (!profile) {
        profile = {
          daily_kcal_goal: null,
          tdee_kcal: 2429,
          deficit_kcal: 500,
          daily_protein_goal_g: 150,
          primary_goal: 'weight_loss',
        }
      }

      const tdee = profile.tdee_kcal || 2429
      const deficit = profile.deficit_kcal || 500
      const targetCalories = profile.daily_kcal_goal || (tdee - deficit)
      const targetProtein = profile.daily_protein_goal_g || 150

      // Build list of last 7 days (today inclusive)
      const todayDate = new Date()
      const days = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date(todayDate)
        d.setDate(d.getDate() - i)
        days.push(d.toISOString().split('T')[0])
      }
      const startDate = days[0]
      const today = days[days.length - 1]

      // Fetch all nutrition entries for last 7 days
      const allEntries = await db.collection('nutrition_log')
        .find({ date: { $in: days } })
        .toArray()

      // Fetch WHOOP cycles for last 7 days
      const whoopCycles = await db.collection('whoop_cycles')
        .find({ date: { $gte: startDate, $lte: today } })
        .toArray()

      const whoopByDate = {}
      whoopCycles.forEach(c => { whoopByDate[c.date] = c })

      const deficitGoal = profile?.deficit_kcal || 500

      // Group by date and sum macros
      const dayMap = {}
      for (const day of days) {
        dayMap[day] = { calories: 0, protein: 0, carbs: 0, fat: 0 }
      }
      for (const entry of allEntries) {
        if (dayMap[entry.date]) {
          dayMap[entry.date].calories += entry.kcal || entry.calories || 0
          dayMap[entry.date].protein += entry.protein_g || 0
          dayMap[entry.date].carbs += entry.carbs_g || 0
          dayMap[entry.date].fat += entry.fat_g || 0
        }
      }

      // Build days array with surplus/deficit using per-day WHOOP target
      const daysArray = days.map(date => {
        const d = dayMap[date]
        const whoopDay = whoopByDate[date]
        const burned = whoopDay?.calories_burned || null
        const dayTarget = burned && burned > 1200
          ? Math.round(burned - deficitGoal)
          : targetCalories
        const dayConsumed = Math.round(d.calories)
        // deficit = consumed - burned (negative = deficit, target = -500)
        const surplusDeficit = burned
          ? Math.round(dayConsumed - burned)
          : Math.round(dayConsumed - dayTarget)
        return {
          date,
          calories: dayConsumed,
          protein: Math.round(d.protein),
          carbs: Math.round(d.carbs),
          fat: Math.round(d.fat),
          surplus_deficit: surplusDeficit,
          burned,
          target: dayTarget,
        }
      })

      // Weekly averages (only days with data)
      const daysWithData = daysArray.filter(d => d.calories > 0)
      const daysCount = daysWithData.length || 1

      const avgCalories = Math.round(daysWithData.reduce((s, d) => s + d.calories, 0) / daysCount)
      const avgProtein = Math.round(daysWithData.reduce((s, d) => s + d.protein, 0) / daysCount)
      // avg_deficit = avg(consumed - burned): negative = deficit (good), target = -500
      const avgDeficit = Math.round(daysWithData.reduce((s, d) => s + d.surplus_deficit, 0) / daysCount)

      // Average target across days with data (for summary)
      const avgTarget = Math.round(daysWithData.reduce((s, d) => s + d.target, 0) / daysCount)
      const hasWhoopData = whoopCycles.length > 0

      // Pattern detection
      const surplusDays = daysArray.filter(d => d.surplus_deficit > 300 && d.calories > 0)
      const underEatingDays = daysArray.filter(d => d.calories > 0 && d.calories < d.target - 800)
      const proteinDeficitDays = daysArray.filter(d => d.calories > 0 && d.protein < targetProtein * 0.8)
      const highCarbDays = daysArray.filter(d => {
        if (d.calories === 0) return false
        const carbKcal = d.carbs * 4
        return carbKcal / d.calories > 0.6
      })
      const allInDeficit = daysWithData.length >= 5 && daysWithData.every(d => d.surplus_deficit <= 0)

      const proteinGap = Math.max(0, targetProtein - avgProtein)
      const weeklyProteinGap = proteinGap * 7

      // Build patterns
      const patterns = []

      // Protein deficit pattern
      if (avgProtein < targetProtein * 0.8) {
        const severity = avgProtein < targetProtein * 0.7 ? 'high' : 'medium'
        patterns.push({
          type: 'protein_deficit',
          severity,
          message: `Середній дефіцит білка — ${Math.round(proteinGap)}г/день. За тиждень не добрав ${Math.round(weeklyProteinGap)}г білка. Це гальмує м'язовий ріст.`,
          fix: 'Додай 1 порцію протеїну або 150г курки до обіду кожного дня',
        })
      } else if (avgProtein >= targetProtein * 0.9) {
        patterns.push({
          type: 'protein_on_track',
          severity: 'low',
          message: `Білок на рівні — ${Math.round(avgProtein)}г/день (ціль ${Math.round(targetProtein)}г). Так тримати.`,
          fix: '',
        })
      }

      // Surplus days pattern
      if (surplusDays.length > 0) {
        const surplusDayNames = surplusDays.map(d => {
          const dayNames = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п\'ятниця', 'субота']
          return dayNames[new Date(d.date).getDay()]
        }).join(', ')
        const severity = surplusDays.length >= 3 ? 'high' : surplusDays.length === 2 ? 'medium' : 'low'
        patterns.push({
          type: 'calorie_surplus',
          severity,
          message: `${surplusDays.length} ${surplusDays.length === 1 ? 'день' : 'дні'} з профіцитом (${surplusDayNames}). ${surplusDays.length <= 2 ? 'Це нормально при дефіциті решту тижня.' : 'Занадто часто — слід контролювати.'}`,
          fix: 'Контролюй вихідні — зазвичай найбільше відхилення',
        })
      }

      // Under-eating pattern
      if (underEatingDays.length > 0) {
        patterns.push({
          type: 'under_eating',
          severity: 'medium',
          message: `${underEatingDays.length} дні з дуже малим споживанням (< ${targetCalories - 800} ккал). Занадто великий дефіцит сповільнює метаболізм.`,
          fix: 'Не опускайся нижче -800 ккал від норми. Додай перекус у ці дні.',
        })
      }

      // High carb days
      if (highCarbDays.length >= 3) {
        patterns.push({
          type: 'high_carb_evening',
          severity: 'medium',
          message: `${highCarbDays.length} днів з переважанням вуглеводів (>60% калорій). Ввечері зменши порцію вуглеводів.`,
          fix: 'Заміни вечірні вуглеводи на білок + овочі.',
        })
      }

      // Consistent deficit (good news)
      if (allInDeficit && patterns.length === 0) {
        patterns.push({
          type: 'consistent_deficit',
          severity: 'low',
          message: 'Всі 7 днів у дефіциті калорій. Прогрес в потрібному напрямку.',
          fix: '',
        })
      }

      // Build weekly strategy
      let weeklyStrategy = ''
      const totalSurplusDeficit = daysArray.reduce((s, d) => s + d.surplus_deficit, 0)
      const weeklyBalance = Math.round(totalSurplusDeficit)
      const whoopSuffix = hasWhoopData ? ' (на основі WHOOP даних)' : ''

      if (weeklyBalance < 0) {
        weeklyStrategy = `Тижневий баланс: ${weeklyBalance} ккал (добре)${whoopSuffix}.`
      } else {
        weeklyStrategy = `Тижневий баланс: +${weeklyBalance} ккал (профіцит — слід скоригувати)${whoopSuffix}.`
      }

      const mainProblem = patterns.find(p => p.severity === 'high') || patterns.find(p => p.severity === 'medium')
      if (mainProblem) {
        if (mainProblem.type === 'protein_deficit') {
          weeklyStrategy += ` Головна проблема — білок. Пріоритет наступного тижня: ${Math.round(targetProtein)}г білка щодня > все інше.`
        } else if (mainProblem.type === 'calorie_surplus') {
          weeklyStrategy += ' Контролюй вихідні — основне джерело профіциту.'
        } else if (mainProblem.type === 'under_eating') {
          weeklyStrategy += ' Уникай екстремального дефіциту — це шкодить метаболізму.'
        }
      } else {
        weeklyStrategy += ' Загалом тиждень хороший. Продовжуй в тому ж темпі.'
      }

      // Next week focus tags
      const nextWeekFocus = []
      if (patterns.some(p => p.type === 'protein_deficit')) nextWeekFocus.push('protein_boost')
      if (patterns.some(p => p.type === 'calorie_surplus')) nextWeekFocus.push('control_weekends')
      if (patterns.some(p => p.type === 'under_eating')) nextWeekFocus.push('consistent_meals')
      if (patterns.some(p => p.type === 'high_carb_evening')) nextWeekFocus.push('reduce_evening_carbs')
      if (nextWeekFocus.length === 0) nextWeekFocus.push('maintain_momentum')

      const response = {
        week_summary: {
          avg_calories: avgCalories,
          target_calories: avgTarget,
          avg_deficit: avgDeficit,
          avg_protein: avgProtein,
          target_protein: Math.round(targetProtein),
          protein_gap: Math.round(proteinGap),
          total_surplus_days: daysWithData.filter(d => d.surplus_deficit > 0).length,
          total_deficit_days: daysWithData.filter(d => d.surplus_deficit <= 0).length,
          days_with_data: daysWithData.length,
          whoop_based: hasWhoopData,
        },
        patterns,
        weekly_strategy: weeklyStrategy,
        next_week_focus: nextWeekFocus,
        days: daysArray,
      }

      res.json(response)
    } catch (err) {
      console.error('Weekly recommendations error:', err)
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
