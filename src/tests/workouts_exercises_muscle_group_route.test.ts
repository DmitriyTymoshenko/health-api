/**
 * Route-level tests for PATCH /api/workouts/exercises/:name/muscle-group (#1408).
 *
 * This is the ONE write path into `exercises_library.muscle_group` — the generic
 * content-PATCH at routes/workouts.js:158 deliberately excludes muscle_group from its
 * whitelist, and POST /log-text (#1314) auto-creates a library entry with
 * muscle_group:null on an unknown exercise name but never fills it in. Before this
 * route existed, a null muscle_group was permanently stuck (4/36 library entries,
 * #1408 triage) with the dashboard silently bucketing them into "⚡ Інше".
 *
 * Mounts the REAL route factory (routes/workouts.js), same two-collection stub shape
 * as workouts_exercises_weight_unit_route.test.ts (its sibling route).
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

const TEST2_SESSION = {
  _id: 'wk_1',
  date: '2026-09-18',
  source: 'telegram-log',
  exercises: [{ name: 'Тест2', sets: [{ reps: 6, weight_input: 20, weight_unit: 'kg', weight_kg: 20 }] }],
  needs_muscle_group_clarification: ['Тест2'],
}

describe('PATCH /api/workouts/exercises/:name/muscle-group (#1408)', () => {
  it('400 on a missing/invalid muscle_group', async () => {
    const { app } = makeApp({ exercises: [{ name: 'Тест2', muscle_group: null }] })
    const res1 = await request(app).patch('/api/workouts/exercises/Тест2/muscle-group').send({})
    const res2 = await request(app).patch('/api/workouts/exercises/Тест2/muscle-group').send({ muscle_group: 'abs' })
    expect(res1.status).toBe(400)
    expect(res2.status).toBe(400)
  })

  it("'other' is a valid, explicit answer — not rejected like an unknown enum value", async () => {
    const { app, exercises } = makeApp({ exercises: [{ name: 'Тест2', muscle_group: null }], workouts: [TEST2_SESSION] })
    const res = await request(app).patch('/api/workouts/exercises/Тест2/muscle-group').send({ muscle_group: 'other' })
    expect(res.status).toBe(200)
    expect(exercises[0].muscle_group).toBe('other')
    expect(res.body.updated_sessions).toBe(1)
  })

  it('404 on an unknown exercise name, does not touch workouts', async () => {
    const { app, workouts } = makeApp({ exercises: [], workouts: [TEST2_SESSION] })
    const res = await request(app)
      .patch('/api/workouts/exercises/Неіснуюча/muscle-group')
      .send({ muscle_group: 'back' })
    expect(res.status).toBe(404)
    expect(workouts[0]).toEqual(TEST2_SESSION) // untouched
  })

  it('writes muscle_group on the library entry and clears the exercise from needs_muscle_group_clarification in every session that had it', async () => {
    const { app, exercises, workouts } = makeApp({
      exercises: [{ name: 'Тест2', muscle_group: null }],
      workouts: [TEST2_SESSION],
    })

    const res = await request(app).patch('/api/workouts/exercises/Тест2/muscle-group').send({ muscle_group: 'back' })

    expect(res.status).toBe(200)
    expect(res.body.exercise.muscle_group).toBe('back')
    expect(res.body.updated_sessions).toBe(1)
    expect(exercises[0].muscle_group).toBe('back')
    expect(workouts[0].needs_muscle_group_clarification).toEqual([]) // resolved, no longer flagged
  })

  it('a session that never had this exercise flagged is left byte-for-byte untouched (updated_sessions stays 0 for it)', async () => {
    const session = {
      _id: 'wk_2',
      exercises: [{ name: 'Тест2', sets: [] }],
      needs_muscle_group_clarification: [], // already resolved / never flagged
    }
    const { app, workouts } = makeApp({ exercises: [{ name: 'Тест2', muscle_group: 'back' }], workouts: [session] })
    const res = await request(app).patch('/api/workouts/exercises/Тест2/muscle-group').send({ muscle_group: 'back' })
    expect(res.status).toBe(200)
    expect(res.body.updated_sessions).toBe(0)
    expect(workouts[0]).toEqual(session)
  })

  it('a session flagging MULTIPLE exercises only clears the one being patched, leaves the sibling flagged', async () => {
    const session = {
      _id: 'wk_3',
      exercises: [
        { name: 'Тест2', sets: [] },
        { name: 'Розводка в тренажері', sets: [] },
      ],
      needs_muscle_group_clarification: ['Тест2', 'Розводка в тренажері'],
    }
    const { app, workouts } = makeApp({
      exercises: [{ name: 'Тест2', muscle_group: null }, { name: 'Розводка в тренажері', muscle_group: null }],
      workouts: [session],
    })
    const res = await request(app).patch('/api/workouts/exercises/Тест2/muscle-group').send({ muscle_group: 'core' })
    expect(res.status).toBe(200)
    expect(workouts[0].needs_muscle_group_clarification).toEqual(['Розводка в тренажері']) // sibling still flagged
  })
})

export {}
