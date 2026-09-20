/**
 * Regression test for #926: GET /api/nutrition/meal-suggest crashed with HTTP 500
 * ("Cannot read properties of undefined (reading 'toLowerCase')") whenever the Mongo
 * `foods_library` collection contained at least one document without a `name` field.
 *
 * Root cause (routes/nutrition.js): `libraryNormalized.map(f => f.name.toLowerCase())` assumes
 * every library doc has a `name`. Verified pre-existing (not a #872 regression): `git log -S
 * "existingNames = new Set(libraryNormalized.map"` -> introduced in 3a00fe6 (the repo's initial
 * commit); `git show 37ca7c6 -- routes/nutrition.js | grep -c toLowerCase` -> 0.
 *
 * Live Mongo check (2026-08-07): 1 of 172 `foods_library` docs has no `name` (created
 * 2026-07-25, use_count: 0 — a one-off partial write, not a systemic writer bug — so this is a
 * defensive fix, not a data-migration task).
 *
 * Mounts the REAL `routes/nutrition` router factory with a fake `getDB()` (no live Mongo
 * needed), so this test is deterministic and isolated from the actual bad document.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')

// #873 Частина 2(в): meal-suggest now ALSO reads `nutrition_log` (history-first
// candidates) — every test below defaults it to [] (no history) so the pre-#873
// library/COMMON_FOODS behaviour stays exercised unchanged; history-specific
// behaviour gets its own describe block further down.
function buildApp(libraryDocs: Record<string, unknown>[], nutritionLogDocs: Record<string, unknown>[] = []) {
  const app = express()
  app.use(express.json())
  const fakeDb = {
    collection(name: string) {
      if (name === 'foods_library') {
        return {
          find: () => ({
            toArray: async () => libraryDocs,
          }),
        }
      }
      if (name === 'nutrition_log') {
        return {
          find: () => ({
            toArray: async () => nutritionLogDocs,
          }),
        }
      }
      throw new Error(`unexpected collection requested in test: ${name}`)
    },
  }
  app.use('/api/nutrition', nutritionRouter(() => fakeDb))
  return app
}

const GOOD_DOC = {
  name: 'Гречка варена',
  kcal_per_100g: 92,
  protein_per_100g: 3.4,
  fat_per_100g: 0.6,
  carbs_per_100g: 20,
  sugar_per_100g: 0.9,
  fiber_per_100g: 2,
}

// Shape of the real broken document found in prod (no `name`, no macros — a partial write).
const DOC_WITHOUT_NAME = {
  fiber_per_100g: 0,
  sugar_per_100g: 0,
  salt_per_100g: 0,
  created_at: '2026-07-25T14:40:15.741Z',
  use_count: 0,
}

describe('GET /api/nutrition/meal-suggest (#926)', () => {
  it('returns 200 with suggestions when foods_library is entirely well-formed', async () => {
    const app = buildApp([GOOD_DOC])
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=lunch&kcal=600&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
  })

  it('does NOT crash when one foods_library doc has no `name` field (the #926 bug)', async () => {
    const app = buildApp([GOOD_DOC, DOC_WITHOUT_NAME])
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=lunch&kcal=600&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    // The broken doc must be silently dropped, not surfaced as a suggestion with no name.
    expect(res.body.every((s: { food_name: string }) => !!s.food_name)).toBe(true)
  })

  it('exact reproduction from the task: only the broken doc in the library still returns 200', async () => {
    const app = buildApp([DOC_WITHOUT_NAME])
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=lunch&kcal=600&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    // Falls back to COMMON_FOODS since the only library doc is unusable.
    expect(res.body.length).toBeGreaterThan(0)
  })

  it('response items carry sugar_g and fiber_g (backend half of #872 bug 2, unverifiable while this crashed)', async () => {
    const app = buildApp([GOOD_DOC])
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=lunch&kcal=600&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    // Every returned suggestion (library-sourced or COMMON_FOODS fallback) must carry numeric
    // sugar_g/fiber_g — this is the backend half of #872 bug 2, which Max could not verify live
    // because this exact endpoint 500'd on every request.
    for (const item of res.body) {
      expect(typeof item.sugar_g).toBe('number')
      expect(typeof item.fiber_g).toBe('number')
    }
  })
})

/**
 * #873 Частина 2(в): meal-suggest now derives candidates from Дмитро's OWN
 * nutrition_log history FIRST (real per-100g macros incl. fiber + a realistic
 * portion clamp from his own average logged amount), library second, COMMON_FOODS
 * only as a last-resort fallback when real candidates are thin (<3).
 */
describe('GET /api/nutrition/meal-suggest — history-first candidates (#873 Частина 2в)', () => {
  // Real shape: 'Valio Pro Feel' logged 3x at ~175g averaging 119 kcal (matches
  // the live #873 ticket fixture — nutrition_aggregate.test.ts LEGACY_SNACK).
  const HISTORY_SNACK = [
    { date: '2026-09-01', meal_type: 'snack', food_name: 'Valio Pro Feel', amount_g: 175, kcal: 119, protein_g: 14.9, fat_g: 0.35, carbs_g: 13.1, sugar_g: 2, fiber_g: 0.5 },
    { date: '2026-09-05', meal_type: 'snack', food_name: 'Valio Pro Feel', amount_g: 175, kcal: 119, protein_g: 14.9, fat_g: 0.35, carbs_g: 13.1, sugar_g: 2, fiber_g: 0.5 },
    { date: '2026-09-10', meal_type: 'snack', food_name: 'Valio Pro Feel', amount_g: 175, kcal: 119, protein_g: 14.9, fat_g: 0.35, carbs_g: 13.1, sugar_g: 2, fiber_g: 0.5 },
  ]

  it('a food with real history is suggested at a REALISTIC portion, never a blind 500g kcal-division', async () => {
    // targetKcal=2000 would blindly divide to (2000/68*100)≈2941g for a 68kcal/100g
    // food under the OLD [30,500] band it would have clamped to 500g anyway — but
    // Valio Pro Feel's real kcal_per_100g is ~68 (119/175*100), and its real average
    // amount is 175g, so the NEW clamp must cap near 175*1.6≈280g, never near 500g.
    const app = buildApp([], HISTORY_SNACK)
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=snack&kcal=2000&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    const suggestion = res.body.find((s: { food_name: string }) => s.food_name === 'Valio Pro Feel')
    expect(suggestion).toBeDefined()
    expect(suggestion.source).toBe('history')
    expect(suggestion.amount_g).toBeLessThanOrEqual(Math.round(175 * 1.6))
    expect(suggestion.amount_g).toBeGreaterThanOrEqual(Math.round(175 * 0.5))
    // Real fiber comes through — COMMON_FOODS has no fiber_per_100g field at all.
    expect(suggestion.fiber_g).toBeGreaterThan(0)
  })

  it('a name present in BOTH history and library is served from history (real averaged macros), not duplicated', async () => {
    // Two filler library items push real-candidate count to 3+ so COMMON_FOODS is
    // NOT injected (keeps the candidate pool small/deterministic — 3 names total,
    // all guaranteed inside the top-6 slice regardless of fit_score ranking).
    const libraryDup = { name: 'Valio Pro Feel', kcal_per_100g: 70, protein_per_100g: 15, fat_per_100g: 0.4, carbs_per_100g: 13, sugar_per_100g: 2, fiber_per_100g: 0 }
    const filler1 = { name: 'Творог 5%', kcal_per_100g: 121, protein_per_100g: 17, fat_per_100g: 5, carbs_per_100g: 1.8, sugar_per_100g: 1.8, fiber_per_100g: 0 }
    const filler2 = { name: 'Банан', kcal_per_100g: 89, protein_per_100g: 1.1, fat_per_100g: 0.3, carbs_per_100g: 23, sugar_per_100g: 12.2, fiber_per_100g: 2.6 }
    const app = buildApp([libraryDup, filler1, filler2], HISTORY_SNACK)
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=snack&kcal=600&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    const matches = res.body.filter((s: { food_name: string }) => s.food_name === 'Valio Pro Feel')
    expect(matches.length).toBe(1)
    expect(matches[0].source).toBe('history')
    // History carries real fiber (0.5); the library duplicate (fiber 0) must NOT win.
    expect(matches[0].fiber_g).toBeGreaterThan(0)
  })

  it('with 3+ real candidates (history+library), COMMON_FOODS is NOT topped up', async () => {
    const libraryFoods = [
      { name: 'Творог 5%', kcal_per_100g: 121, protein_per_100g: 17, fat_per_100g: 5, carbs_per_100g: 1.8, sugar_per_100g: 1.8, fiber_per_100g: 0 },
      { name: 'Банан', kcal_per_100g: 89, protein_per_100g: 1.1, fat_per_100g: 0.3, carbs_per_100g: 23, sugar_per_100g: 12.2, fiber_per_100g: 2.6 },
    ]
    const app = buildApp(libraryFoods, HISTORY_SNACK) // 1 history name + 2 library names = 3 real candidates
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=snack&kcal=600&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    expect(res.body.every((s: { source: string }) => s.source !== 'common')).toBe(true)
  })

  it('a library food with serving_size_g gets its portion clamped by that serving (#873 Частина 2д)', async () => {
    // Сир твердий: real live #873 fixture — serving_size_g:25 ("1 шматочок"), kcal_per_100g:355.
    // Two filler items push real-candidate count to 3+ so COMMON_FOODS is NOT
    // injected — 3 names total, all guaranteed inside the top-6 slice.
    const cheeseSlice = { name: 'Сир твердий (Голландський)', kcal_per_100g: 355, protein_per_100g: 25, fat_per_100g: 28, carbs_per_100g: 1, sugar_per_100g: 0.5, fiber_per_100g: 0, serving_size_g: 25 }
    const filler1 = { name: 'Творог 5%', kcal_per_100g: 121, protein_per_100g: 17, fat_per_100g: 5, carbs_per_100g: 1.8, sugar_per_100g: 1.8, fiber_per_100g: 0 }
    const filler2 = { name: 'Банан', kcal_per_100g: 89, protein_per_100g: 1.1, fat_per_100g: 0.3, carbs_per_100g: 23, sugar_per_100g: 12.2, fiber_per_100g: 2.6 }
    const app = buildApp([cheeseSlice, filler1, filler2], [])
    const res = await request(app).get(
      '/api/nutrition/meal-suggest?meal_type=snack&kcal=2000&protein_g=45&carbs_g=60&fat_g=20'
    )
    expect(res.status).toBe(200)
    const suggestion = res.body.find((s: { food_name: string }) => s.food_name === 'Сир твердий (Голландський)')
    expect(suggestion).toBeDefined()
    // Without the serving clamp, 2000 kcal target / 355 kcal per 100g -> ~563g,
    // clamped to the old [30,500] band -> 500g of cheese. With the clamp it must
    // stay near serving_size_g (25g) * 1.6 = 40g.
    expect(suggestion.amount_g).toBeLessThanOrEqual(40)
  })
})
