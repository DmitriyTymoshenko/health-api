/**
 * #1601 (SPEC #1518 §17 S1) — «Сьогодні»: focus ≤3 + one-tap confirm,
 * calendar snapshot (+server-computed free windows), extended GET /today with
 * state/calendar/food blocks that are each independently null+reason.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeHabitsRoute = require('../../routes/life_habits')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeDayGoalsRoute = require('../../routes/life_day_goals')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeCalendarRoute = require('../../routes/life_calendar')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lt = require('../../lib/life-today')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'

const DAY = '2026-10-02'
const READINESS = { date: DAY, level: 'base_only', recovery_score: 55, recovery_zone: 'moderate', yellow_red_streak_days: 3, data_fresh: true }
const WHOOP = { no_data: false, sleep_hours: 7.1, strain: 5.3545, last_synced: '2026-10-02T16:23:14.301Z' }
const NUTRITION = { items: 19, kcal: 1860, kcal_goal: 2420, protein_g: 162.7, protein_goal_g: 184 }
const okSources = {
  readiness: async () => READINESS,
  whoop: async () => WHOOP,
  nutrition: async () => NUTRITION,
}

function makeApp(seed: { goals?: any[]; snaps?: any[] } = {}, sources: any = okSources) {
  const cols: Record<string, any> = {
    life_day_goals: makeMockCollection(seed.goals || []),
    life_calendar_snapshots: makeMockCollection(seed.snaps || []),
    life_habits: makeMockCollection([]),
    life_habit_rules: makeMockCollection([]),
    life_rule_checks: makeMockCollection([]),
  }
  const db = { collection: (n: string) => { if (!cols[n]) throw new Error('unexpected ' + n); return cols[n] } }
  const app = express()
  app.use(express.json())
  app.use('/api/life', lifeDayGoalsRoute(() => db))
  app.use('/api/life', lifeCalendarRoute(() => db))
  app.use('/api/life', lifeHabitsRoute(() => db, sources))
  return { app, cols }
}

describe('focus ≤3 + confirm-focus', () => {
  it('allows 3 focus goals and rejects the 4th with 400', async () => {
    const { app } = makeApp()
    for (let i = 1; i <= 3; i++) {
      const r = await request(app).post('/api/life/day-goals').send({ text: `f${i}`, day: DAY, focus: true, proposed_by: 'lisa', source: 'lisa' })
      expect(r.status).toBe(201)
      expect(r.body.focus_rank).toBe(i)
      expect(r.body.confirmed_at).toBeNull()
      assertMatchesContract('DayGoal', JSON.parse(JSON.stringify(r.body)))
    }
    const r4 = await request(app).post('/api/life/day-goals').send({ text: 'f4', day: DAY, focus: true })
    expect(r4.status).toBe(400)
    // a non-focus goal is still fine
    expect((await request(app).post('/api/life/day-goals').send({ text: 'plain', day: DAY })).status).toBe(201)
  })

  it('confirm-focus confirms all proposed in one call; idempotent', async () => {
    const { app } = makeApp()
    for (let i = 1; i <= 2; i++) await request(app).post('/api/life/day-goals').send({ text: `f${i}`, day: DAY, focus: true, proposed_by: 'lisa' })
    const c1 = await request(app).post('/api/life/day-goals/confirm-focus').send({ day: DAY })
    expect(c1.status).toBe(200)
    expect(c1.body).toEqual({ day: DAY, confirmed: 2, focus_total: 2 })
    assertMatchesContract('ConfirmFocusResponse', c1.body)
    const c2 = await request(app).post('/api/life/day-goals/confirm-focus').send({ day: DAY })
    expect(c2.body.confirmed).toBe(0)
    const today = await request(app).get(`/api/life/today?day=${DAY}`)
    expect(today.body.focus.every((g: any) => g.confirmed_at)).toBe(true)
  })

  it('rejects bad focus_rank / proposed_by / day', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/life/day-goals').send({ text: 'x', focus: true, focus_rank: 4 })).status).toBe(400)
    expect((await request(app).post('/api/life/day-goals').send({ text: 'x', proposed_by: 'bob' })).status).toBe(400)
    expect((await request(app).post('/api/life/day-goals/confirm-focus').send({ day: 'bad' })).status).toBe(400)
  })

  it('request bodies satisfy the *Request contracts', () => {
    assertMatchesContract('DayGoalCreateRequest', { text: 'x', day: DAY, focus: true, proposed_by: 'lisa' })
    assertMatchesContract('ConfirmFocusRequest', { day: DAY })
    expect(() => assertMatchesContract('DayGoalCreateRequest', { text: 'x', bogus: 1 })).toThrow()
  })
})

describe('calendar snapshot', () => {
  const ev = (s: string, e: string, title = 't', all_day = false) => ({ start: s, end: e, title, all_day })

  it('computes free windows ≥90 min within 08:00–21:00 Kyiv (UTC+3 on 02.10)', () => {
    // busy 10:00–11:00 Kyiv (07:00–08:00Z) and 14:00–19:30 Kyiv (11:00–16:30Z)
    const w = lt.computeFreeWindows([ev('2026-10-02T07:00:00Z', '2026-10-02T08:00:00Z'), ev('2026-10-02T11:00:00Z', '2026-10-02T16:30:00Z')], DAY)
    // free: 08:00–10:00 (120), 11:00–14:00 (180); 19:30–21:00 = 90 → included
    expect(w.map((x: any) => x.minutes)).toEqual([120, 180, 90])
    expect(w[0].start).toBe('2026-10-02T05:00:00.000Z')
  })

  it('all-day events do not block; overlapping events merge', () => {
    const w = lt.computeFreeWindows([ev('2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', 'holiday', true), ev('2026-10-02T06:00:00Z', '2026-10-02T09:00:00Z'), ev('2026-10-02T07:00:00Z', '2026-10-02T10:00:00Z')], DAY)
    // merged busy 09:00–13:00 Kyiv → 08–09 (60 min, dropped) + 13:00–21:00 (480)
    expect(w.map((x: any) => x.minutes)).toEqual([480])
  })

  it('PUT upserts one doc per day and validates input', async () => {
    const { app, cols } = makeApp()
    const body = { day: DAY, events: [ev('2026-10-02T07:00:00Z', '2026-10-02T08:00:00Z', 'Дзвінок')] }
    assertMatchesContract('CalendarSnapshotRequest', body)
    const r1 = await request(app).put('/api/life/calendar-snapshot').send(body)
    expect(r1.status).toBe(200)
    assertMatchesContract('CalendarSnapshot', JSON.parse(JSON.stringify(r1.body)))
    await request(app).put('/api/life/calendar-snapshot').send({ day: DAY, events: [] })
    expect(cols.life_calendar_snapshots._docs()).toHaveLength(1)
    expect((await request(app).put('/api/life/calendar-snapshot').send({ events: 'x' })).status).toBe(400)
    expect((await request(app).put('/api/life/calendar-snapshot').send({ events: [{ title: 1, start: 'x', end: 'y' }] })).status).toBe(400)
    expect((await request(app).put('/api/life/calendar-snapshot').send({ events: [], attendees: [] })).status).toBe(400)
    const tooMany = Array.from({ length: 21 }, () => ev('2026-10-02T07:00:00Z', '2026-10-02T08:00:00Z'))
    expect((await request(app).put('/api/life/calendar-snapshot').send({ events: tooMany })).status).toBe(400)
  })
})

describe('GET /today blocks', () => {
  it('all sources OK → full payload matches TodayResponse contract', async () => {
    const { app } = makeApp()
    await request(app).put('/api/life/calendar-snapshot').send({ day: DAY, events: [{ start: '2099-10-02T07:00:00Z', end: '2099-10-02T08:00:00Z', title: 'A', all_day: false }] })
    const res = await request(app).get(`/api/life/today?day=${DAY}`)
    expect(res.status).toBe(200)
    assertMatchesContract('TodayResponse', JSON.parse(JSON.stringify(res.body)))
    expect(res.body.state).toMatchObject({ recovery_score: 55, recovery_zone: 'moderate', sleep_h: 7.1 })
    expect(res.body.state.advice).toBe(lt.ADVICE_TABLE.moderate_streak)
    expect(res.body.food).toMatchObject({ kcal: 1860, kcal_left: 560, protein_left: 21.3 })
    expect(res.body.calendar.fetched_at).toBeTruthy()
  })

  it('each block degrades independently to null + reason', async () => {
    const boom = async () => { throw new Error('down') }
    for (const [key, srcs, block, reasonKey] of [
      ['readiness', { ...okSources, readiness: boom }, 'state', 'state_reason'],
      ['nutrition', { ...okSources, nutrition: boom }, 'food', 'food_reason'],
    ] as any) {
      const { app } = makeApp({}, srcs)
      const res = await request(app).get(`/api/life/today?day=${DAY}`)
      expect(res.status).toBe(200)
      expect(res.body[block]).toBeNull()
      expect(res.body[reasonKey]).toBeTruthy()
      for (const other of ['state', 'food'].filter((b) => b !== block)) expect(res.body[other]).not.toBeNull()
      assertMatchesContract('TodayResponse', JSON.parse(JSON.stringify(res.body)))
      void key
    }
  })

  it('no snapshot → calendar null with «Календар не синхронізовано» (not "no events")', async () => {
    const { app } = makeApp()
    const res = await request(app).get(`/api/life/today?day=${DAY}`)
    expect(res.body.calendar).toBeNull()
    expect(res.body.calendar_reason).toBe('Календар не синхронізовано')
  })

  it('empty food log → null + reason, never kcal 0; stale recovery → state null', async () => {
    const { app } = makeApp({}, { ...okSources, nutrition: async () => ({ items: 0, kcal: 0 }), readiness: async () => ({ data_fresh: false, recovery_score: null }) })
    const res = await request(app).get(`/api/life/today?day=${DAY}`)
    expect(res.body.food).toBeNull()
    expect(res.body.state).toBeNull()
  })
})

describe('advice table (deterministic, SPEC §15)', () => {
  it('maps zone/streak to fixed phrases', () => {
    expect(lt.buildAdvice('light', 0)).toBe(lt.ADVICE_TABLE.light)
    expect(lt.buildAdvice('moderate', 1)).toBe(lt.ADVICE_TABLE.moderate)
    expect(lt.buildAdvice('moderate', 2)).toBe(lt.ADVICE_TABLE.moderate_streak)
    expect(lt.buildAdvice('hard', 0)).toBe(lt.ADVICE_TABLE.hard)
    expect(lt.buildAdvice('x', 0)).toBeNull()
  })
})

describe('food source uses the Kyiv day, never /summary/today (00:30 Kyiv instant)', () => {
  afterEach(() => jest.useRealTimers())
  it('requests /api/nutrition/summary?date=<Kyiv day> at 2026-10-01T21:30Z (= 00:30 on 02.10 Kyiv)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-01T21:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
    const urls: string[] = []
    const fetchImpl = async (u: string) => { urls.push(u); return { ok: true, json: async () => NUTRITION } }
    const srcs = lt.makeHttpSources('http://x', fetchImpl)
    const { app } = makeApp({}, srcs)
    const res = await request(app).get('/api/life/today')
    expect(res.body.day).toBe('2026-10-02')
    const food = urls.find((u) => u.includes('/nutrition/')) as string
    expect(food).toBe('http://x/api/nutrition/summary?date=2026-10-02')
    expect(urls.some((u) => u.includes('summary/today'))).toBe(false)
  })
})
