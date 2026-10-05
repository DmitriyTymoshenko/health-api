/**
 * Route-level wiring tests for /api/life/day-goals (#1519, SPEC #1518 §3/§6).
 * add / close / move-to-tomorrow (repeatable, no history) / list-for-a-day.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeDayGoalsRoute = require('../../routes/life_day_goals')
import { makeMockCollection } from './utils/mockLifeMongo'

function makeApp(seed: { dayGoals?: any[] } = {}) {
  const collection = makeMockCollection(seed.dayGoals || [])
  const db = {
    collection(name: string) {
      if (name !== 'life_day_goals') throw new Error(`unexpected collection: ${name}`)
      return collection
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/life', lifeDayGoalsRoute(() => db))
  return { app, collection }
}

describe('POST /api/life/day-goals', () => {
  it('creates a goal for today (Kyiv) when day is omitted', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/life/day-goals').send({ text: 'Закрити #1519' })
    expect(res.status).toBe(201)
    expect(res.body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(res.body.done).toBe(false)
    expect(res.body.done_at).toBeNull()
    expect(res.body.source).toBe('dashboard')
  })

  it('accepts an explicit day and source', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/day-goals')
      .send({ day: '2026-10-05', text: 'x', source: 'lisa' })
    expect(res.status).toBe(201)
    expect(res.body.day).toBe('2026-10-05')
    expect(res.body.source).toBe('lisa')
  })

  it('400 on a malformed day', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/life/day-goals').send({ day: '05-10-2026', text: 'x' })
    expect(res.status).toBe(400)
  })

  it('400 when text is missing', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/life/day-goals').send({ day: '2026-10-05' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/life/day-goals?day=', () => {
  it('lists only goals for the requested day', async () => {
    const { app } = makeApp({
      dayGoals: [
        { _id: new ObjectId(), day: '2026-10-01', text: 'a', done: false, created_at: new Date() },
        { _id: new ObjectId(), day: '2026-10-02', text: 'b', done: false, created_at: new Date() },
      ],
    })
    const res = await request(app).get('/api/life/day-goals').query({ day: '2026-10-01' })
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
    expect(res.body[0].text).toBe('a')
  })
})

describe('PUT /api/life/day-goals/:id', () => {
  it('marking done:true sets done_at; marking done:false clears it', async () => {
    const id = new ObjectId()
    const { app } = makeApp({
      dayGoals: [{ _id: id, day: '2026-10-01', text: 'a', done: false, done_at: null }],
    })
    const done = await request(app).put(`/api/life/day-goals/${id}`).send({ done: true })
    expect(done.status).toBe(200)
    expect(done.body.done).toBe(true)
    expect(done.body.done_at).not.toBeNull()

    const undone = await request(app).put(`/api/life/day-goals/${id}`).send({ done: false })
    expect(undone.body.done).toBe(false)
    expect(undone.body.done_at).toBeNull()
  })

  it('404 for a non-existent id', async () => {
    const { app } = makeApp()
    const res = await request(app).put(`/api/life/day-goals/${new ObjectId()}`).send({ done: true })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/life/day-goals/:id/move — focus cap (#2042)', () => {
  const mk = (day: string, rank: number) => ({ _id: new ObjectId(), day, text: 't', done: false, focus: true, focus_rank: rank, created_at: new Date() })
  it('demotes a focus goal moved onto a day that already has 3 focus goals', async () => {
    const mover = mk('2026-10-04', 1)
    const { app } = makeApp({ dayGoals: [mover, mk('2026-10-05', 1), mk('2026-10-05', 2), mk('2026-10-05', 3)] })
    const res = await request(app).post(`/api/life/day-goals/${mover._id}/move`).send({ to_day: '2026-10-05' })
    expect(res.status).toBe(200)
    expect(res.body.day).toBe('2026-10-05')
    expect(res.body.focus).toBe(false)
    expect(res.body.focus_rank).toBeNull()
  })
  it('keeps focus and gives a free rank when the target day has room', async () => {
    const mover = mk('2026-10-04', 1)
    const { app } = makeApp({ dayGoals: [mover, mk('2026-10-05', 1)] })
    const res = await request(app).post(`/api/life/day-goals/${mover._id}/move`).send({ to_day: '2026-10-05' })
    expect(res.body.focus).toBe(true)
    expect(res.body.focus_rank).toBe(2)
  })
})

describe('POST /api/life/day-goals/:id/move', () => {
  it('defaults to day+1 and mutates the SAME doc (no history)', async () => {
    const id = new ObjectId()
    const { app, collection } = makeApp({
      dayGoals: [{ _id: id, day: '2026-10-01', text: 'a', done: false }],
    })
    const res = await request(app).post(`/api/life/day-goals/${id}/move`).send({})
    expect(res.status).toBe(200)
    expect(res.body.day).toBe('2026-10-02')
    expect(collection._docs().length).toBe(1) // same single doc, no new row
  })

  it('can be moved again (SPEC Q4: allowed repeatedly, no history)', async () => {
    const id = new ObjectId()
    const { app } = makeApp({
      dayGoals: [{ _id: id, day: '2026-10-01', text: 'a', done: false }],
    })
    await request(app).post(`/api/life/day-goals/${id}/move`).send({})
    const second = await request(app).post(`/api/life/day-goals/${id}/move`).send({})
    expect(second.body.day).toBe('2026-10-03')
  })

  it('accepts an explicit to_day', async () => {
    const id = new ObjectId()
    const { app } = makeApp({
      dayGoals: [{ _id: id, day: '2026-10-01', text: 'a', done: false }],
    })
    const res = await request(app).post(`/api/life/day-goals/${id}/move`).send({ to_day: '2026-11-15' })
    expect(res.body.day).toBe('2026-11-15')
  })

  it('month-boundary rollover (2026-09-30 -> 2026-10-01)', async () => {
    const id = new ObjectId()
    const { app } = makeApp({
      dayGoals: [{ _id: id, day: '2026-09-30', text: 'a', done: false }],
    })
    const res = await request(app).post(`/api/life/day-goals/${id}/move`).send({})
    expect(res.body.day).toBe('2026-10-01')
  })
})

export {}
