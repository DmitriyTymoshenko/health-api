/**
 * ROUTE-LEVEL smoke test for #1295 — "one date ⇒ one value" across every
 * target-facing endpoint.
 *
 * WHY THIS FILE EXISTS: #1295 found the SAME day's calorie/TDEE/protein/water/weight
 * targets disagreeing across up to 4 surfaces (`/api/recommendations` 1444 kcal at
 * noon, `/api/nutrition/summary` basis 2201, `/api/goals/streaks` calories_limit
 * 1947, `Today.jsx` ~2070 and climbing — all on the SAME day). Every number here is
 * a literal derived BY HAND from the stubbed profile (mirrors the live figures from
 * the #1295 ticket: tdee_kcal 2701, deficit 500 -> 2201; weight 93.9kg -> protein
 * 188g; weight_goal_kg 90/2026-10-15) — this test proves the five endpoints below all
 * derive it from the SAME lib/targets-resolver.js call, not from five independent
 * (and drifting) local computations.
 *
 * RED-FIRST (verified before commit): reverting routes/recommendations.js's daily
 * handler to call `resolveDayKcalTarget(profile, caloriesBurned)` again (the
 * pre-#1295 WHOOP-burn-adjusted function, still exported for characterization —
 * see nutrition-targets.js) makes `summary.calories_target` come back 2444
 * (1944 whoop burn + (-500) delta) instead of 2201 — the CROSS-ENDPOINT assertion
 * against `/api/nutrition/summary`'s 2201 goes red immediately, exactly the class of
 * bug this file exists to catch.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetsRouter = require('../../routes/targets')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recommendationsRouter = require('../../routes/recommendations')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const goalsRouter = require('../../routes/goals')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const waterRouter = require('../../routes/water')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const profileRouter = require('../../routes/personal_profile')

type Doc = Record<string, any>

/**
 * Minimal Mongo-cursor-shaped stub shared by ALL FIVE routers under test — one
 * profile, one weight entry, one WHOOP cycle, everything else empty. Unknown
 * collection names throw (lesson #966/#1066: a stub that silently returns
 * `undefined` for a collection a route actually reads is green and blind).
 */
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
        sort(spec: Doc) {
          const [key, dir] = Object.entries(spec)[0] as [string, number]
          list = list.slice().sort((a, b) => (a[key] < b[key] ? -1 : 1) * dir)
          return cursor
        },
        limit(n: number) {
          list = list.slice(0, n)
          return cursor
        },
        skip(n: number) {
          list = list.slice(n)
          return cursor
        },
        toArray: async () => list,
      }
      return cursor
    },
  }
}

function makeGetDB(opts: { profile: Doc; weightEntries: Doc[]; whoopCycles: Doc[] }) {
  const collections: Record<string, ReturnType<typeof makeArrayCollection>> = {
    personal_profile: makeArrayCollection([opts.profile]),
    weight_log: makeArrayCollection(opts.weightEntries),
    whoop_cycles: makeArrayCollection(opts.whoopCycles),
    nutrition_log: makeArrayCollection([]),
    goals: makeArrayCollection([]),
    water_log: makeArrayCollection([]),
    steps: makeArrayCollection([]),
    supplement_intake: makeArrayCollection([]),
    supplement_catalog: makeArrayCollection([]),
  }
  return () => ({
    collection(name: string) {
      if (collections[name]) return collections[name]
      throw new Error(`unexpected collection read in #1295 unified-targets test: ${name}`)
    },
  })
}

function makeApp(getDB: () => any) {
  const app = express()
  app.use(express.json())
  app.use('/api/targets', targetsRouter(getDB))
  app.use('/api/recommendations', recommendationsRouter(getDB))
  app.use('/api/nutrition', nutritionRouter(getDB))
  app.use('/api/goals', goalsRouter(getDB))
  app.use('/api/water', waterRouter(getDB))
  app.use('/api/profile', profileRouter(getDB))
  return app
}

// Same date for every date-parameterised endpoint so all five see "today" as the
// SAME day — /api/goals/streaks has no `?date=` param (always real "today"), so the
// other four are pinned to real "today" too rather than an arbitrary fixed date.
const TODAY = new Date().toISOString().split('T')[0]

/**
 * Figures lifted straight from the #1295 ticket / Codex audit (2026-09-09):
 * tdee_kcal 2701, deficit_kcal 500 -> stableDayKcalBasis 2201; weight 93.9 kg ->
 * protein 188 g (round(93.9*2.0)); weight_goal_kg 90 / 2026-10-15 (personal_profile
 * canon, NOT the `goals` collection's 96/2026-10-31 or the old 96 JSX hardcode).
 */
const PROFILE: Doc = {
  _type: 'profile',
  tdee_kcal: 2701,
  deficit_kcal: 500,
  primary_goal: 'weight_loss',
  daily_protein_goal_g: null,
  daily_kcal_goal: null,
  weight_goal_kg: 90,
  weight_goal_date: '2026-10-15',
}
const WEIGHT_ENTRY: Doc = { date: TODAY, weight_kg: 93.9 }
// A PARTIAL WHOOP cycle (>1200 kcal, so the pre-#1295 resolveDayKcalTarget WOULD have
// used it: 1944 - 500 = 1444 at this point of the day) — the whole point of #1295 is
// that this number must NOT move the calorie target anymore.
const WHOOP_CYCLE: Doc = { date: TODAY, calories_burned: 1944, strain: 10.5 }

const EXPECTED_KCAL = 2201 // stableDayKcalBasis(2701, 500)
const EXPECTED_PROTEIN_G = 188 // round(93.9 * 2.0)
const EXPECTED_WATER_ML = 3700 // calcWaterGoal(93.9, 10.5): strain in [10,14) -> x1.2

describe('#1295 — one date ⇒ one calorie/protein/water/weight value across every target-facing endpoint', () => {
  it('calorie target: /api/targets, /api/recommendations, /api/nutrition/summary, /api/goals/streaks all agree — and it IGNORES the partial WHOOP burn', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const recommendations = await request(app).get('/api/recommendations').query({ date: TODAY })
    const summary = await request(app).get('/api/nutrition/summary').query({ date: TODAY })
    const streaks = await request(app).get('/api/goals/streaks')

    expect(targets.status).toBe(200)
    expect(recommendations.status).toBe(200)
    expect(summary.status).toBe(200)
    expect(streaks.status).toBe(200)

    expect(targets.body.kcal).toBe(EXPECTED_KCAL)
    expect(recommendations.body.summary.calories_target).toBe(EXPECTED_KCAL)
    expect(summary.body.kcal_goal).toBe(EXPECTED_KCAL)
    expect(streaks.body.goals.calories_limit).toBe(EXPECTED_KCAL)

    // deficit_kcal: Nutrition.jsx's "Дефіцит по плану" row (#1295) reads this field
    // instead of GET /api/settings/plan?date= (a DIFFERENT, historical-snapshot
    // quantity per lib/nutrition-targets.js's own doc comment).
    expect(targets.body.deficit_kcal).toBe(500)
    expect(summary.body.deficit_kcal).toBe(500)

    // The regression this file exists to catch: a live partial WHOOP burn (1944 kcal,
    // above the 1200 "real cycle" threshold) must NOT have moved the target off 2201.
    expect(recommendations.body.summary.whoop_calories_burned).toBe(1944) // informational, unchanged
    expect(recommendations.body.summary.calories_target).not.toBe(1444) // 1944 - 500, the pre-#1295 bug
  })

  it('protein target: /api/targets, /api/recommendations, /api/nutrition/summary, /api/goals/streaks all agree', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const recommendations = await request(app).get('/api/recommendations').query({ date: TODAY })
    const summary = await request(app).get('/api/nutrition/summary').query({ date: TODAY })
    const streaks = await request(app).get('/api/goals/streaks')

    expect(targets.body.protein_g).toBe(EXPECTED_PROTEIN_G)
    expect(recommendations.body.summary.protein_target).toBe(EXPECTED_PROTEIN_G)
    expect(summary.body.protein_goal_g).toBe(EXPECTED_PROTEIN_G)
    expect(streaks.body.goals.protein_min).toBe(EXPECTED_PROTEIN_G)
  })

  it('water target: /api/targets and /api/water/today agree for the SAME date+strain', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const water = await request(app).get('/api/water/today').query({ date: TODAY })

    expect(targets.body.water_ml).toBe(EXPECTED_WATER_ML)
    expect(water.body.goal_ml).toBe(EXPECTED_WATER_ML)
  })

  it('weight goal: /api/targets and /api/profile/metrics both read personal_profile (90kg/2026-10-15), never the old 96 default', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const metrics = await request(app).get('/api/profile/metrics')

    expect(targets.body.weight_goal_kg).toBe(90)
    expect(targets.body.weight_goal_date).toBe('2026-10-15')
    // #1295 ticket figure: 93.9 - 90 = 3.9 kg to go.
    expect(metrics.body.weight_kg).toBe(93.9)
    expect(metrics.body.kg_to_goal).toBe(3.9)
    // tdee_kcal must be the STORED canonical value (2701), not the on-the-fly
    // BMR x activity recompute (which read 3017 live — one of the "3 TDEE values").
    expect(metrics.body.tdee_kcal).toBe(2701)
  })

  it('TDEE: /api/targets and /api/profile/metrics agree on the canonical stored value', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const metrics = await request(app).get('/api/profile/metrics')

    expect(targets.body.tdee_kcal).toBe(2701)
    expect(metrics.body.tdee_kcal).toBe(2701)
  })
})

export {}
