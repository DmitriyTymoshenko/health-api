/**
 * Route-level tests for GET /api/workouts/exercise-history and GET /api/workouts/progress
 * after the #1130 bodyweight reps-ranking fix.
 *
 * These mount the REAL route factory (routes/workouts.js exports `function (getDB)`) with
 * a stub `getDB`, so the assertions run against production code, not a re-implementation
 * of it (same pattern as profile_metrics_goal_modes.test.ts, #969).
 *
 * WHY this file exists: `calc1RM(weight, reps)` returns 0 whenever `weight` is falsy, and
 * both endpoints used to pick the "best" set via an orm-based reduce. For bodyweight
 * exercises (pull-ups, dips — no `weight_kg` on any set) every set tied at orm=0, so the
 * reduce never advanced past its `{orm:0, weight:0, reps:0}` seed — max_weight, best_reps
 * and est_1rm stayed 0 forever, and any progress chart for these exercises was a flat
 * line. Fixed by `pickBestSet()` ranking by reps when no set in the session carries a
 * positive `weight_kg`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

/** Minimal in-memory stand-in for the `workouts` collection this route touches. */
function makeApp(workouts: Array<Record<string, unknown>>) {
  const db = {
    collection(name: string) {
      if (name !== 'workouts') {
        throw new Error(`unexpected collection: ${name}`)
      }
      return {
        find(filter: { 'exercises.name'?: string }) {
          const exerciseName = filter['exercises.name']
          const matched = workouts.filter((w: any) =>
            (w.exercises || []).some((e: any) => e.name === exerciseName)
          )
          return {
            sort() {
              return this
            },
            skip() {
              return this
            },
            limit() {
              return this
            },
            toArray: async () => matched,
          }
        },
      }
    },
  }
  const app = express()
  app.use('/api/workouts', workoutsRoute(() => db))
  return app
}

// Live record 2026-08-23: 5 sets × 10 reps, no weight logged (bodyweight dip).
const BRUSY_23_08 = {
  date: '2026-08-23',
  name: 'Ранкове тренування',
  exercises: [
    {
      name: 'Віджимання на брусах',
      sets: [
        { reps: 10 },
        { reps: 10 },
        { reps: 10 },
        { reps: 10 },
        { reps: 10 },
      ],
    },
  ],
}

// Weighted regression fixture (same shape as the live dumbbell-press records).
const ZHYM_HANTELEY = [
  {
    date: '2026-03-26',
    name: 'Chest A',
    exercises: [
      {
        name: 'Жим гантелей лежачи',
        sets: [
          { weight_kg: 24, reps: 10 },
          { weight_kg: 26, reps: 8 },
        ],
      },
    ],
  },
  {
    date: '2026-03-31',
    name: 'Chest B',
    exercises: [
      {
        name: 'Жим гантелей лежачи',
        sets: [
          { weight_kg: 26, reps: 9 },
          { weight_kg: 28, reps: 6 },
        ],
      },
    ],
  },
]

describe('GET /api/workouts/exercise-history — bodyweight reps ranking (#1130)', () => {
  it('#1130 acceptance 1: Віджимання на брусах 23.08 → best_reps_set=10, total_reps=50 (was 0/0)', async () => {
    const app = makeApp([BRUSY_23_08])
    const res = await request(app).get('/api/workouts/exercise-history').query({ name: 'Віджимання на брусах' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].best_reps_set).toBe(10)
    expect(res.body[0].total_reps).toBe(50)
    // best_reps stays populated too (was the pre-existing but-also-broken field).
    expect(res.body[0].best_reps).toBe(10)
    // Bodyweight session never had a weight logged — these legitimately stay 0.
    expect(res.body[0].max_weight).toBe(0)
    expect(res.body[0].est_1rm).toBe(0)
  })

  it('REGRESSION 1: Жим гантелей лежачи (weighted) keeps its pre-#1130 max_weight/est_1rm', async () => {
    const app = makeApp(ZHYM_HANTELEY)
    const res = await request(app).get('/api/workouts/exercise-history').query({ name: 'Жим гантелей лежачи' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    // Session 1: 24×10→1RM=32.0, 26×8→1RM=32.9 (best) → max_weight=26
    expect(res.body[0].max_weight).toBe(26)
    expect(res.body[0].est_1rm).toBeCloseTo(32.9, 1)
    // Session 2: 26×9→1RM=33.8 (best), 28×6→1RM=33.6 → max_weight=26
    expect(res.body[1].max_weight).toBe(26)
    expect(res.body[1].est_1rm).toBeCloseTo(33.8, 1)
    // total_reps is a new, additive field — must not disturb the weighted ranking.
    expect(res.body[0].total_reps).toBe(18)
  })
})

describe('GET /api/workouts/progress — bodyweight reps metric (#1130)', () => {
  it('#1130 acceptance 2: Віджимання на брусах progress carries a nonzero reps metric', async () => {
    const app = makeApp([BRUSY_23_08])
    const res = await request(app).get('/api/workouts/progress').query({ name: 'Віджимання на брусах' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].best_reps_set).toBe(10)
    expect(res.body[0].total_reps).toBe(50)
    expect(res.body[0].max_weight).toBe(0)
    expect(res.body[0].est_1rm).toBe(0)
  })

  it('REGRESSION 2: Жим гантелей лежачи progress keeps its pre-#1130 max_weight/est_1rm', async () => {
    const app = makeApp(ZHYM_HANTELEY)
    const res = await request(app).get('/api/workouts/progress').query({ name: 'Жим гантелей лежачи' })
    expect(res.status).toBe(200)
    // /progress's max_weight is the heaviest single set logged (Math.max over weight_kg),
    // NOT the weight of the best-1RM set — that's exercise-history's semantics, unchanged
    // by #1130 either way. Session 1: max(24,26)=26. Session 2: max(26,28)=28.
    expect(res.body[0].max_weight).toBe(26)
    expect(res.body[0].est_1rm).toBeCloseTo(32.9, 1)
    expect(res.body[1].max_weight).toBe(28)
    expect(res.body[1].est_1rm).toBeCloseTo(33.8, 1)
  })
})

export {}
