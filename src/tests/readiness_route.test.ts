/**
 * Route-level wiring test for GET /api/readiness (#1292, Ф3). Mounts the REAL
 * route factory (routes/readiness.js) with a stub DB covering whoop_recovery,
 * whoop_sleep, workouts, training_programs — same pattern as
 * workouts_exercise_trends_route.test.ts (#1417). Classification logic itself is
 * unit-tested in readiness.test.ts / recovery_zone.test.ts; this file proves the
 * route resolves the right collections, validates `date`, and wires the result
 * through (incl. the controlled-date + night-bounds acceptance check).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const readinessRoute = require('../../routes/readiness')

function makeApp(opts: {
  recoveryDocs?: Array<Record<string, unknown>>
  sleepDocs?: Array<Record<string, unknown>>
  workouts?: Array<Record<string, unknown>>
  program?: Record<string, unknown> | null
}) {
  const recoveryDocs = opts.recoveryDocs || []
  const sleepDocs = opts.sleepDocs || []
  const workouts = opts.workouts || []
  const program = opts.program ?? null

  const db = {
    collection(name: string) {
      if (name === 'whoop_recovery') {
        return {
          findOne: async (filter: { date: string }) =>
            recoveryDocs.find((r: any) => r.date === filter.date) || null,
          find(filter: { date: { $gte: string; $lte: string } }) {
            return {
              toArray: async () =>
                recoveryDocs.filter((r: any) => r.date >= filter.date.$gte && r.date <= filter.date.$lte),
            }
          },
        }
      }
      if (name === 'whoop_sleep') {
        return {
          findOne: async (filter: { sleep_id: string }) =>
            sleepDocs.find((s: any) => s.sleep_id === filter.sleep_id) || null,
        }
      }
      if (name === 'workouts') {
        return {
          find() {
            return { sort() { return this }, toArray: async () => workouts }
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
  app.use('/api/readiness', readinessRoute(() => db))
  return app
}

const ALL_WEEKDAYS_PROGRAM = {
  is_active: true,
  version: 1,
  schedule: { A: [1, 2, 3, 4, 5, 6, 7] }, // matches any date — route wiring test, not weekday math
  days: [
    {
      key: 'A',
      exercises: [{ name: 'Жим гантелей лежачи' }, { name: 'Тяга гантелі' }],
    },
  ],
}

describe('GET /api/readiness', () => {
  it('400 when date is not YYYY-MM-DD', async () => {
    const app = makeApp({})
    const res = await request(app).get('/api/readiness').query({ date: '19-09-2026' })
    expect(res.status).toBe(400)
  })

  it('no recovery for the target date -> 200, data_fresh:false, level null', async () => {
    const app = makeApp({ recoveryDocs: [] })
    const res = await request(app).get('/api/readiness').query({ date: '2026-09-19' })
    expect(res.status).toBe(200)
    expect(res.body.data_fresh).toBe(false)
    expect(res.body.level).toBeNull()
  })

  it('controlled date: recovery zone matches activity_plan.js thresholds (78 -> hard) and night bounds are returned via sleep_id join', async () => {
    const app = makeApp({
      recoveryDocs: [{ date: '2026-09-19', recovery_score: 78, sleep_id: 'sleep-abc' }],
      sleepDocs: [{ sleep_id: 'sleep-abc', start: '2026-09-18T21:08:41.440Z', end: '2026-09-19T04:54:31.740Z' }],
      program: null,
    })
    const res = await request(app).get('/api/readiness').query({ date: '2026-09-19' })
    expect(res.status).toBe(200)
    expect(res.body.date).toBe('2026-09-19')
    expect(res.body.recovery_score).toBe(78)
    expect(res.body.recovery_zone).toBe('hard')
    expect(res.body.data_fresh).toBe(true)
    expect(res.body.sleep_window).toEqual({
      start: '2026-09-18T21:08:41.440Z',
      end: '2026-09-19T04:54:31.740Z',
    })
  })

  it('no sleep_id on the recovery doc -> sleep_window null, does not throw', async () => {
    const app = makeApp({ recoveryDocs: [{ date: '2026-09-19', recovery_score: 78 }] })
    const res = await request(app).get('/api/readiness').query({ date: '2026-09-19' })
    expect(res.status).toBe(200)
    expect(res.body.sleep_window).toBeNull()
  })

  it('program-day exercises with a stalled one -> level pulled down even with green recovery', async () => {
    const app = makeApp({
      recoveryDocs: [{ date: '2026-09-19', recovery_score: 78 }],
      workouts: [
        { date: '2026-03-26', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 45, reps: 6 }] }] },
        { date: '2026-03-31', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 37.5, reps: 10 }] }] },
        { date: '2026-09-17', exercises: [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 30, reps: 8 }] }] },
      ],
      program: ALL_WEEKDAYS_PROGRAM,
    })
    const res = await request(app).get('/api/readiness').query({ date: '2026-09-19' })
    expect(res.status).toBe(200)
    expect(res.body.day_key).toBe('A')
    expect(res.body.level).toBe('hold')
    expect(res.body.stalled_exercises.length).toBe(1)
    expect(res.body.stalled_exercises[0].name).toBe('Жим гантелей лежачи')
    expect(res.body.reason_text).toContain('Жим гантелей лежачи')
  })

  it('no active program -> day_key null, todayExercises empty, level driven by recovery alone', async () => {
    const app = makeApp({ recoveryDocs: [{ date: '2026-09-19', recovery_score: 78 }], program: null })
    const res = await request(app).get('/api/readiness').query({ date: '2026-09-19' })
    expect(res.status).toBe(200)
    expect(res.body.day_key).toBeNull()
    expect(res.body.level).toBe('as_planned')
  })

  it('default date (no query param) is a valid YYYY-MM-DD string', async () => {
    const app = makeApp({ recoveryDocs: [] })
    const res = await request(app).get('/api/readiness')
    expect(res.status).toBe(200)
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

export {}
