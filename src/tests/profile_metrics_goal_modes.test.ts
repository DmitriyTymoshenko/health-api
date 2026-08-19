/**
 * Route-level tests for GET /api/profile/metrics after the #968 goal-mode wiring.
 *
 * These mount the REAL route factory (routes/personal_profile.js exports
 * `function (getDB)`) with a stub `getDB`, so no Mongo is needed and the assertions
 * run against production code rather than a re-implementation of it.
 *
 * WHY this file exists: the `deficit_kcal || 500` -> `??` class fix is NOT safe on its
 * own here. `days_to_goal = toGoal * 7700 / deficit` divides by the deficit, so a
 * maintenance profile (deficit 0) yields Infinity, and the very next line does
 * `d.setDate(d.getDate() + Infinity)` -> Invalid Date -> `.toISOString()` throws
 * RangeError -> HTTP 500. The old `|| 500` was accidentally hiding that landmine.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const profileRoute = require('../../routes/personal_profile')

/** Minimal in-memory stand-in for the two collections this route touches. */
function makeApp(profile: Record<string, unknown> | null, weightKg: number | null = 98.2) {
  const db = {
    collection(name: string) {
      if (name === 'personal_profile') {
        return { findOne: async () => profile }
      }
      if (name === 'weights') {
        return { findOne: async () => (weightKg == null ? null : { weight_kg: weightKg, date: '2026-08-09' }) }
      }
      return { findOne: async () => null }
    },
  }
  const app = express()
  app.use('/api/profile', profileRoute(() => db))
  return app
}

const LIVE_PROFILE = {
  height_cm: 186,
  birth_year: 1995,
  activity_level: 'moderate',
  weight_goal_kg: 96,
  tdee_kcal: 2429,
  deficit_kcal: 500,
  primary_goal: 'weight_loss',
}

describe('GET /api/profile/metrics — goal modes must not crash the ETA', () => {
  it('maintenance (deficit 0) returns 200, not a RangeError 500', async () => {
    const app = makeApp({ ...LIVE_PROFILE, deficit_kcal: 0, primary_goal: 'maintenance' })
    const res = await request(app).get('/api/profile/metrics')
    expect(res.status).toBe(200)
    expect(res.body.days_to_goal).toBe(0) // honest "no ETA", not Infinity
    expect(res.body.target_date_estimated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('muscle_gain reports no weight-loss ETA instead of inventing one from a stale deficit', async () => {
    const app = makeApp({ ...LIVE_PROFILE, primary_goal: 'muscle_gain' })
    const res = await request(app).get('/api/profile/metrics')
    expect(res.status).toBe(200)
    // deficit_kcal is still 500 in the document, but the MODE says we are building.
    expect(res.body.days_to_goal).toBe(0)
  })

  it('REGRESSION — weight_loss + deficit 500 keeps the ETA it has today', async () => {
    const app = makeApp(LIVE_PROFILE)
    const res = await request(app).get('/api/profile/metrics')
    expect(res.status).toBe(200)
    // 98.2 - 96 = 2.2 kg -> 2.2 * 7700 / 500 = 33.88 -> 34 days
    expect(res.body.kg_to_goal).toBe(2.2)
    expect(res.body.days_to_goal).toBe(34)
    // #966: 157 (1.6 g/kg flat) -> 196 (weight_loss = 2.0 g/kg). This is the owner's
    // expected change, stated in the #966 acceptance criteria, not a regression.
    expect(res.body.protein_recommended_g).toBe(196)
  })

  it('#966 — protein_recommended_g follows the goal mode on THIS route too, not just /nutrition/summary', async () => {
    // The point of this route-level test: proving `profile` is actually threaded into
    // proteinGoalG() here. A lib-only test would still pass if this call site had been
    // left as proteinGoalG(weight) — silently pinned to weight_loss on a screen the
    // owner reads next to the summary (BASE RULE: one quantity, one answer).
    const expected: Record<string, number> = {
      weight_loss: 196, // 98.2 * 2.0
      muscle_gain: 177, // 98.2 * 1.8
      maintenance: 157, // 98.2 * 1.6
      recomp: 216, // 98.2 * 2.2
      endurance: 128, // 98.2 * 1.3
    }
    for (const [primary_goal, grams] of Object.entries(expected)) {
      const app = makeApp({ ...LIVE_PROFILE, primary_goal })
      const res = await request(app).get('/api/profile/metrics')
      expect(res.status).toBe(200)
      expect({ primary_goal, g: res.body.protein_recommended_g }).toEqual({ primary_goal, g: grams })
    }
  })

  it('already at/below goal weight still reports 0 days in every mode', async () => {
    for (const primary_goal of ['weight_loss', 'maintenance', 'muscle_gain', 'recomp', 'endurance']) {
      const app = makeApp({ ...LIVE_PROFILE, primary_goal }, 95)
      const res = await request(app).get('/api/profile/metrics')
      expect(res.status).toBe(200)
      expect(res.body.days_to_goal).toBe(0)
    }
  })
})

export {};
