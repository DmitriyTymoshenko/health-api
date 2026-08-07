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

function buildApp(libraryDocs: Record<string, unknown>[]) {
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
