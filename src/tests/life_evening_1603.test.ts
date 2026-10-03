/**
 * #1603 (SPEC v2 §11.2, §12, §17) — evening review + day rating.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeEveningRoute = require('../../routes/life_evening')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'

const DAY = '2026-10-07'

function makeApp(seed: Record<string, any[]> = {}) {
  const names = ['life_habits', 'life_habit_rules', 'life_rule_checks', 'life_day_goals', 'life_day_ratings']
  const collections: Record<string, ReturnType<typeof makeMockCollection>> = {}
  for (const n of names) collections[n] = makeMockCollection(seed[n] || [])
  const db = { collection(name: string) { if (!collections[name]) throw new Error(`unexpected collection: ${name}`); return collections[name] } }
  const app = express()
  app.use(express.json())
  app.use('/api/life', lifeEveningRoute(() => db))
  return { app, collections }
}

describe('day rating route', () => {
  it('partial rating keeps missing axes null, never 0', async () => {
    const { app } = makeApp()
    const res = await request(app).put('/api/life/day-rating').send({ day: DAY, energy: 4, went_well: 'Закрив важливе' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ day: DAY, energy: 4, focus: null, mood: null, went_well: 'Закрив важливе', got_in_way: null, source: 'lisa' })
    assertMatchesContract('DayRatingResponse', res.body)
  })

  it('rejects 0 and bad day format', async () => {
    const { app } = makeApp()
    expect((await request(app).put('/api/life/day-rating').send({ day: DAY, energy: 0 })).status).toBe(400)
    expect((await request(app).get('/api/life/day-rating?day=07-10-2026')).status).toBe(400)
  })
})

describe('evening route', () => {
  it('returns open rules, open goals, dont-miss-twice risks and rating_present', async () => {
    const h1 = new ObjectId(), h2 = new ObjectId(), r1 = new ObjectId(), r2 = new ObjectId()
    const { app } = makeApp({
      life_habits: [
        { _id: h1, type: 'build', name: 'Читання', frequency: { kind: 'daily' }, active: true, created_at: new Date('2026-10-05T09:00:00Z'), archived_at: null },
        { _id: h2, type: 'break', name: 'Солодке', frequency: { kind: 'daily' }, active: true, created_at: new Date('2026-10-05T09:00:00Z'), archived_at: null },
      ],
      life_habit_rules: [
        { _id: r1, habit_id: h1, text: '1 сторінка', order: 1, active: true },
        { _id: r2, habit_id: h2, text: 'Без солодкого ввечері', order: 1, active: true },
      ],
      life_rule_checks: [
        { rule_id: r1, habit_id: h1, day: '2026-10-05', done: true },
        { rule_id: r1, habit_id: h1, day: '2026-10-06', done: false },
        { rule_id: r2, habit_id: h2, day: DAY, done: false },
      ],
      life_day_goals: [
        { _id: new ObjectId(), day: DAY, text: 'Закрити задачу', done: false, created_at: new Date(), source: 'lisa' },
        { _id: new ObjectId(), day: DAY, text: 'Готове', done: true, created_at: new Date(), source: 'lisa' },
      ],
      life_day_ratings: [{ day: DAY, energy: 5, focus: null, mood: null, went_well: null, got_in_way: null, source: 'lisa', rated_at: new Date() }],
    })
    const res = await request(app).get('/api/life/evening?day=' + DAY)
    expect(res.status).toBe(200)
    expect(res.body.open_rules.map((r: any) => r.rule_text).sort()).toEqual(['1 сторінка', 'Без солодкого ввечері'])
    expect(res.body.open_goals.map((g: any) => g.text)).toEqual(['Закрити задачу'])
    expect(res.body.dont_miss_twice.map((r: any) => r.habit_name)).toEqual(['Читання'])
    expect(res.body.rating_present).toBe(true)
    assertMatchesContract('EveningResponse', res.body)
  })

  it('empty evening means Lisa should skip sending the review message', async () => {
    const h = new ObjectId(), r = new ObjectId()
    const { app } = makeApp({
      life_habits: [{ _id: h, type: 'build', name: 'Читання', frequency: { kind: 'daily' }, active: true, created_at: new Date('2026-10-05T09:00:00Z'), archived_at: null }],
      life_habit_rules: [{ _id: r, habit_id: h, text: '1 сторінка', order: 1, active: true }],
      life_rule_checks: [{ rule_id: r, habit_id: h, day: DAY, done: true }, { rule_id: r, habit_id: h, day: '2026-10-06', done: true }],
      life_day_ratings: [{ day: DAY, energy: 4, focus: 4, mood: 5, went_well: 'ok', got_in_way: null, source: 'lisa', rated_at: new Date() }],
    })
    const res = await request(app).get('/api/life/evening?day=' + DAY)
    expect(res.status).toBe(200)
    expect(res.body.open_rules).toEqual([])
    expect(res.body.open_goals).toEqual([])
    expect(res.body.dont_miss_twice).toEqual([])
    expect(res.body.rating_present).toBe(true)
  })
})
