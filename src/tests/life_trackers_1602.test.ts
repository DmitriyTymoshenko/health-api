/**
 * #1602 (SPEC v2 §11.4, §12, §17) — tracker-habits, frequencies, stats,
 * don't-miss-twice, nudges. Pure-logic table tests + real route (routes/life_habits.js)
 * over the shared in-memory mock, validated against the SINGLE contract file.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeHabitsRoute = require('../../routes/life_habits')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../../lib/life-trackers')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'

// 2026-10-07 is a Wednesday (ISO 3); Monday of that week = 2026-10-05.
const TODAY = '2026-10-07'

describe('validators', () => {
  it('frequency: default daily, weekdays sorted/deduped, weekly_n bounded, junk rejected', () => {
    expect(T.validateFrequency(undefined).value).toEqual({ kind: 'daily' })
    expect(T.validateFrequency({ kind: 'weekdays', days: [5, 1, 1] }).value).toEqual({ kind: 'weekdays', days: [1, 5] })
    expect(T.validateFrequency({ kind: 'weekly_n', n: 3 }).value).toEqual({ kind: 'weekly_n', n: 3 })
    for (const bad of [{ kind: 'weekly_n', n: 0 }, { kind: 'weekly_n', n: 8 }, { kind: 'weekdays', days: [] }, { kind: 'weekdays', days: [0] }, { kind: 'monthly' }]) {
      expect(T.validateFrequency(bad).error).toBeTruthy()
    }
  })
  it('tracker: water/steps need a threshold; break habits cannot be trackers', () => {
    expect(T.validateTracker({ source: 'water' }, { type: 'build' }).error).toMatch(/threshold/)
    expect(T.validateTracker({ source: 'water', threshold: 2000 }, { type: 'build' }).value).toEqual({ source: 'water', threshold: 2000 })
    expect(T.validateTracker({ source: 'weight' }, { type: 'build' }).value).toEqual({ source: 'weight', threshold: null })
    expect(T.validateTracker({ source: 'sleep' }, { type: 'build' }).error).toBeTruthy()
    expect(T.validateTracker({ source: 'weight' }, { type: 'break' }).error).toBeTruthy()
  })
  it('triggers: HH:MM, ISO weekday, stale_metric bounds', () => {
    expect(T.validateTriggers([{ kind: 'weekday_time', weekday: 1, time: '09:00' }]).value).toHaveLength(1)
    expect(T.validateTriggers([{ kind: 'time', time: '25:00' }]).error).toBeTruthy()
    expect(T.validateTriggers([{ kind: 'weekday_time', weekday: 8, time: '09:00' }]).error).toBeTruthy()
    expect(T.validateTriggers([{ kind: 'stale_metric', metric: 'weight', max_age_days: 0 }]).error).toBeTruthy()
    expect(T.validateTriggers([{ kind: 'stale_metric', metric: 'mood', max_age_days: 7 }]).error).toBeTruthy()
  })
})

describe('trackerStatesByDay — derived day state', () => {
  it('water sums ml vs threshold', () => {
    const m = T.trackerStatesByDay({ source: 'water', threshold: 2000 }, [
      { date: '2026-10-06', amount_ml: 1500 }, { date: '2026-10-06', amount_ml: 600 }, { date: '2026-10-07', amount_ml: 300 },
    ])
    expect(m.get('2026-10-06')).toEqual({ value: 2100, met: true })
    expect(m.get('2026-10-07')).toEqual({ value: 300, met: false })
    expect(m.has('2026-10-05')).toBe(false) // no data stays absent, never 0
  })
  it('supplements: all taken (default) or >= threshold', () => {
    const docs = [{ date: 'd', taken: true }, { date: 'd', taken: false }]
    expect(T.trackerStatesByDay({ source: 'supplements', threshold: null }, docs).get('d').met).toBe(false)
    expect(T.trackerStatesByDay({ source: 'supplements', threshold: 1 }, docs).get('d').met).toBe(true)
    expect(T.trackerStatesByDay({ source: 'supplements', threshold: null }, [{ date: 'd', taken: true }]).get('d').met).toBe(true)
  })
  it('weight: any weigh-in meets; steps: >= threshold', () => {
    expect(T.trackerStatesByDay({ source: 'weight', threshold: null }, [{ date: 'd', weight_kg: 95.2 }]).get('d')).toEqual({ value: 95.2, met: true })
    expect(T.trackerStatesByDay({ source: 'steps', threshold: 8000 }, [{ date: 'd', steps: 7999 }]).get('d').met).toBe(false)
    expect(T.trackerStatesByDay({ source: 'steps', threshold: 8000 }, [{ date: 'd', steps: 8000 }]).get('d').met).toBe(true)
  })
})

describe('dontMissTwice — table (absence TODAY is not a miss)', () => {
  const cases: Array<[string, boolean[], any, string]> = [
    ['no history', [], { scheduled: true, done: false }, 'n/a'],
    ['not scheduled today', [false], { scheduled: false, done: false }, 'n/a'],
    ['last done, today pending', [true], { scheduled: true, done: false }, 'ok'],
    ['one miss yesterday, today pending', [true, false], { scheduled: true, done: false }, 'at_risk'],
    ['one miss yesterday, today done', [true, false], { scheduled: true, done: true }, 'ok'],
    ['two misses, today pending', [true, false, false], { scheduled: true, done: false }, 'broken'],
    ['two misses, today done (recovered)', [false, false], { scheduled: true, done: true }, 'ok'],
    ['single history day missed, today pending', [false], { scheduled: true, done: false }, 'at_risk'],
    ['old miss then done then done', [false, true, true], { scheduled: true, done: false }, 'ok'],
  ]
  it.each(cases)('%s -> %s', (_n, past, cur, want) => {
    expect(T.dontMissTwice(past, cur)).toBe(want)
  })
  it('today without a check-in is NOT folded into past (daily)', () => {
    const r = T.evaluatePeriods({ kind: 'daily' }, '2026-10-05', TODAY, { '2026-10-05': true, '2026-10-06': true })
    expect(r.past).toEqual([true, true])
    expect(r.current).toEqual({ scheduled: true, done: false })
  })
})

describe('evaluatePeriods — weekdays / weekly_n', () => {
  it('weekdays only schedules the chosen ISO days', () => {
    const r = T.evaluatePeriods({ kind: 'weekdays', days: [1, 3] }, '2026-10-05', TODAY, { '2026-10-05': true })
    expect(r.past).toEqual([true]) // Mon done; Tue/Thu/... not scheduled
    expect(r.current).toEqual({ scheduled: true, done: false }) // Wed
  })
  it('weekly_n: week met at >= n; first partial week is not charged; current week never a miss', () => {
    // created Wed 2026-09-23 -> first full week starts Mon 2026-09-28
    const done: Record<string, boolean> = { '2026-09-28': true, '2026-09-30': true, '2026-10-02': true } // week1: 3
    done['2026-10-05'] = true // current week: 1 so far
    const r = T.evaluatePeriods({ kind: 'weekly_n', n: 3 }, '2026-09-23', TODAY, done)
    expect(r.past).toEqual([true])
    expect(r.current.done).toBe(false)
    expect(r.current.count).toBe(1)
    done['2026-10-06'] = true; done[TODAY] = true
    expect(T.evaluatePeriods({ kind: 'weekly_n', n: 3 }, '2026-09-23', TODAY, done).current.done).toBe(true)
  })
})

describe('computeStats', () => {
  it('streak, best streak, pct, votes (daily)', () => {
    const done: Record<string, boolean> = {
      '2026-10-01': true, '2026-10-02': true, '2026-10-03': false, '2026-10-04': true, '2026-10-05': true, '2026-10-06': true,
    }
    const s = T.computeStats({ habit: { type: 'build', identity: 'Я людина, яка рухається', frequency: { kind: 'daily' }, created_day: '2026-10-01' }, today: TODAY, doneByDay: done })
    expect(s.streak).toBe(3)
    expect(s.best_streak).toBe(3)
    expect(s.identity_votes).toBe(5)
    expect(s.done_in_window).toBe(5)
    expect(s.periods_in_window).toBe(6) // Oct 1..6; today pending is not counted
    expect(s.pct).toBe(83)
    expect(s.dont_miss_twice).toBe('ok')
    expect(s.clean_days).toBeNull()
  })
  it('today done extends the streak and counts as a vote', () => {
    const s = T.computeStats({ habit: { type: 'build', frequency: { kind: 'daily' }, created_day: '2026-10-05' }, today: TODAY, doneByDay: { '2026-10-05': true, '2026-10-06': true, [TODAY]: true } })
    expect(s.streak).toBe(3)
    expect(s.identity_votes).toBe(3)
  })
})

describe('dueNudgesForHabit', () => {
  const habit = { _id: 'h1', name: 'Зважування', triggers: [{ kind: 'weekday_time', weekday: 1, time: '09:00' }, { kind: 'stale_metric', metric: 'weight', max_age_days: 7 }] }
  const base = { habit, doneToday: false, scheduledToday: true, acked: new Set<string>(), latestDates: { weight: '2026-09-30' } }
  it('weekday_time fires only on that weekday and after the time', () => {
    const mon = (hhmm: string) => T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-10-04' }, now: { day: '2026-10-05', hhmm, weekday: 1 } })
    expect(mon('08:59')).toHaveLength(0)
    expect(mon('09:00').map((n: any) => n.kind)).toEqual(['weekday_time'])
    expect(T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-10-04' }, now: { day: TODAY, hhmm: '12:00', weekday: 3 } })).toHaveLength(0)
  })
  it('stale_metric: age > limit (or no data) fires; age <= limit does not; ack suppresses', () => {
    const now = { day: TODAY, hhmm: '10:00', weekday: 3 }
    const due = T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-09-28' }, now })
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ kind: 'stale_metric', metric: 'weight', age_days: 9 })
  })
  it('stale_metric boundary: exactly max_age_days is NOT stale; +1 is', () => {
    const now = { day: TODAY, hhmm: '10:00', weekday: 3 }
    expect(T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-09-30' }, now })).toHaveLength(0) // exactly 7 days -> not stale
    expect(T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-09-29' }, now })).toHaveLength(1)
    expect(T.dueNudgesForHabit({ ...base, latestDates: { weight: null }, now })[0].age_days).toBeNull()
    const key = T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-09-29' }, now })[0].key
    expect(T.dueNudgesForHabit({ ...base, latestDates: { weight: '2026-09-29' }, now, acked: new Set([`h1|${key}`]) })).toHaveLength(0)
  })
  it('time triggers never fire once the habit is done today', () => {
    const h = { _id: 'h2', name: 'Вода', triggers: [{ kind: 'time', time: '18:00' }] }
    const now = { day: TODAY, hhmm: '19:00', weekday: 3 }
    expect(T.dueNudgesForHabit({ habit: h, now, doneToday: false, scheduledToday: true, latestDates: {}, acked: new Set() })).toHaveLength(1)
    expect(T.dueNudgesForHabit({ habit: h, now, doneToday: true, scheduledToday: true, latestDates: {}, acked: new Set() })).toHaveLength(0)
  })
})

// ---- route-level ------------------------------------------------------------

function makeApp(seed: Record<string, any[]> = {}) {
  const names = ['life_habits', 'life_habit_rules', 'life_rule_checks', 'life_day_goals', 'life_nudges', 'water_log', 'supplements_log', 'weight_log', 'steps_log']
  const collections: Record<string, ReturnType<typeof makeMockCollection>> = {}
  for (const n of names) collections[n] = makeMockCollection(seed[n] || [])
  const db = { collection(name: string) { if (!collections[name]) throw new Error(`unexpected collection: ${name}`); return collections[name] } }
  const app = express()
  app.use(express.json())
  app.use('/api/life', lifeHabitsRoute(() => db))
  return { app, collections }
}

describe('tracker habits over the real route', () => {
  it('creating a tracker habit writes ZERO life_rule_checks and zero rules (S2)', async () => {
    const { app, collections } = makeApp()
    const res = await request(app).post('/api/life/habits').send({
      type: 'build', name: 'Вода 2 л', tracker: { source: 'water', threshold: 2000 }, frequency: { kind: 'daily' },
      triggers: [{ kind: 'time', time: '18:00' }],
    })
    expect(res.status).toBe(201)
    expect(res.body.tracker).toEqual({ source: 'water', threshold: 2000 })
    expect(collections.life_rule_checks._docs()).toHaveLength(0)
    expect(collections.life_habit_rules._docs()).toHaveLength(0)
    // and reading it back (today + list) never creates any either
    await request(app).get('/api/life/today?day=' + TODAY)
    await request(app).get(`/api/life/habits/${res.body._id}/stats?day=${TODAY}`)
    expect(collections.life_rule_checks._docs()).toHaveLength(0)
  })

  it('400 on bad tracker / rules on a tracker habit / break tracker', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/life/habits').send({ type: 'build', name: 'x', tracker: { source: 'water' } })).status).toBe(400)
    expect((await request(app).post('/api/life/habits').send({ type: 'build', name: 'x', tracker: { source: 'weight' }, rules: [{ text: 'a' }] })).status).toBe(400)
    expect((await request(app).post('/api/life/habits').send({ type: 'break', name: 'x', tracker: { source: 'weight' } })).status).toBe(400)
  })

  it('POST rule on a tracker habit is 400', async () => {
    const { app } = makeApp()
    const h = await request(app).post('/api/life/habits').send({ type: 'build', name: 'Кроки', tracker: { source: 'steps', threshold: 8000 } })
    expect((await request(app).post(`/api/life/habits/${h.body._id}/rules`).send({ text: 'x' })).status).toBe(400)
  })

  it('/today derives tracker state from water_log and matches the contract', async () => {
    const hid = new ObjectId()
    const { app } = makeApp({
      life_habits: [{ _id: hid, type: 'build', name: 'Вода', sphere: null, identity: null, implementation: null, two_minute: null, frequency: { kind: 'daily' }, tracker: { source: 'water', threshold: 2000 }, triggers: [], active: true, created_at: new Date('2026-10-01T09:00:00Z'), archived_at: null }],
      water_log: [{ date: TODAY, amount_ml: 1200 }, { date: TODAY, amount_ml: 900 }],
    })
    const res = await request(app).get('/api/life/today?day=' + TODAY)
    expect(res.status).toBe(200)
    const h = res.body.habits[0]
    expect(h.tracker_state).toEqual({ value: 2100, threshold: 2000, met: true })
    expect(h.done_today).toBe(true)
    assertMatchesContract('TodayHabit', JSON.parse(JSON.stringify(h)))
  })

  it('/today: below threshold is neutral (null), no data is null — never false', async () => {
    const { app } = makeApp({
      life_habits: [{ _id: new ObjectId(), type: 'build', name: 'Вода', frequency: { kind: 'daily' }, tracker: { source: 'water', threshold: 2000 }, triggers: [], active: true, created_at: new Date('2026-10-01T09:00:00Z'), archived_at: null }],
      water_log: [{ date: TODAY, amount_ml: 300 }],
    })
    const h = (await request(app).get('/api/life/today?day=' + TODAY)).body.habits[0]
    expect(h.done_today).toBeNull()
    expect(h.tracker_state.met).toBe(false)
  })

  it('stats endpoint: derived streak from steps_log, contract-valid', async () => {
    const hid = new ObjectId()
    const { app } = makeApp({
      life_habits: [{ _id: hid, type: 'build', name: 'Кроки', identity: 'Я рухаюся', frequency: { kind: 'daily' }, tracker: { source: 'steps', threshold: 8000 }, triggers: [], active: true, created_at: new Date('2026-10-03T09:00:00Z'), archived_at: null }],
      steps_log: [
        { date: '2026-10-03', steps: 9000 }, { date: '2026-10-04', steps: 3000 }, { date: '2026-10-05', steps: 8500 }, { date: '2026-10-06', steps: 8100 },
      ],
    })
    const res = await request(app).get(`/api/life/habits/${hid}/stats?day=${TODAY}`)
    expect(res.status).toBe(200)
    assertMatchesContract('HabitStatsResponse', res.body)
    expect(res.body.streak).toBe(2)
    expect(res.body.best_streak).toBe(2)
    expect(res.body.identity_votes).toBe(3)
    expect(res.body.pct).toBe(75) // 3 of 4 completed days
    expect(res.body.dont_miss_twice).toBe('ok')
    expect((await request(app).get(`/api/life/habits/${hid}/stats?days=0`)).status).toBe(400)
    expect((await request(app).get(`/api/life/habits/${new ObjectId()}/stats`)).status).toBe(404)
  })

  it('stats for a rules-based build habit and a break habit (days clean)', async () => {
    const b = new ObjectId(), br = new ObjectId(), r1 = new ObjectId(), r2 = new ObjectId()
    const { app } = makeApp({
      life_habits: [
        { _id: b, type: 'build', name: 'Читати', frequency: { kind: 'daily' }, triggers: [], active: true, created_at: new Date('2026-10-04T09:00:00Z'), archived_at: null },
        { _id: br, type: 'break', name: 'Соцмережі', frequency: { kind: 'daily' }, triggers: [], active: true, created_at: new Date('2026-10-02T09:00:00Z'), archived_at: null },
      ],
      life_habit_rules: [
        { _id: r1, habit_id: b, text: 'a', order: 1, active: true },
        { _id: r2, habit_id: br, text: 'b', order: 1, active: true },
      ],
      life_rule_checks: [
        { rule_id: r1, habit_id: b, day: '2026-10-04', done: true },
        { rule_id: r1, habit_id: b, day: '2026-10-05', done: false },
        { rule_id: r2, habit_id: br, day: '2026-10-04', done: false, slip_reason: 'стрес' },
      ],
    })
    const sb = (await request(app).get(`/api/life/habits/${b}/stats?day=${TODAY}`)).body
    expect(sb.dont_miss_twice).toBe('broken') // 10-05 missed, 10-06 absent (missed), today pending
    const sbr = (await request(app).get(`/api/life/habits/${br}/stats?day=${TODAY}`)).body
    expect(sbr.clean_days).toBe(3) // failure on 10-04 -> 05,06,07 clean
    assertMatchesContract('HabitStatsResponse', sbr)
  })

  it('rule check stores slip_reason / slip_trigger and keeps them on a re-check without them', async () => {
    const hid = new ObjectId(), rid = new ObjectId()
    const { app, collections } = makeApp({
      life_habits: [{ _id: hid, type: 'break', name: 'x', frequency: { kind: 'daily' }, active: true, created_at: new Date('2026-10-01T09:00:00Z'), archived_at: null }],
      life_habit_rules: [{ _id: rid, habit_id: hid, text: 'r', order: 1, active: true }],
    })
    const r = await request(app).post(`/api/life/rules/${rid}/check`).send({ done: false, source: 'lisa', day: TODAY, slip_reason: 'втома', slip_trigger: 'вечір' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ slip_reason: 'втома', slip_trigger: 'вечір' })
    await request(app).post(`/api/life/rules/${rid}/check`).send({ done: false, source: 'lisa', day: TODAY })
    expect(collections.life_rule_checks._docs()[0].slip_reason).toBe('втома')
  })
})

describe('GET /nudges/due + POST /nudges/ack', () => {
  const hid = new ObjectId()
  const habit = {
    _id: hid, type: 'build', name: 'Зважування', frequency: { kind: 'daily' }, tracker: { source: 'weight', threshold: null },
    triggers: [{ kind: 'weekday_time', weekday: 1, time: '09:00' }, { kind: 'stale_metric', metric: 'weight', max_age_days: 7 }],
    active: true, created_at: new Date('2026-09-01T09:00:00Z'), archived_at: null,
  }
  // Monday 2026-10-05 10:00 Kyiv (UTC+3) = 07:00Z
  const MON_10 = '2026-10-05T07:00:00Z'

  it('Monday morning, weight stale 9 days -> both nudges; contract-valid; deterministic', async () => {
    const { app } = makeApp({ life_habits: [habit], weight_log: [{ date: '2026-09-26', weight_kg: 96 }] })
    const res = await request(app).get('/api/life/nudges/due?at=' + MON_10)
    expect(res.status).toBe(200)
    assertMatchesContract('NudgesDueResponse', res.body)
    expect(res.body.day).toBe('2026-10-05')
    expect(res.body.hhmm).toBe('10:00')
    expect(res.body.nudges.map((n: any) => n.kind).sort()).toEqual(['stale_metric', 'weekday_time'])
    const again = await request(app).get('/api/life/nudges/due?at=' + MON_10)
    expect(again.body).toEqual(res.body)
  })

  it('weighed in this morning -> no weekday_time (habit done) and no stale nudge', async () => {
    const { app } = makeApp({ life_habits: [habit], weight_log: [{ date: '2026-10-05', weight_kg: 95 }] })
    const res = await request(app).get('/api/life/nudges/due?at=' + MON_10)
    expect(res.body.nudges).toEqual([])
  })

  it('before 09:00 only the stale nudge; ack suppresses it', async () => {
    const { app } = makeApp({ life_habits: [habit], weight_log: [{ date: '2026-09-20', weight_kg: 96 }] })
    const early = await request(app).get('/api/life/nudges/due?at=2026-10-05T05:30:00Z') // 08:30 Kyiv
    expect(early.body.nudges.map((n: any) => n.kind)).toEqual(['stale_metric'])
    const ack = await request(app).post('/api/life/nudges/ack').send({ habit_id: String(hid), key: early.body.nudges[0].key })
    expect(ack.status).toBe(200)
    const after = await request(app).get('/api/life/nudges/due?at=2026-10-05T05:30:00Z')
    expect(after.body.nudges).toEqual([])
  })

  it('400 on a bad at; archived habits and habits without triggers are ignored', async () => {
    const { app } = makeApp({ life_habits: [{ ...habit, archived_at: new Date() }] })
    expect((await request(app).get('/api/life/nudges/due?at=nope')).status).toBe(400)
    expect((await request(app).get('/api/life/nudges/due?at=' + MON_10)).body.nudges).toEqual([])
  })
})
