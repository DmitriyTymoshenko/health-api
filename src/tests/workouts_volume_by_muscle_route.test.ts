// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

function chain(data: Array<Record<string, unknown>>) {
  return {
    sort() { return this },
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
          find(filter: { date?: { $gte: string; $lte: string } }) {
            const from = filter.date?.$gte
            const to = filter.date?.$lte
            return chain(workouts.filter((w: any) => !from || !to || (w.date >= from && w.date <= to)))
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

describe('GET /api/workouts/volume-by-muscle', () => {
  it('returns current week volume plus previous week comparison', async () => {
    const app = makeApp({
      exercises: [
        { name: 'Жим гантелей лежачи', muscle_group: 'chest' },
        { name: 'Тяга верхнього блоку', muscle_group: 'back' },
      ],
      workouts: [
        { date: '2026-09-17', exercises: [
          { name: 'Жим гантелей лежачи', sets: [{ weight_kg: 30, reps: 8 }, { weight_kg: 30, reps: 8 }, { weight_kg: 30, reps: 8 }] },
        ] },
        { date: '2026-09-10', exercises: [
          { name: 'Тяга верхнього блоку', sets: [{ weight_kg: 50, reps: 10 }] },
        ] },
      ],
    })

    const res = await request(app).get('/api/workouts/volume-by-muscle').query({ period: 'week', date: '2026-09-17' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      period: 'week',
      from: '2026-09-14',
      to: '2026-09-20',
      total_kg: 720,
      workouts_count: 1,
      groups: [{ muscle_group: 'chest', volume_kg: 720, sets: 3, exercises_count: 1 }],
      prev: {
        from: '2026-09-07',
        to: '2026-09-13',
        total_kg: 500,
        workouts_count: 1,
        groups: [{ muscle_group: 'back', volume_kg: 500, sets: 1, exercises_count: 1 }],
      },
    })
  })

  it('returns empty month as 200 with groups:[]', async () => {
    const app = makeApp({ workouts: [], exercises: [] })
    const res = await request(app).get('/api/workouts/volume-by-muscle').query({ period: 'month', date: '2026-09-17' })
    expect(res.status).toBe(200)
    expect(res.body.total_kg).toBe(0)
    expect(res.body.groups).toEqual([])
    expect(res.body.prev.groups).toEqual([])
  })

  it('400 on invalid period/date', async () => {
    const app = makeApp({})
    expect((await request(app).get('/api/workouts/volume-by-muscle').query({ period: 'day', date: '2026-09-17' })).status).toBe(400)
    expect((await request(app).get('/api/workouts/volume-by-muscle').query({ period: 'week', date: 'bad' })).status).toBe(400)
  })
})

export {}
