/**
 * Route-level wiring test for GET /api/workouts/exercise-trends (#1417). Mounts the
 * REAL route factory (routes/workouts.js) with a stub DB covering `workouts` and
 * `exercises_library`, same pattern as workouts_volume_by_muscle_route.test.ts
 * (#1410) and workouts_progression_route.test.ts (#1291). Classification logic itself
 * is unit-tested in exercise_trends.test.ts — this file only proves the route reads
 * the right collection/projection, validates `window`, and wires the result through.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

function chain(data: Array<Record<string, unknown>>) {
  return {
    sort() { return this },
    limit() { return this },
    toArray: async () => data,
  }
}

function makeApp(opts: {
  exercises?: Array<Record<string, unknown>>
  workouts?: Array<Record<string, unknown>>
}) {
  const exercises = opts.exercises || []
  const workouts = opts.workouts || []

  const db = {
    collection(name: string) {
      if (name === 'workouts') {
        return {
          find() {
            return chain(workouts)
          },
        }
      }
      if (name === 'exercises_library') {
        return {
          find(filter: { name?: { $in: string[] } }) {
            const names = new Set(filter.name?.$in || [])
            return chain(exercises.filter((e: any) => names.has(e.name)))
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }

  const app = express()
  app.use('/api/workouts', workoutsRoute(() => db))
  return app
}

describe('GET /api/workouts/exercise-trends', () => {
  it('200 with empty journal -> {exercises:[]}, not 404', async () => {
    const app = makeApp({})
    const res = await request(app).get('/api/workouts/exercise-trends')
    expect(res.status).toBe(200)
    expect(res.body.exercises).toEqual([])
    expect(typeof res.body.generated_for).toBe('string')
  })

  it('A1 fixture: "Жим гантелей лежачи" 3 sessions -> down, delta -24.0%, matches /progress numbers', async () => {
    const app = makeApp({
      exercises: [{ name: 'Жим гантелей лежачи', muscle_group: 'chest' }],
      workouts: [
        { date: '2026-03-26', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 45, reps: 6 }] }] },
        { date: '2026-03-31', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 37.5, reps: 10 }] }] },
        { date: '2026-09-17', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 30, reps: 8 }] }] },
      ],
    })
    const res = await request(app).get('/api/workouts/exercise-trends')
    expect(res.status).toBe(200)
    const ex = res.body.exercises.find((e: any) => e.name === 'Жим гантелей лежачи')
    expect(ex.sessions_count).toBe(3)
    expect(ex.status).toBe('down')
    expect(ex.delta_1rm_pct).toBe(-24.0)
    expect(ex.muscle_group).toBe('chest')

    // Cross-check against the SAME shared ranking function used by /progress —
    // A1 acceptance requires these to agree.
    const progressRes = await request(app).get('/api/workouts/progress').query({ name: 'Жим гантелей лежачи' })
    expect(progressRes.status).toBe(200)
    const lastProgress = progressRes.body[progressRes.body.length - 1]
    expect(lastProgress.est_1rm).toBe(ex.last.est_1rm)
  })

  it('11-exercise live-shaped fixture: 10 single-session exercises -> insufficient, not flat', async () => {
    const workouts = [
      { date: '2026-03-26', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 45, reps: 6 }] }] },
      { date: '2026-03-31', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 37.5, reps: 10 }] }] },
      {
        date: '2026-09-17',
        exercises: [
          { name: 'Жим гантелей лежачи', sets: [{ weight_kg: 30, reps: 8 }] },
          { name: 'Планка', sets: [{ reps: 60 }] },
          { name: 'Присідання', sets: [{ weight_kg: 80, reps: 5 }] },
        ],
      },
    ]
    const app = makeApp({ workouts })
    const res = await request(app).get('/api/workouts/exercise-trends')
    expect(res.status).toBe(200)
    const plank = res.body.exercises.find((e: any) => e.name === 'Планка')
    const squat = res.body.exercises.find((e: any) => e.name === 'Присідання')
    expect(plank.status).toBe('insufficient')
    expect(squat.status).toBe('insufficient')
    expect(plank.sessions_count).toBe(1)
  })

  it('400 when window is not an integer >= 2', async () => {
    const app = makeApp({})
    expect((await request(app).get('/api/workouts/exercise-trends').query({ window: '1' })).status).toBe(400)
    expect((await request(app).get('/api/workouts/exercise-trends').query({ window: 'abc' })).status).toBe(400)
    expect((await request(app).get('/api/workouts/exercise-trends').query({ window: '2.5' })).status).toBe(400)
  })

  it('window=2 (valid) -> 200, only last 2 sessions considered', async () => {
    const app = makeApp({
      workouts: [
        { date: '2026-01-01', exercises: [{ name: 'X', sets: [{ weight_kg: 200, reps: 5 }] }] },
        { date: '2026-09-01', exercises: [{ name: 'X', sets: [{ weight_kg: 100, reps: 5 }] }] },
        { date: '2026-09-10', exercises: [{ name: 'X', sets: [{ weight_kg: 110, reps: 5 }] }] },
      ],
    })
    const res = await request(app).get('/api/workouts/exercise-trends').query({ window: '2' })
    expect(res.status).toBe(200)
    expect(res.body.exercises[0].sessions_count).toBe(2)
  })
})

export {}
