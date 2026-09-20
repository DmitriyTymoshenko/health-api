/**
 * #873 Частина 4 — regression tests for the 4 named flat-sum call sites that
 * missed legacy nested `items[]` nutrition_log records (the #862 class,
 * lib/nutrition-aggregate.js's `macroContribution`/`aggregateDay` already fix
 * this for /nutrition/summary — these 4 OTHER sites re-derived the sum locally
 * instead of reusing that helper by name, per Apex triage #8423 on task #873):
 *   - routes/goals.js:136-137        (GET /api/goals/streaks — nutritionByDay)
 *   - notify.js:31                   (checkAndNotify — daily calorie alert)
 *   - routes/nutrition.js:81-82      (sendMealTelegramNotification)
 *   - routes/recommendations.js:264-265 (GET /api/recommendations — consumed)
 *   - routes/recommendations.js:594-595 (GET /api/recommendations/weekly — dayMap)
 *
 * Reuses the EXACT #862 fixture (nutrition_aggregate.test.ts): 7 real records for
 * 2026-07-27 summing to 2200 kcal, 4 of them legacy nested items[] with NO
 * top-level kcal field. The pre-fix flat-only sum silently drops those 4 and
 * undercounts to 621 kcal (374+151+96, the 3 flat-only records) — every
 * assertion below proves the fixed call site sees ~2200, never 621.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')

// Real production shapes, captured live from nutrition_log for 2026-07-27 (task #862)
// — copied verbatim from nutrition_aggregate.test.ts so both files stay in sync with
// the same live fixture (never re-derive a second copy of "the" #862 day).
const LEGACY_BREAKFAST = {
  date: '2026-07-27',
  meal_type: 'breakfast',
  sat_fat_g: 0,
  items: [
    { name: 'Go On Nutrition Protein Granola', grams: 100, kcal: 408, protein: 21, fat: 13, carbs: 46 },
    { name: 'Кокосове молоко (Alpro)', grams: 300, kcal: 60, protein: 0.3, fat: 2.4, carbs: 8.1 },
    { name: 'Банан', grams: 118, kcal: 105, protein: 1.3, fat: 0.4, carbs: 27 },
  ],
}
const LEGACY_LUNCH = {
  date: '2026-07-27',
  meal_type: 'lunch',
  items: [{ name: "McDonald's", grams: 220, kcal: 596, protein: 24, fat: 34, carbs: 50 }],
}
const LEGACY_SNACK = {
  date: '2026-07-27',
  meal_type: 'snack',
  items: [{ name: 'Valio Pro Feel', grams: 175, kcal: 119, protein: 14.9, fat: 0.35, carbs: 13.1 }],
}
const LEGACY_DINNER = {
  date: '2026-07-27',
  meal_type: 'dinner',
  items: [{ name: 'Салат креветка+кальмар+авокадо', grams: 200, kcal: 291, protein: 21.7, fat: 19.9, carbs: 7 }],
}
const FLAT_SNACK_1 = {
  date: '2026-07-27',
  meal_type: 'snack',
  food_name: 'Сніжок',
  kcal: 374,
  protein_g: 34.6,
  carbs_g: 17.1,
  fat_g: 17.6,
  sugar_g: 2,
  sat_fat_g: 9.68,
  fiber_g: 0.3,
}
const FLAT_SNACK_2 = {
  date: '2026-07-27',
  meal_type: 'snack',
  food_name: 'Лосось слабосолений',
  kcal: 151,
  protein_g: 15.8,
  carbs_g: 0,
  fat_g: 9.8,
  sugar_g: 0,
  sat_fat_g: 2.16,
  fiber_g: 0,
}
const FLAT_SNACK_3 = {
  date: '2026-07-27',
  meal_type: 'snack',
  food_name: "М'ясні курячі чіпси",
  kcal: 96,
  protein_g: 24,
  carbs_g: 0.5,
  fat_g: 0.5,
  sugar_g: 0,
  sat_fat_g: 0.12,
  fiber_g: 0,
}
const FIXTURE_DAY = '2026-07-27'
const FIXTURE_DOCS = [LEGACY_BREAKFAST, LEGACY_LUNCH, LEGACY_SNACK, LEGACY_DINNER, FLAT_SNACK_1, FLAT_SNACK_2, FLAT_SNACK_3]
const REAL_TOTAL_KCAL = 2200
const OLD_BUGGY_KCAL = 621 // 374 + 151 + 96 — only the 3 flat records, 4 legacy nested dropped

type Doc = Record<string, any>

// Minimal Mongo-cursor-shaped stub — unknown collection throws (lesson #966/#1066:
// a stub that silently returns undefined for a collection a route actually reads
// is green and blind).
function makeArrayCollection(initialArr: Doc[]) {
  return {
    async findOne(filter: Doc = {}, opts: Doc = {}) {
      let list = initialArr.slice()
      if (filter._type) list = list.filter((x) => x._type === filter._type)
      if (filter.date && typeof filter.date === 'string') list = list.filter((x) => x.date === filter.date)
      if (opts.sort) {
        const [key, dir] = Object.entries(opts.sort)[0] as [string, number]
        list.sort((a, b) => (a[key] < b[key] ? 1 : -1) * (dir === -1 ? 1 : -1))
      }
      return list[0] ?? null
    },
    find(filter: Doc = {}) {
      let list = initialArr.slice()
      if (filter.date) {
        if (typeof filter.date === 'string') {
          list = list.filter((x) => x.date === filter.date)
        } else {
          const { $gte, $lte, $in } = filter.date
          list = list.filter(
            (x) => (!$gte || x.date >= $gte) && (!$lte || x.date <= $lte) && (!$in || $in.includes(x.date))
          )
        }
      }
      const cursor: any = {
        toArray: async () => list,
      }
      return cursor
    },
  }
}

describe('routes/goals.js GET /api/goals/streaks — nutritionByDay must not undercount to 621 (#873 Частина 4)', () => {
  it('a day whose real total is 2200 kcal is correctly judged AGAINST a 1500 kcal limit (would wrongly pass at 621)', async () => {
    const goalsRouter = require('../../routes/goals')
    const collections: Record<string, any> = {
      goals: makeArrayCollection([]),
      personal_profile: makeArrayCollection([{ _type: 'profile', daily_kcal_goal: 1500, daily_protein_goal_g: 1 }]),
      weight_log: makeArrayCollection([]),
      whoop_cycles: makeArrayCollection([]),
      nutrition_log: makeArrayCollection(FIXTURE_DOCS),
    }
    const getDB = () => ({
      collection(name: string) {
        if (collections[name]) return collections[name]
        throw new Error(`unexpected collection: ${name}`)
      },
    })
    const app = express()
    app.use('/api/goals', goalsRouter(getDB))

    const res = await request(app).get('/api/goals/streaks').query({ date: FIXTURE_DAY })
    expect(res.status).toBe(200)
    // calories_limit resolves to 1500 (explicit override). Real total 2200 > 1500 ⇒
    // the day must NOT count as an on-target calorie day. The pre-fix flat sum (621)
    // would have wrongly satisfied `kcal > 0 && kcal <= 1500` and counted it as met.
    expect(res.body.goals.calories_limit).toBe(1500)
    expect(res.body.streaks.calories.best).toBe(0)
    expect(res.body.streaks.calories.current).toBe(0)
  })
})

describe('notify.js checkAndNotify — total must not undercount to 621 (#873 Частина 4)', () => {
  let checkAndNotify: (db: any, date: string, name: string, kcal: number) => Promise<void>
  let httpsMock: any

  beforeEach(() => {
    jest.resetModules()
    jest.mock('https')
    process.env.TELEGRAM_BOT_LISA = 'test-token-873'
    process.env.OWNER_TELEGRAM_ID = '12345'
    httpsMock = require('https')
    httpsMock.request = jest.fn((_options: any, cb: any) => {
      cb({ on: (ev: string, fn: () => void) => { if (ev === 'end') fn() } })
      return { on: jest.fn(), write: jest.fn(), end: jest.fn() }
    })
    ;({ checkAndNotify } = require('../../notify'))
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_LISA
    delete process.env.OWNER_TELEGRAM_ID
    jest.dontMock('https')
  })

  it('a real 2200 kcal day (100% of the 2200 default limit) fires the WARN alert — the pre-fix 621 (28%) never would have', async () => {
    const db = {
      collection(name: string) {
        if (name === 'nutrition_log') return { find: () => ({ toArray: async () => FIXTURE_DOCS }) }
        if (name === 'whoop_cycles') return { findOne: async () => null } // no WHOOP -> dynamicLimit = DEFAULT_CALORIE_LIMIT (2200)
        throw new Error(`unexpected collection: ${name}`)
      },
    }
    await checkAndNotify(db, FIXTURE_DAY, 'test item', 100)
    // REAL_TOTAL_KCAL(2200) / dynamicLimit(2200) = 100% >= WARN_THRESHOLD(80%) -> alert fires.
    // OLD_BUGGY_KCAL(621) / 2200 = 28% -> would NOT have fired.
    expect(httpsMock.request).toHaveBeenCalledTimes(1)
    expect(REAL_TOTAL_KCAL / 2200).toBeGreaterThanOrEqual(0.8)
    expect(OLD_BUGGY_KCAL / 2200).toBeLessThan(0.8)
  })
})

describe('routes/recommendations.js GET /api/recommendations — consumed.calories must not undercount to 621 (#873 Частина 4)', () => {
  it('calories_consumed reflects the real 2200 kcal day, never the pre-fix 621', async () => {
    const recommendationsRouter = require('../../routes/recommendations')
    const collections: Record<string, any> = {
      personal_profile: makeArrayCollection([
        { _type: 'profile', tdee_kcal: 2701, deficit_kcal: 500, daily_kcal_goal: null, daily_protein_goal_g: null },
      ]),
      weight_log: makeArrayCollection([{ date: FIXTURE_DAY, weight_kg: 93.9 }]),
      whoop_cycles: makeArrayCollection([]),
      nutrition_log: makeArrayCollection(FIXTURE_DOCS),
    }
    const getDB = () => ({
      collection(name: string) {
        if (collections[name]) return collections[name]
        throw new Error(`unexpected collection: ${name}`)
      },
    })
    const app = express()
    app.use('/api/recommendations', recommendationsRouter(getDB))

    const res = await request(app).get('/api/recommendations').query({ date: FIXTURE_DAY })
    expect(res.status).toBe(200)
    expect(res.body.summary.calories_consumed).toBe(REAL_TOTAL_KCAL)
    expect(res.body.summary.calories_consumed).not.toBe(OLD_BUGGY_KCAL)
  })
})

describe('routes/recommendations.js GET /api/recommendations/weekly — dayMap must not undercount to 621 (#873 Частина 4)', () => {
  it('the fixture day inside the 7-day window shows 2200 kcal, never the pre-fix 621', async () => {
    const recommendationsRouter = require('../../routes/recommendations')
    // Window is `today-7..today-1` (#1411 R3) — pin "today" so FIXTURE_DAY (2026-07-27)
    // falls inside the trailing window deterministically.
    jest.useFakeTimers({ advanceTimers: false })
    jest.setSystemTime(new Date('2026-07-28T09:00:00.000Z'))

    const collections: Record<string, any> = {
      personal_profile: makeArrayCollection([
        { _type: 'profile', tdee_kcal: 2701, deficit_kcal: 500, daily_kcal_goal: null, daily_protein_goal_g: null },
      ]),
      weight_log: makeArrayCollection([]),
      whoop_cycles: makeArrayCollection([]),
      nutrition_log: makeArrayCollection(FIXTURE_DOCS),
    }
    const getDB = () => ({
      collection(name: string) {
        if (collections[name]) return collections[name]
        throw new Error(`unexpected collection: ${name}`)
      },
    })
    const app = express()
    app.use('/api/recommendations', recommendationsRouter(getDB))

    const res = await request(app).get('/api/recommendations/weekly')
    jest.useRealTimers()

    expect(res.status).toBe(200)
    const fixtureDayRow = res.body.days.find((d: Doc) => d.date === FIXTURE_DAY)
    expect(fixtureDayRow).toBeDefined()
    expect(fixtureDayRow.calories).toBe(REAL_TOTAL_KCAL)
    expect(fixtureDayRow.calories).not.toBe(OLD_BUGGY_KCAL)
  })
})

export {}
