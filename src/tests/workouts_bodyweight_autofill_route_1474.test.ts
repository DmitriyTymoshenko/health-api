/**
 * Route-level wiring test for #1474 — POST /api/workouts and PUT /api/workouts/:id must
 * autofill `weight_kg` on a bodyweight set (reps only, no weight_kg/weight_input) from
 * the owner's latest `weight_log` entry on/before the session date, tagging
 * `weight_source: 'bodyweight'`. Mounts the REAL route factory (routes/workouts.js),
 * same pattern as workouts_post_registers_exercises_1473.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb')

function makeApp(opts: {
  exercises?: Array<Record<string, any>>
  workouts?: Array<Record<string, any>>
  weightLog?: Array<Record<string, any>>
}) {
  const exercises: Array<Record<string, any>> = opts.exercises || []
  const workouts: Array<Record<string, any>> = opts.workouts || []
  const weightLog: Array<Record<string, any>> = opts.weightLog || []

  const db = {
    collection(name: string) {
      if (name === 'weight_log') {
        return {
          find: (filter: any = {}) => {
            const maxDate = filter?.date?.$lte
            const matched = weightLog.filter((w: any) => !maxDate || w.date <= maxDate)
            return {
              sort: () => ({
                limit: () => ({
                  toArray: async () => [...matched].sort((a: any, b: any) => (a.date < b.date ? 1 : -1)).slice(0, 1),
                }),
              }),
            }
          },
        }
      }
      if (name === 'exercises_library') {
        return {
          findOne: async (filter: any) => {
            const re = filter.name.$regex
            return exercises.find(e => re.test(e.name as string)) || null
          },
          find: (filter: any) => ({
            toArray: async () => {
              const names: string[] = filter.name.$in
              return exercises.filter(e => names.includes(e.name as string))
            },
          }),
          insertOne: async (doc: any) => {
            const _id = `lib_${exercises.length + 1}`
            exercises.push({ ...doc, _id })
            return { insertedId: _id }
          },
        }
      }
      if (name === 'workouts') {
        return {
          find: (filter: any = {}) => ({
            sort: () => ({ toArray: async () => workouts }),
            toArray: async () => workouts,
          }),
          findOne: async (filter: any) => workouts.find(w => String(w._id) === String(filter._id)) || null,
          insertOne: async (doc: any) => {
            const _id = `wk_${workouts.length + 1}`
            workouts.push({ ...doc, _id })
            return { insertedId: _id }
          },
          findOneAndUpdate: async (filter: any, update: any) => {
            const doc = workouts.find(w => String(w._id) === String(filter._id))
            if (!doc) return null
            Object.assign(doc, update.$set)
            return doc
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workouts', workoutsRoute(() => db))
  return { app, exercises, workouts }
}

describe('POST /api/workouts — #1474 bodyweight autofill', () => {
  it('fills weight_kg from the latest weight_log entry ON/BEFORE the session date + tags weight_source', async () => {
    const { app } = makeApp({
      exercises: [],
      weightLog: [
        { date: '2026-09-16', weight_kg: 92.9 },
        { date: '2026-09-20', weight_kg: 91.0 }, // after session date — must be ignored
      ],
    })
    const res = await request(app).post('/api/workouts').send({
      date: '2026-09-17',
      source: 'lisa',
      exercises: [{ name: 'Планка (сек)', sets: [{ reps: 60 }, { reps: 45 }] }],
    })
    expect(res.status).toBe(201)
    expect(res.body.exercises[0].sets).toEqual([
      { reps: 60, weight_kg: 92.9, weight_source: 'bodyweight' },
      { reps: 45, weight_kg: 92.9, weight_source: 'bodyweight' },
    ])
  })

  it('leaves weight_kg null (no hardcode) when NO weight_log entry exists yet', async () => {
    const { app } = makeApp({ exercises: [], weightLog: [] })
    const res = await request(app).post('/api/workouts').send({
      date: '2026-09-17',
      source: 'lisa',
      exercises: [{ name: 'Планка (сек)', sets: [{ reps: 60 }] }],
    })
    expect(res.status).toBe(201)
    expect(res.body.exercises[0].sets[0]).toEqual({ reps: 60, weight_kg: null, weight_source: 'bodyweight' })
  })

  it('does NOT overwrite an explicitly-sent weight_kg', async () => {
    const { app } = makeApp({ exercises: [], weightLog: [{ date: '2026-09-16', weight_kg: 92.9 }] })
    const res = await request(app).post('/api/workouts').send({
      date: '2026-09-17',
      source: 'manual',
      exercises: [{ name: 'Жим лежачи', sets: [{ reps: 8, weight_kg: 80 }] }],
    })
    expect(res.status).toBe(201)
    expect(res.body.exercises[0].sets[0]).toEqual({ reps: 8, weight_kg: 80 })
  })

  it('does NOT touch a set with an unresolved weight_input (unit_required state, #1314/#1318)', async () => {
    const { app } = makeApp({ exercises: [], weightLog: [{ date: '2026-09-16', weight_kg: 92.9 }] })
    const res = await request(app).post('/api/workouts').send({
      date: '2026-09-17',
      source: 'telegram-log',
      exercises: [{ name: 'Розводка', sets: [{ reps: 8, weight_input: 20, weight_unit: null, weight_kg: null }] }],
    })
    expect(res.status).toBe(201)
    expect(res.body.exercises[0].sets[0]).toEqual({ reps: 8, weight_input: 20, weight_unit: null, weight_kg: null })
  })
})

describe('PUT /api/workouts/:id — #1474 bodyweight autofill', () => {
  const workoutId = new ObjectId().toString()

  it('resolves the session date from the EXISTING doc when the edit body omits `date`', async () => {
    const { app } = makeApp({
      exercises: [],
      workouts: [{ _id: workoutId, date: '2026-09-15', source: 'lisa', exercises: [] }],
      weightLog: [{ date: '2026-09-14', weight_kg: 93.5 }],
    })
    const res = await request(app)
      .put(`/api/workouts/${workoutId}`)
      .send({ exercises: [{ name: 'Підйом ніг лежачи', sets: [{ reps: 15 }] }] })
    expect(res.status).toBe(200)
    expect(res.body.exercises[0].sets[0]).toEqual({ reps: 15, weight_kg: 93.5, weight_source: 'bodyweight' })
  })

  it('uses the explicit `date` from the edit body when present, not the stored one', async () => {
    const { app } = makeApp({
      exercises: [],
      workouts: [{ _id: workoutId, date: '2026-09-10', source: 'lisa', exercises: [] }],
      weightLog: [
        { date: '2026-09-10', weight_kg: 95.0 },
        { date: '2026-09-17', weight_kg: 92.9 },
      ],
    })
    const res = await request(app)
      .put(`/api/workouts/${workoutId}`)
      .send({ date: '2026-09-17', exercises: [{ name: 'Планка (сек)', sets: [{ reps: 60 }] }] })
    expect(res.status).toBe(200)
    expect(res.body.exercises[0].sets[0]).toEqual({ reps: 60, weight_kg: 92.9, weight_source: 'bodyweight' })
  })
})

export {}
