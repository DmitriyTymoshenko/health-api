/**
 * Route-level wiring test for GET /api/workouts/progression (#1291). Mounts the REAL
 * route factory (routes/workouts.js) with a stub DB covering the 3 collections it
 * touches (exercises_library, workouts, training_programs), same pattern as
 * workouts_exercise_history_reps.test.ts (#1130) and training_program route tests.
 * Decision logic itself is unit-tested in exercise_progression.test.ts — this file only
 * proves the route reads the right collections/fields and calls evaluateProgression().
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

function makeApp(opts: {
  exercises?: Array<Record<string, unknown>>
  workouts?: Array<Record<string, unknown>>
  program?: Record<string, unknown> | null
}) {
  const exercises = opts.exercises || []
  const workouts = opts.workouts || []
  const program = opts.program ?? null

  const db = {
    collection(name: string) {
      if (name === 'exercises_library') {
        return { findOne: async (filter: { name: string }) => exercises.find(e => e.name === filter.name) || null }
      }
      if (name === 'workouts') {
        return {
          find(filter: { 'exercises.name'?: string }) {
            const exerciseName = filter['exercises.name']
            const matched = workouts.filter((w: any) => (w.exercises || []).some((e: any) => e.name === exerciseName))
            return { sort() { return this }, toArray: async () => matched }
          },
        }
      }
      if (name === 'training_programs') {
        return { findOne: async () => program }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
  const app = express()
  app.use('/api/workouts', workoutsRoute(() => db))
  return app
}

const PROGRAM = {
  is_active: true,
  version: 1,
  days: [
    { key: 'A', exercises: [{ name: 'Жим в нахилі', target_reps: '8-12' }, { name: 'Планка', target_reps: '45с' }] },
    { key: 'home', exercises: [{ name: 'Підтягування', target_reps: 'макс' }] },
  ],
}

describe('GET /api/workouts/progression', () => {
  it('400 when name is missing', async () => {
    const app = makeApp({})
    const res = await request(app).get('/api/workouts/progression')
    expect(res.status).toBe(400)
  })

  it('weight_unit set on the exercise -> full progression decision (add_reps, owner\'s bench-press pattern)', async () => {
    const app = makeApp({
      exercises: [{ name: 'Жим в нахилі', equipment: 'barbell', weight_unit: 'kg' }],
      workouts: [{ date: '2026-09-09', exercises: [{ name: 'Жим в нахилі', sets: [
        { weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 7 }, { weight_kg: 80, reps: 6 },
      ] }] }],
      program: PROGRAM,
    })
    const res = await request(app).get('/api/workouts/progression').query({ name: 'Жим в нахилі' })
    expect(res.status).toBe(200)
    expect(res.body.next_action).toBe('add_reps')
    expect(res.body.reason_code).toBe('below_range_top')
    expect(res.body.working_weight_kg).toBe(80)
    expect(res.body.equipment).toBe('barbell')
  })

  it('exercise not in exercises_library at all -> equipment/weight_unit null, still evaluates from program+sessions', async () => {
    const app = makeApp({
      exercises: [],
      workouts: [{ date: '2026-09-09', exercises: [{ name: 'Планка', sets: [{ reps: 45 }] }] }],
      program: PROGRAM,
    })
    const res = await request(app).get('/api/workouts/progression').query({ name: 'Планка' })
    expect(res.status).toBe(200)
    expect(res.body.next_action).toBe('not_applicable')
    expect(res.body.reason_code).toBe('time_based')
    expect(res.body.equipment).toBeNull()
  })

  it('no active program document at all -> falls through to not_in_program (no auto-seed side effect)', async () => {
    const app = makeApp({
      exercises: [{ name: 'Підтягування', equipment: 'bodyweight' }],
      workouts: [{ date: '2026-09-09', exercises: [{ name: 'Підтягування', sets: [{ reps: 12 }] }] }],
      program: null,
    })
    const res = await request(app).get('/api/workouts/progression').query({ name: 'Підтягування' })
    expect(res.status).toBe(200)
    expect(res.body.next_action).toBe('range_not_set')
    expect(res.body.reason_code).toBe('not_in_program')
  })
})

export {}
