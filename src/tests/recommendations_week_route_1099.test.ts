/**
 * ROUTE-LEVEL test for GET /api/recommendations/week (#1099).
 *
 * Exercises the REAL router factory (like unified_targets_1295.test.ts and
 * nutrition_summary_route.test.ts) so nothing here re-implements the route's own
 * math — every asserted number is either a literal derived by hand from the
 * stubbed profile/analogs, or a cross-check against a SIBLING endpoint's own
 * response for the SAME date (the #1099 acceptance criterion: one date -> one
 * number across /api/recommendations, /api/nutrition/summary, /api/targets and
 * /week — see also unified_targets_1295.test.ts for the pre-existing 3-endpoint
 * version this file extends to a 4th).
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const recommendationsRouter = require('../../routes/recommendations')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetsRouter = require('../../routes/targets')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')

type Doc = Record<string, any>

function makeCursor(list: Doc[]) {
  const cursor: any = {
    sort(spec: Doc) {
      const [key, dir] = Object.entries(spec)[0] as [string, number]
      list = list.slice().sort((a, b) => (a[key] < b[key] ? -1 : 1) * dir)
      return cursor
    },
    toArray: async () => list,
  }
  return cursor
}

function filterByDate(list: Doc[], filter: Doc) {
  if (!filter || !filter.date) return list.slice()
  if (typeof filter.date === 'string') return list.filter((x) => x.date === filter.date)
  const { $gte, $lt, $lte, $in } = filter.date
  return list.filter(
    (x) =>
      (!$gte || x.date >= $gte) &&
      (!$lt || x.date < $lt) &&
      (!$lte || x.date <= $lte) &&
      (!$in || $in.includes(x.date))
  )
}

function makeGetDB(opts: { profile: Doc | null; weightEntries: Doc[]; whoopCycles: Doc[]; nutritionLog: Doc[] }) {
  const collections: Record<string, any> = {
    personal_profile: {
      findOne: async (filter: Doc = {}) => {
        if (filter._type && opts.profile?._type !== filter._type) return null
        return opts.profile
      },
    },
    weight_log: {
      findOne: async (_filter: Doc = {}, sortOpts: Doc = {}) => {
        let list = opts.weightEntries.slice()
        if (sortOpts.sort) {
          const [key, dir] = Object.entries(sortOpts.sort)[0] as [string, number]
          list.sort((a, b) => (a[key] < b[key] ? 1 : -1) * (dir === -1 ? 1 : -1))
        }
        return list[0] ?? null
      },
    },
    whoop_cycles: {
      findOne: async (filter: Doc = {}) => filterByDate(opts.whoopCycles, filter)[0] ?? null,
      find: (filter: Doc = {}) => makeCursor(filterByDate(opts.whoopCycles, filter)),
    },
    nutrition_log: {
      find: (filter: Doc = {}) => makeCursor(filterByDate(opts.nutritionLog, filter)),
    },
  }
  return () => ({
    collection(name: string) {
      if (collections[name]) return collections[name]
      throw new Error(`unexpected collection read in #1099 /week test: ${name}`)
    },
  })
}

function makeApp(getDB: () => any) {
  const app = express()
  app.use(express.json())
  app.use('/api/recommendations', recommendationsRouter(getDB))
  app.use('/api/targets', targetsRouter(getDB))
  app.use('/api/nutrition', nutritionRouter(getDB))
  return app
}

/** Build closed same-weekday analog cycles, one every 7 days back from `fromDate`. */
function sameWeekdayCycles(fromDate: string, count: number, caloriesBurned: number): Doc[] {
  const out: Doc[] = []
  for (let i = 1; i <= count; i++) {
    const [y, m, d] = fromDate.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
    date.setUTCDate(date.getUTCDate() - 7 * i)
    out.push({ date: date.toISOString().slice(0, 10), calories_burned: caloriesBurned, end: new Date() })
  }
  return out
}

const WEDNESDAY = '2026-09-23' // day 0 for the "box day" test — a real Wednesday
const PROFILE: Doc = {
  _type: 'profile',
  tdee_kcal: 2701,
  deficit_kcal: 500,
  primary_goal: 'weight_loss',
  daily_kcal_goal: null,
  daily_protein_goal_g: null,
  weight_goal_kg: 90,
  weight_goal_date: '2026-10-15',
}
const WEIGHT_ENTRY: Doc = { date: '2026-09-01', weight_kg: 93.9 }
const DERIVED_BASIS = 2201 // stableDayKcalBasis(2701, 500) — the #1295 fixture value

describe('GET /api/recommendations/week (#1099)', () => {
  it('returns exactly 7 days starting from ?date=, today first, future days last', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [], nutritionLog: [] }))
    const res = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    expect(res.status).toBe(200)
    expect(res.body.days).toHaveLength(7)
    expect(res.body.days[0].date).toBe('2026-09-23')
    expect(res.body.days[0].is_today).toBe(true)
    expect(res.body.days[6].date).toBe('2026-09-29')
    expect(res.body.days.slice(1).every((d: Doc) => d.is_today === false)).toBe(true)
  })

  it('every future day has whoop_based:false and no whoop_calories_burned — never a live-partial leak', async () => {
    const whoopCycles = [{ date: WEDNESDAY, calories_burned: 1123, end: null }] // today, partial
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles, nutritionLog: [] }))
    const res = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    const futureDays = res.body.days.slice(1)
    expect(futureDays.every((d: Doc) => d.whoop_based === false)).toBe(true)
    expect(futureDays.every((d: Doc) => d.whoop_calories_burned === null)).toBe(true)
  })

  it('a high-burn recurring weekday (analogs >= 5) gets a bumped calories_target above the plain derived basis', async () => {
    // Wednesday (day 0) and the next Wednesday (day 7, out of this week's window) both
    // have >=5 same-weekday closed analogs at 2800 kcal -> day-type basis 2300 > 2201.
    const whoopCycles = sameWeekdayCycles(WEDNESDAY, 6, 2800)
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles, nutritionLog: [] }))
    const res = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    expect(res.body.days[0].calories_target).toBe(2300)
    expect(res.body.days[0].calories_target).toBeGreaterThan(DERIVED_BASIS)
  })

  it('a weekday with no analogs at all stays at the plain derived basis (no bump)', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [], nutritionLog: [] }))
    const res = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    expect(res.body.days[0].calories_target).toBe(DERIVED_BASIS)
  })

  it('each day carries a meal_plan built from the SAME generator as GET / (full 4-meal plan, no consumed data possible for future days)', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [], nutritionLog: [] }))
    const res = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    for (const day of res.body.days) {
      expect(Array.isArray(day.meal_plan)).toBe(true)
      expect(day.meal_plan.length).toBe(4) // nothing logged anywhere -> breakfast/lunch/snack/dinner all planned
      expect(day.meal_plan.map((m: Doc) => m.meal_type)).toEqual(['breakfast', 'lunch', 'snack', 'dinner'])
    }
  })

  it("today's entry accounts for already-logged food (fewer planned meals, reduced remaining budget) — future days do not", async () => {
    const nutritionLog = [{ date: WEDNESDAY, meal_type: 'breakfast', kcal: 400, protein_g: 30, carbs_g: 20, fat_g: 10 }]
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [], nutritionLog }))
    const res = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    const today = res.body.days[0]
    expect(today.calories_consumed).toBe(400)
    expect(today.meal_plan.length).toBe(3) // breakfast already logged -> not re-planned
    expect(today.meal_plan.map((m: Doc) => m.meal_type)).not.toContain('breakfast')

    const tomorrow = res.body.days[1]
    expect(tomorrow.calories_consumed).toBe(0)
    expect(tomorrow.meal_plan.length).toBe(4)
  })

  it("ONE date -> ONE calories_target across /api/recommendations, /api/nutrition/summary, /api/targets and /week (#1099 extends #1295's cross-endpoint contract)", async () => {
    const whoopCycles = sameWeekdayCycles(WEDNESDAY, 6, 2800)
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles, nutritionLog: [] }))

    const targets = await request(app).get('/api/targets').query({ date: WEDNESDAY })
    const recommendations = await request(app).get('/api/recommendations').query({ date: WEDNESDAY })
    const summary = await request(app).get('/api/nutrition/summary').query({ date: WEDNESDAY })
    const week = await request(app).get('/api/recommendations/week').query({ date: WEDNESDAY })

    const expected = 2300 // the same day-type-bumped basis as the previous test
    expect(targets.body.kcal).toBe(expected)
    expect(recommendations.body.summary.calories_target).toBe(expected)
    expect(summary.body.kcal_goal).toBe(expected)
    expect(week.body.days[0].calories_target).toBe(expected)
  })
})

export {}
