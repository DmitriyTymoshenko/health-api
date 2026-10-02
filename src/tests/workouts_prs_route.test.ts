/** GET /api/workouts/prs (#1692 п.6) — route wiring over calculatePRs. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

const workouts = [
  { date: '2026-09-01', exercises: [{ name: 'Жим', muscle_group: 'chest', sets: [{ weight_kg: 50, reps: 10 }] }] },
  { date: '2026-09-08', exercises: [
    { name: 'Жим', muscle_group: 'chest', sets: [{ weight_kg: 60, reps: 5 }] },
    { name: 'Тяга', sets: [{ weight_kg: 40, reps: 8 }] },
  ] },
]

function makeApp() {
  const db = {
    collection: () => ({
      find: (filter: any) => {
        const n = filter['exercises.name']
        const m = n ? workouts.filter(w => w.exercises.some(e => e.name === n)) : workouts
        return { sort() { return this }, toArray: async () => m }
      },
    }),
  }
  const app = express()
  app.use('/api/workouts', workoutsRoute(() => db))
  return app
}

describe('GET /api/workouts/prs', () => {
  it('returns PRs for all exercises (200, not 404), no history payload', async () => {
    const res = await request(makeApp()).get('/api/workouts/prs')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    const press = res.body.prs.find((p: any) => p.exercise === 'Жим')
    expect(press.max_weight).toMatchObject({ value: 60, date: '2026-09-08' })
    expect(press.total_sessions).toBe(2)
    expect(press.history).toBeUndefined()
  })
  it('filters by ?exercise=', async () => {
    const res = await request(makeApp()).get('/api/workouts/prs').query({ exercise: 'Тяга' })
    expect(res.body.count).toBe(1)
    expect(res.body.prs[0].exercise).toBe('Тяга')
  })
})
