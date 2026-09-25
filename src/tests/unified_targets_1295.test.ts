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

function makeGetDB(opts: {
  profile: Doc
  weightEntries: Doc[]
  whoopCycles: Doc[]
  // #1295 round 2 additions — default empty, only the water-override test uses this.
  goalsDocs?: Doc[]
  waterLog?: Doc[]
  // #1298 R4 addition — default empty; the "overall streak reachable" test below
  // seeds a real nutrition day so calories/protein can actually be met.
  nutritionLog?: Doc[]
}) {
  const collections: Record<string, ReturnType<typeof makeArrayCollection>> = {
    personal_profile: makeArrayCollection([opts.profile]),
    weight_log: makeArrayCollection(opts.weightEntries),
    whoop_cycles: makeArrayCollection(opts.whoopCycles),
    nutrition_log: makeArrayCollection(opts.nutritionLog ?? []),
    goals: makeArrayCollection(opts.goalsDocs ?? []),
    water_log: makeArrayCollection(opts.waterLog ?? []),
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
// SAME day. #1295 round 2 added `?date=` support to /api/goals/streaks too (it
// used to always read real "today" via a bare `new Date()`) — every call below
// now passes it explicitly like the other four routes already did.
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
// A PARTIAL WHOOP cycle, deliberately BELOW #1504's MIN_TRUSTED_PARTIAL_BURN_KCAL
// (1200, lib/whoop-forecast-kcal.js) — this file's whole point (still valid post-#1504)
// is that a partial burn with NO real signal yet must not move the calorie target.
// #1504 reuses the SAME 1200 threshold the pre-#1295 resolveDayKcalTarget() used
// ("only trust it once it passes basal-metabolism scale") to decide whether a live
// cycle is forecast-worthy at all — a value at or below it always falls back to
// 'day_type_avg', by design, regardless of #1504. The >1200/whoop_forecast case has
// its own dedicated coverage in whoop_forecast_kcal_1504.test.ts.
const WHOOP_CYCLE: Doc = { date: TODAY, calories_burned: 1100, strain: 10.5 }

const EXPECTED_KCAL = 2201 // stableDayKcalBasis(2701, 500)
const EXPECTED_PROTEIN_G = 188 // round(93.9 * 2.0)
// #1298 R4 (owner decision 18.09): calcWaterGoal is now a flat "1 L per 30 kg
// body weight" with no strain multiplier — 93.9 * 1000 / 30 = 3130 exactly.
const EXPECTED_WATER_ML = 3130 // calcWaterGoal(93.9): flat 1L/30kg

describe('#1295 — one date ⇒ one calorie/protein/water/weight value across every target-facing endpoint', () => {
  it('calorie target: /api/targets, /api/recommendations, /api/nutrition/summary, /api/goals/streaks all agree — and it IGNORES the partial WHOOP burn', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const recommendations = await request(app).get('/api/recommendations').query({ date: TODAY })
    const summary = await request(app).get('/api/nutrition/summary').query({ date: TODAY })
    const streaks = await request(app).get('/api/goals/streaks').query({ date: TODAY })

    expect(targets.status).toBe(200)
    expect(recommendations.status).toBe(200)
    expect(summary.status).toBe(200)
    expect(streaks.status).toBe(200)

    expect(targets.body.kcal).toBe(EXPECTED_KCAL)
    expect(recommendations.body.summary.calories_target).toBe(EXPECTED_KCAL)
    expect(summary.body.kcal_goal).toBe(EXPECTED_KCAL)
    expect(streaks.body.goals.calories_limit).toBe(EXPECTED_KCAL)

    // #1504 — all four surfaces must also agree on WHICH basis produced that number.
    expect(targets.body.basis).toBe('day_type_avg')
    expect(recommendations.body.summary.basis).toBe('day_type_avg')
    expect(summary.body.kcal_basis).toBe('day_type_avg')
    expect(streaks.body.goals.basis).toBe('day_type_avg')

    // deficit_kcal: Nutrition.jsx's "Дефіцит по плану" row (#1295) reads this field
    // instead of GET /api/settings/plan?date= (a DIFFERENT, historical-snapshot
    // quantity per lib/nutrition-targets.js's own doc comment).
    expect(targets.body.deficit_kcal).toBe(500)
    expect(summary.body.deficit_kcal).toBe(500)

    // The regression this file exists to catch: a live partial WHOOP burn (1100 kcal,
    // at/below the 1200 "real cycle" threshold) must NOT have moved the target off
    // 2201. The >1200/whoop_forecast case is #1504's INTENDED reversal of this
    // invariant — covered separately in whoop_forecast_kcal_1504.test.ts, not here.
    expect(recommendations.body.summary.whoop_calories_burned).toBe(1100) // informational, unchanged
    expect(recommendations.body.summary.calories_target).not.toBe(600) // 1100 - 500, the pre-#1295 bug shape
  })

  it('protein target: /api/targets, /api/recommendations, /api/nutrition/summary, /api/goals/streaks all agree', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const targets = await request(app).get('/api/targets').query({ date: TODAY })
    const recommendations = await request(app).get('/api/recommendations').query({ date: TODAY })
    const summary = await request(app).get('/api/nutrition/summary').query({ date: TODAY })
    const streaks = await request(app).get('/api/goals/streaks').query({ date: TODAY })

    expect(targets.body.protein_g).toBe(EXPECTED_PROTEIN_G)
    expect(recommendations.body.summary.protein_target).toBe(EXPECTED_PROTEIN_G)
    expect(summary.body.protein_goal_g).toBe(EXPECTED_PROTEIN_G)
    expect(streaks.body.goals.protein_min).toBe(EXPECTED_PROTEIN_G)
  })

  it('water target: /api/targets and /api/water/today agree for the SAME date (flat 1L/30kg, #1298 R4)', async () => {
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

  // #1298 R4 (owner decision 18.09 ~12:00): water/steps/supplements dropped from
  // `/api/goals/streaks` entirely — water tracking removed from Today, steps
  // source dead since 06.04, supplements no longer per-day tracked. This
  // REPLACES the #1295-round-2 water-override/water-streak tests above (both
  // exercised a per-day water goal resolution inside this route that no longer
  // exists) with the new, smaller contract.
  it('streaks/goals shape: only weight/calories/protein — no water/steps/supplements keys (#1298 R4)', async () => {
    const app = makeApp(makeGetDB({ profile: PROFILE, weightEntries: [WEIGHT_ENTRY], whoopCycles: [WHOOP_CYCLE] }))

    const streaks = await request(app).get('/api/goals/streaks').query({ date: TODAY })

    expect(streaks.status).toBe(200)
    expect(Object.keys(streaks.body.streaks).sort()).toEqual(['calories', 'protein', 'weight'])
    expect(streaks.body.goals.water_min_ml).toBeUndefined()
    expect(streaks.body.goals.steps_min).toBeUndefined()
    expect(streaks.body.goals.supplements_count).toBeUndefined()
    // RED-FIRST (verified before commit): reverting routes/goals.js to the
    // pre-#1298 version puts `water`/`steps`/`supplements` back into `streaks`
    // and `water_min_ml`/`steps_min`/`supplements_count` back into `goals` —
    // this exact assertion set goes red against that version.
  })

  // #1295's original point survives #1298 R4 unchanged: calories_limit/protein_min
  // still resolve from the SAME resolver every other target-facing route uses,
  // never from a stale `goals` collection override (protein_min keeps its
  // explicit-override capability by design — see routes/goals.js comment).
  it('overall streak: reachable on a day that meets weight+calories+protein — no longer gated on the dead water/steps collections (#1298 R4)', async () => {
    const kyivToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
    const app = makeApp(
      makeGetDB({
        profile: PROFILE,
        weightEntries: [{ date: kyivToday, weight_kg: 93.9 }],
        whoopCycles: [WHOOP_CYCLE],
        nutritionLog: [{ date: kyivToday, kcal: 1500, protein_g: 190 }],
      })
    )

    const streaks = await request(app).get('/api/goals/streaks').query({ date: kyivToday })

    expect(streaks.status).toBe(200)
    // kcal 1500 <= calories_limit (2201) AND protein 190 >= protein_min (188) AND
    // weight logged today -> all three live habits met -> overall.current >= 1.
    // RED-FIRST (verified before commit against the pre-#1298 file): `overall`
    // ALSO required `waterByDay[d] >= waterGoalByDay[d]` and
    // `stepsMap[d] >= goals.steps_min` — both permanently unsatisfiable with
    // empty `water_log`/`steps` collections, so `overall.current` was stuck at 0
    // even on a day that met every LIVE habit.
    expect(streaks.body.overall.current).toBeGreaterThanOrEqual(1)
  })
})

export {}
