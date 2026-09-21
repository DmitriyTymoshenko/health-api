/**
 * Route-level wiring test for #1473 — POST /api/workouts and PUT /api/workouts/:id must
 * register/match every exercise in `exercises_library`, same as POST /log-text already
 * did (workouts_log_text_route.test.ts). Before this fix, a session written through
 * these two routes (any `source` — manual UI, `lisa`, etc.) left new exercise names
 * invisible to the library, so `PATCH /exercises/:name/muscle-group` 404'd for them —
 * this hit bodyweight sessions (sets with `reps` only, no `weight_kg`) hardest, because
 * they are ONLY ever written through POST / or PUT /:id, never /log-text.
 *
 * Mounts the REAL route factory (routes/workouts.js), stub `exercises_library` +
 * `workouts` collections, same pattern as workouts_log_text_route.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

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
      // #1474: bodyweight-set autofill reads the latest weight_log entry on/before the
      // session date, wired into POST / and PUT /:id alongside the #1473 registration
      // below. Default empty -> resolveBodyweightForDate returns null (no measurement
      // yet), matching this file's existing assertions (none of them inspect weight_kg).
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

describe('POST /api/workouts — #1473 registers exercises in exercises_library', () => {
  it('a bodyweight exercise (sets with reps only, no weight_kg) is auto-created in exercises_library', async () => {
    const { app, exercises } = makeApp({ exercises: [] })
    const res = await request(app)
      .post('/api/workouts')
      .send({
        date: '2026-09-15',
        source: 'lisa',
        exercises: [
          { name: 'Планка (сек)', sets: [{ reps: 60 }, { reps: 60 }, { reps: 45 }] },
        ],
      })
    expect(res.status).toBe(201)
    expect(exercises).toHaveLength(1)
    expect(exercises[0]).toMatchObject({ name: 'Планка (сек)', muscle_group: null, equipment: null, weight_unit: null })
  })

  it('re-POSTing a session with the SAME exercise name does not create a duplicate library entry', async () => {
    const { app, exercises } = makeApp({ exercises: [] })
    await request(app).post('/api/workouts').send({
      date: '2026-09-15',
      source: 'lisa',
      exercises: [{ name: 'Mountain climbers (на ногу)', sets: [{ reps: 20 }] }],
    })
    await request(app).post('/api/workouts').send({
      date: '2026-09-16',
      source: 'lisa',
      exercises: [{ name: 'Mountain climbers (на ногу)', sets: [{ reps: 20 }] }],
    })
    expect(exercises).toHaveLength(1)
  })

  it('a KNOWN exercise (already in the library) is matched, not duplicated, regardless of source', async () => {
    const { app, exercises } = makeApp({ exercises: [{ _id: 'lib_1', name: 'Присідання', muscle_group: 'legs', weight_unit: 'kg' }] })
    const res = await request(app).post('/api/workouts').send({
      date: '2026-09-15',
      source: 'manual',
      exercises: [{ name: 'Присідання', sets: [{ reps: 10, weight_kg: 80 }] }],
    })
    expect(res.status).toBe(201)
    expect(exercises).toHaveLength(1)
  })

  it('a session with no exercises does not touch the library', async () => {
    const { app, exercises } = makeApp({ exercises: [] })
    const res = await request(app).post('/api/workouts').send({ date: '2026-09-15', source: 'manual', exercises: [] })
    expect(res.status).toBe(201)
    expect(exercises).toHaveLength(0)
  })
})

describe('PUT /api/workouts/:id — #1473 registers exercises in exercises_library', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ObjectId } = require('mongodb')
  const workoutId = new ObjectId().toString()

  it('a NEW exercise added via edit is registered in exercises_library', async () => {
    const { app, exercises } = makeApp({
      exercises: [],
      workouts: [{ _id: workoutId, date: '2026-09-15', source: 'lisa', exercises: [] }],
    })
    const res = await request(app)
      .put(`/api/workouts/${workoutId}`)
      .send({ exercises: [{ name: 'Підйом ніг лежачи', sets: [{ reps: 15 }] }] })
    expect(res.status).toBe(200)
    expect(exercises).toHaveLength(1)
    expect(exercises[0]).toMatchObject({ name: 'Підйом ніг лежачи', muscle_group: null })
  })

  it('404 for a well-formed but non-existent workout id — unaffected by the #1473 change', async () => {
    const { app } = makeApp({ exercises: [], workouts: [] })
    const res = await request(app).put(`/api/workouts/${new ObjectId().toString()}`).send({ exercises: [] })
    expect(res.status).toBe(404)
  })
})

export {}
