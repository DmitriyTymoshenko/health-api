/**
 * Route-level tests for PATCH /api/workouts/exercises/:name/weight-unit (#1318 KROK 2,
 * health-api half — owner "Так, підходить" 2026-09-10, comment #7454).
 *
 * This is the ONE write path into `exercises_library.weight_unit` since KROK 1
 * (#1318) removed the silent kg-default that used to live in POST /log-text
 * (0ecbcf0). It also backfills weight_kg for any ALREADY-WRITTEN `workouts` session
 * that logged this exercise before the unit was known — "постфактум, ДОПОВНЮЮЧИ
 * наявний запис" per the owner's acceptance, never a rejection/re-ask.
 *
 * Mounts the REAL route factory (routes/workouts.js), stubbing BOTH collections this
 * route touches — same two-collection stub shape as workouts_log_text_route.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

function makeApp(opts: { exercises?: Array<Record<string, any>>; workouts?: Array<Record<string, any>> }) {
  const exercises: Array<Record<string, any>> = (opts.exercises || []).map(e => ({ ...e }))
  const workouts: Array<Record<string, any>> = (opts.workouts || []).map(w => ({ ...w }))

  const db = {
    collection(name: string) {
      if (name === 'exercises_library') {
        return {
          findOne: async (filter: { name?: string }) => exercises.find(e => e.name === filter.name) || null,
          updateOne: async (filter: { name?: string }, update: { $set: Record<string, any> }) => {
            const doc = exercises.find(e => e.name === filter.name)
            if (!doc) return { matchedCount: 0, modifiedCount: 0 }
            Object.assign(doc, update.$set)
            return { matchedCount: 1, modifiedCount: 1 }
          },
        }
      }
      if (name === 'workouts') {
        return {
          find: (filter: { 'exercises.name'?: string }) => ({
            toArray: async () =>
              workouts.filter(w => (w.exercises || []).some((e: any) => e.name === filter['exercises.name'])),
          }),
          updateOne: async (filter: { _id?: string }, update: { $set: Record<string, any> }) => {
            const doc = workouts.find(w => w._id === filter._id)
            if (!doc) return { matchedCount: 0 }
            Object.assign(doc, update.$set)
            return { matchedCount: 1 }
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

const ROZVODKA_SESSION = {
  _id: 'wk_1',
  date: '2026-09-09',
  source: 'telegram-log',
  exercises: [
    { name: 'Розводка', sets: [{ reps: 10, weight_input: 235, weight_unit: null, weight_kg: null }] },
  ],
  needs_unit_clarification: ['Розводка'],
}

describe('PATCH /api/workouts/exercises/:name/weight-unit (#1318 KROK 2)', () => {
  it('400 on a missing/invalid unit', async () => {
    const { app } = makeApp({ exercises: [{ name: 'Розводка', weight_unit: null }] })
    const res1 = await request(app).patch('/api/workouts/exercises/Розводка/weight-unit').send({})
    const res2 = await request(app).patch('/api/workouts/exercises/Розводка/weight-unit').send({ weight_unit: 'lbs' })
    expect(res1.status).toBe(400)
    expect(res2.status).toBe(400)
  })

  it('404 on an unknown exercise name, does not touch workouts', async () => {
    const { app, workouts } = makeApp({ exercises: [], workouts: [ROZVODKA_SESSION] })
    const res = await request(app)
      .patch('/api/workouts/exercises/Неіснуюча/weight-unit')
      .send({ weight_unit: 'kg' })
    expect(res.status).toBe(404)
    expect(workouts[0]).toEqual(ROZVODKA_SESSION) // untouched
  })

  it("writes weight_unit on the library entry and backfills the #1318 regression case (розводка 10х235 lb -> ~106.6 kg)", async () => {
    const { app, exercises, workouts } = makeApp({
      exercises: [{ name: 'Розводка', weight_unit: null }],
      workouts: [ROZVODKA_SESSION],
    })

    const res = await request(app)
      .patch('/api/workouts/exercises/Розводка/weight-unit')
      .send({ weight_unit: 'lb' })

    expect(res.status).toBe(200)
    expect(res.body.exercise.weight_unit).toBe('lb')
    expect(res.body.backfilled_sessions).toBe(1)
    expect(res.body.backfilled_sets).toBe(1)
    expect(exercises[0].weight_unit).toBe('lb')

    const set = workouts[0].exercises[0].sets[0]
    expect(set.weight_input).toBe(235) // owner's raw reading, never rewritten
    expect(set.weight_unit).toBe('lb')
    expect(set.weight_kg).toBe(106.59)
    expect(workouts[0].needs_unit_clarification).toEqual([]) // resolved, no longer flagged
  })

  it('a set that already had weight_kg resolved is left untouched by the backfill', async () => {
    const session = {
      _id: 'wk_2',
      exercises: [{ name: 'Скотта', sets: [{ weight_input: 999, weight_unit: 'kg', weight_kg: 999 }] }],
      needs_unit_clarification: [],
    }
    const { app, workouts } = makeApp({ exercises: [{ name: 'Скотта', weight_unit: null }], workouts: [session] })
    const res = await request(app).patch('/api/workouts/exercises/Скотта/weight-unit').send({ weight_unit: 'lb' })
    expect(res.status).toBe(200)
    // already-resolved set is NOT reconverted even though the exercise's unit just changed
    expect(workouts[0].exercises[0].sets[0]).toEqual({ weight_input: 999, weight_unit: 'kg', weight_kg: 999 })
  })

  it('a session with no unresolved set for this exercise is skipped (backfilled_sessions stays 0)', async () => {
    const session = {
      _id: 'wk_3',
      exercises: [{ name: 'Тяга блока', sets: [{ weight_input: 52, weight_unit: 'kg', weight_kg: 52 }] }],
      needs_unit_clarification: [],
    }
    const { app, workouts } = makeApp({ exercises: [{ name: 'Тяга блока', weight_unit: 'kg' }], workouts: [session] })
    const res = await request(app)
      .patch(`/api/workouts/exercises/${encodeURIComponent('Тяга блока')}/weight-unit`)
      .send({ weight_unit: 'kg' })
    expect(res.status).toBe(200)
    expect(res.body.backfilled_sessions).toBe(0)
    expect(res.body.backfilled_sets).toBe(0)
    expect(workouts[0]).toEqual(session) // byte-for-byte untouched
  })

  it('a mixed session backfills only the named exercise, leaves a sibling exercise alone', async () => {
    const session = {
      _id: 'wk_4',
      exercises: [
        { name: 'Розводка', sets: [{ weight_input: 235, weight_unit: null, weight_kg: null }] },
        { name: 'Скотта', sets: [{ weight_input: 160, weight_unit: null, weight_kg: null }] },
      ],
      needs_unit_clarification: ['Розводка', 'Скотта'],
    }
    const { app, workouts } = makeApp({
      exercises: [{ name: 'Розводка', weight_unit: null }, { name: 'Скотта', weight_unit: null }],
      workouts: [session],
    })
    const res = await request(app).patch('/api/workouts/exercises/Розводка/weight-unit').send({ weight_unit: 'lb' })
    expect(res.status).toBe(200)
    expect(workouts[0].exercises[0].sets[0].weight_kg).toBe(106.59) // Розводка resolved
    expect(workouts[0].exercises[1].sets[0].weight_kg).toBeNull() // Скотта untouched
    expect(workouts[0].needs_unit_clarification).toEqual(['Скотта']) // partially cleared
  })
})

export {}
