/**
 * Route-level wiring tests for /api/life/habits, /api/life/habits/:id/rules,
 * /api/life/rules/:id, /api/life/rules/:id/check, /api/life/today (#1519,
 * SPEC #1518). Mounts the REAL route factory (routes/life_habits.js) with
 * the shared in-memory mock collection (utils/mockLifeMongo.ts) — same
 * pattern as readiness_route.test.ts / workouts_exercise_trends_route.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeHabitsRoute = require('../../routes/life_habits')
import { makeMockCollection } from './utils/mockLifeMongo'

function makeApp(seed: { habits?: any[]; rules?: any[]; checks?: any[] } = {}) {
  const collections: Record<string, ReturnType<typeof makeMockCollection>> = {
    life_habits: makeMockCollection(seed.habits || []),
    life_habit_rules: makeMockCollection(seed.rules || []),
    life_rule_checks: makeMockCollection(seed.checks || []),
    life_day_goals: makeMockCollection([]),
  }
  const db = {
    collection(name: string) {
      if (!collections[name]) throw new Error(`unexpected collection: ${name}`)
      return collections[name]
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/life', lifeHabitsRoute(() => db))
  return { app, collections }
}

describe('POST /api/life/habits', () => {
  it('creates a build habit — frequency is always forced to daily (MVP)', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({
        type: 'build',
        name: 'Читати',
        implementation: 'Після кави я відкриваю книгу о 8:00 на кухні',
        identity: 'Я людина, яка читає',
        two_minute: 'відкрити книгу і прочитати 1 сторінку',
        frequency: { kind: 'weekly', days: [1, 3, 5] }, // MVP ignores this — always daily
      })
    expect(res.status).toBe(201)
    expect(res.body.frequency).toEqual({ kind: 'daily' })
    expect(res.body.active).toBe(true)
    expect(res.body.archived_at).toBeNull()
    expect(res.body.type).toBe('build')
  })

  it('400 on an invalid type', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({ type: 'other', name: 'x', implementation: 'y' })
    expect(res.status).toBe(400)
  })

  it('400 when a required field is missing', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/life/habits').send({ type: 'build' }) // missing `name`
    expect(res.status).toBe(400)
  })

  // #1587 P0-2: `implementation` must be OPTIONAL — both the dashboard form
  // (HabitFormModal.jsx sends `null` when left blank) and the MCP tool
  // (mcp-servers/me/index.ts habit_create, `z.string().optional()`, omits
  // the key entirely) create habits without it. `requireFields` used to
  // treat BOTH `undefined` and `null` as "missing" and 400 the request.
  it('implementation is optional — creating a habit without it succeeds (#1587 P0-2)', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/life/habits').send({ type: 'build', name: 'Пити воду' })
    expect(res.status).toBe(201)
    expect(res.body.implementation).toBeNull()
  })

  it('implementation:null (explicitly sent by the dashboard form when left blank) also succeeds', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'Пити воду', implementation: null })
    expect(res.status).toBe(201)
    expect(res.body.implementation).toBeNull()
  })

  // #1587 P0-2: the dashboard's "create habit" form sends 1-3 rules in the
  // SAME POST body (HabitFormModal.jsx `rules: activeRules` ->
  // HabitsPage.jsx `api.createHabit(formState)`) — this route used to only
  // read habit-level fields and silently drop `rules`, so a dashboard-
  // created habit always ended up with ZERO active rules.
  it('rules[] sent at creation time are inserted and embedded in the response (#1587 P0-2)', async () => {
    const { app, collections } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({
        type: 'build',
        name: 'Пити воду вранці',
        rules: [{ text: 'Склянка води до кави' }, { text: 'Пляшка на столі' }],
      })
    expect(res.status).toBe(201)
    expect(res.body.rules.length).toBe(2)
    expect(res.body.rules[0].text).toBe('Склянка води до кави')
    expect(res.body.rules[0].order).toBe(1)
    expect(res.body.rules[1].order).toBe(2)

    const storedRules = collections.life_habit_rules
      ._docs()
      .filter((d: any) => String(d.habit_id) === String(res.body._id))
    expect(storedRules.length).toBe(2)
    expect(storedRules.every((r: any) => r.active === true)).toBe(true)
  })

  it('rules[] as bare strings (not {text}) are also accepted', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'x', rules: ['Правило А'] })
    expect(res.status).toBe(201)
    expect(res.body.rules.length).toBe(1)
    expect(res.body.rules[0].text).toBe('Правило А')
  })

  it('rules[] beyond the 3-active cap are truncated, never rejected', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'x', rules: ['a', 'b', 'c', 'd'] })
    expect(res.status).toBe(201)
    expect(res.body.rules.length).toBe(3)
  })

  it('a missing/empty rules[] still creates the habit with rules: []', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    expect(res.status).toBe(201)
    expect(res.body.rules).toEqual([])
  })

  it('identity/two_minute are forced to null for a break habit even if sent', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/life/habits')
      .send({
        type: 'break',
        name: 'Менше цукру',
        implementation: 'Коли хочеться солодкого, я п\'ю воду',
        identity: 'should be ignored',
        two_minute: 'should be ignored',
      })
    expect(res.status).toBe(201)
    expect(res.body.identity).toBeNull()
    expect(res.body.two_minute).toBeNull()
  })
})

describe('DELETE /api/life/habits/:id — soft delete', () => {
  it('archives instead of removing', async () => {
    const { app, collections } = makeApp()
    const created = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'x', implementation: 'y' })
    const id = created.body._id
    const del = await request(app).delete(`/api/life/habits/${id}`)
    expect(del.status).toBe(200)
    expect(del.body.success).toBe(true)
    const stored = collections.life_habits._docs().find((d: any) => String(d._id) === String(id))
    expect(stored).toBeDefined()
    expect(stored!.archived_at).not.toBeNull()
    expect(stored!.active).toBe(false)
  })

  it('404 for a non-existent id', async () => {
    const { app } = makeApp()
    const res = await request(app).delete(`/api/life/habits/${new ObjectId()}`)
    expect(res.status).toBe(404)
  })
})

describe('habit rules — 1-3 active per habit (SPEC A3)', () => {
  it('a 4th active rule is rejected with 400', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'break', name: 'Менше цукру', implementation: 'x' })
    const habitId = habitRes.body._id

    for (let i = 1; i <= 3; i++) {
      const r = await request(app).post(`/api/life/habits/${habitId}/rules`).send({ text: `Правило ${i}` })
      expect(r.status).toBe(201)
    }
    const r4 = await request(app).post(`/api/life/habits/${habitId}/rules`).send({ text: 'Правило 4' })
    expect(r4.status).toBe(400)
  })

  it('404 when the habit does not exist', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post(`/api/life/habits/${new ObjectId()}/rules`)
      .send({ text: 'x' })
    expect(res.status).toBe(404)
  })

  it('reactivating a rule that would push past the 3-active cap is rejected', async () => {
    const habitId = new ObjectId()
    const r1 = new ObjectId()
    const r2 = new ObjectId()
    const r3 = new ObjectId()
    const r4Inactive = new ObjectId()
    const { app } = makeApp({
      habits: [{ _id: habitId, type: 'break', name: 'x', implementation: 'y', active: true, archived_at: null }],
      rules: [
        { _id: r1, habit_id: habitId, text: 'a', order: 1, active: true, archived_at: null },
        { _id: r2, habit_id: habitId, text: 'b', order: 2, active: true, archived_at: null },
        { _id: r3, habit_id: habitId, text: 'c', order: 3, active: true, archived_at: null },
        { _id: r4Inactive, habit_id: habitId, text: 'd', order: 4, active: false, archived_at: new Date() },
      ],
    })
    const res = await request(app).put(`/api/life/rules/${r4Inactive}`).send({ active: true })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/life/rules/:id/check — upsert by (rule_id, day)', () => {
  it('a second check for the SAME day UPDATES in place, never duplicates', async () => {
    const { app, collections } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'Пити воду', implementation: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'Випити склянку води вранці' })
    const ruleId = ruleRes.body._id

    const c1 = await request(app)
      .post(`/api/life/rules/${ruleId}/check`)
      .send({ day: '2026-10-01', done: false, source: 'dashboard' })
    expect(c1.status).toBe(200)
    expect(c1.body.done).toBe(false)

    const c2 = await request(app)
      .post(`/api/life/rules/${ruleId}/check`)
      .send({ day: '2026-10-01', done: true, source: 'lisa' })
    expect(c2.status).toBe(200)
    expect(c2.body.done).toBe(true)
    expect(c2.body.source).toBe('lisa')

    const stored = collections.life_rule_checks
      ._docs()
      .filter((d: any) => String(d.rule_id) === String(ruleId) && d.day === '2026-10-01')
    expect(stored.length).toBe(1) // upsert, never a duplicate row
  })

  it('defaults day to today (Kyiv) when omitted', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'x', implementation: 'y' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const res = await request(app)
      .post(`/api/life/rules/${ruleRes.body._id}/check`)
      .send({ done: true, source: 'dashboard' })
    expect(res.status).toBe(200)
    expect(res.body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('400 on a malformed day', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'x', implementation: 'y' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const res = await request(app)
      .post(`/api/life/rules/${ruleRes.body._id}/check`)
      .send({ day: '01-10-2026', done: true, source: 'dashboard' })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/life/rules/:id/check — clear a check-in (#1587 P0-1)', () => {
  it('RED: a POST done:false can never cycle back to done:true (the bug this endpoint fixes)', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const ruleId = ruleRes.body._id

    // Reproduces HabitRow.jsx's OLD third cycle step: POST done:false,
    // two_minute_version:false (what the UI used to send instead of DELETE).
    await request(app).post(`/api/life/rules/${ruleId}/check`).send({
      day: '2026-10-01', done: false, two_minute_version: false, source: 'dashboard',
    })
    const stuck = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    // This IS the bug: the rule "looks empty" to a naive reader (done:false,
    // not done:true) but is NOT the neutral {done:null} state — it is a
    // permanent explicit failure that a build-habit cycle can never recover
    // from via POST alone (no false->true branch exists).
    expect(stuck.body.habits[0].rules[0].check).toEqual({ done: false, two_minute_version: false })
    expect(stuck.body.habits[0].rules[0].check.done).not.toBeNull()
  })

  it('GREEN: DELETE restores the neutral {done:null, two_minute_version:null} state', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const ruleId = ruleRes.body._id

    await request(app)
      .post(`/api/life/rules/${ruleId}/check`)
      .send({ day: '2026-10-01', done: true, two_minute_version: true, source: 'dashboard' })

    const del = await request(app).delete(`/api/life/rules/${ruleId}/check`).query({ day: '2026-10-01' })
    expect(del.status).toBe(200)
    expect(del.body.success).toBe(true)

    const after = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    expect(after.body.habits[0].rules[0].check).toEqual({ done: null, two_minute_version: null })
    expect(after.body.habits[0].done_today).toBeNull()
  })

  it('scopes the clear to ONE day — other days keep their own check', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const ruleId = ruleRes.body._id

    await request(app).post(`/api/life/rules/${ruleId}/check`).send({ day: '2026-10-01', done: true, source: 'dashboard' })
    await request(app).post(`/api/life/rules/${ruleId}/check`).send({ day: '2026-10-02', done: true, source: 'dashboard' })

    await request(app).delete(`/api/life/rules/${ruleId}/check`).query({ day: '2026-10-01' })

    const day1 = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    const day2 = await request(app).get('/api/life/today').query({ day: '2026-10-02' })
    expect(day1.body.habits[0].rules[0].check.done).toBeNull()
    expect(day2.body.habits[0].rules[0].check.done).toBe(true)
  })

  it('defaults day to today (Kyiv) when the query param is omitted', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const res = await request(app).delete(`/api/life/rules/${ruleRes.body._id}/check`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('is idempotent — clearing a check-in that never existed still returns 200 success', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const res = await request(app)
      .delete(`/api/life/rules/${ruleRes.body._id}/check`)
      .query({ day: '2026-10-01' })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('404 for a non-existent rule id', async () => {
    const { app } = makeApp()
    const res = await request(app).delete(`/api/life/rules/${new ObjectId()}/check`)
    expect(res.status).toBe(404)
  })

  it('400 on a malformed day', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'r' })
    const res = await request(app)
      .delete(`/api/life/rules/${ruleRes.body._id}/check`)
      .query({ day: '01-10-2026' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/life/habits and /api/life/habits/:id — embedded rules[] (#1524)', () => {
  it('GET /habits embeds each habit\'s active rules, including an ARCHIVED habit\'s rules', async () => {
    const liveHabitId = new ObjectId()
    const archivedHabitId = new ObjectId()
    const liveRuleId = new ObjectId()
    const archivedHabitRuleId = new ObjectId()
    const inactiveRuleId = new ObjectId()
    const { app } = makeApp({
      habits: [
        { _id: liveHabitId, type: 'build', name: 'Читати', implementation: 'x', active: true, archived_at: null },
        {
          _id: archivedHabitId,
          type: 'build',
          name: 'Стара звичка',
          implementation: 'y',
          active: false,
          archived_at: new Date('2026-09-20T00:00:00.000Z'),
        },
      ],
      rules: [
        { _id: liveRuleId, habit_id: liveHabitId, text: 'Прочитати сторінку', order: 1, active: true, archived_at: null },
        { _id: inactiveRuleId, habit_id: liveHabitId, text: 'Старе правило', order: 2, active: false, archived_at: new Date() },
        {
          _id: archivedHabitRuleId,
          habit_id: archivedHabitId,
          text: 'Правило архівної звички',
          order: 1,
          active: true,
          archived_at: null,
        },
      ],
    })

    // default active=true -> only the live habit, with only its ACTIVE rule
    const liveRes = await request(app).get('/api/life/habits')
    expect(liveRes.status).toBe(200)
    expect(liveRes.body.length).toBe(1)
    expect(liveRes.body[0]._id).toBe(String(liveHabitId))
    expect(liveRes.body[0].rules.length).toBe(1)
    expect(liveRes.body[0].rules[0]._id).toBe(String(liveRuleId))

    // active=false -> only the archived habit, still carrying its own active rule
    const archivedRes = await request(app).get('/api/life/habits').query({ active: 'false' })
    expect(archivedRes.status).toBe(200)
    expect(archivedRes.body.length).toBe(1)
    expect(archivedRes.body[0]._id).toBe(String(archivedHabitId))
    expect(archivedRes.body[0].rules.length).toBe(1)
    expect(archivedRes.body[0].rules[0]._id).toBe(String(archivedHabitRuleId))
  })

  it('GET /habits returns rules: [] for a habit with no active rules', async () => {
    const { app } = makeApp()
    await request(app).post('/api/life/habits').send({ type: 'build', name: 'x', implementation: 'y' })
    const res = await request(app).get('/api/life/habits')
    expect(res.status).toBe(200)
    expect(res.body[0].rules).toEqual([])
  })

  it('GET /habits/:id embeds the single habit\'s active rules', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'break', name: 'Менше цукру', implementation: 'x' })
    const habitId = habitRes.body._id
    const ruleRes = await request(app).post(`/api/life/habits/${habitId}/rules`).send({ text: 'Не їсти солодке' })

    const res = await request(app).get(`/api/life/habits/${habitId}`)
    expect(res.status).toBe(200)
    expect(res.body.rules.length).toBe(1)
    expect(res.body.rules[0]._id).toBe(ruleRes.body._id)
    expect(res.body.rules[0].text).toBe('Не їсти солодке')
  })

  it('GET /habits/:id — 404 for a non-existent id (unaffected by the rules-embedding change)', async () => {
    const { app } = makeApp()
    const res = await request(app).get(`/api/life/habits/${new ObjectId()}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/life/today', () => {
  it('400 on an invalid day', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/life/today').query({ day: '01-10-2026' })
    expect(res.status).toBe(400)
  })

  it('neutral unchecked (done_today:null, check:{done:null}) when there is no check-in yet (SPEC Q2 default)', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'Читати', implementation: 'x' })
    await request(app).post(`/api/life/habits/${habitRes.body._id}/rules`).send({ text: 'Прочитати сторінку' })

    const res = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    expect(res.status).toBe(200)
    expect(res.body.day).toBe('2026-10-01')
    expect(res.body.habits.length).toBe(1)
    expect(res.body.habits[0].done_today).toBeNull()
    expect(res.body.habits[0].rules[0].check).toEqual({ done: null, two_minute_version: null })
  })

  it('done_today:true when every active rule is checked for that day', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'Читати', implementation: 'x' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${habitRes.body._id}/rules`)
      .send({ text: 'Прочитати сторінку' })
    await request(app)
      .post(`/api/life/rules/${ruleRes.body._id}/check`)
      .send({ day: '2026-10-01', done: true, source: 'dashboard' })

    const res = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    expect(res.body.habits[0].done_today).toBe(true)
    expect(res.body.habits[0].rules[0].check.done).toBe(true)
  })

  it('days_clean follows the SPEC §5 table exactly for a break habit', async () => {
    const habitId = new ObjectId()
    const ruleId = new ObjectId()
    const { app } = makeApp({
      habits: [
        {
          _id: habitId,
          type: 'break',
          name: 'Less sugar',
          implementation: 'x',
          created_at: new Date('2026-09-27T12:00:00.000Z'), // Kyiv day 2026-09-27
          archived_at: null,
        },
      ],
      rules: [{ _id: ruleId, habit_id: habitId, text: 'No sugar', order: 1, active: true, archived_at: null }],
      checks: [
        { rule_id: ruleId, habit_id: habitId, day: '2026-09-28', done: true }, // +1 clean -> 1
        // +2 (2026-09-29): no check-in -> absence is clean -> 2
        { rule_id: ruleId, habit_id: habitId, day: '2026-09-30', done: false }, // +3 failure -> reset 0
        { rule_id: ruleId, habit_id: habitId, day: '2026-10-01', done: true }, // +4 clean -> 1
      ],
    })

    const expectDaysClean = async (day: string, expected: number) => {
      const res = await request(app).get('/api/life/today').query({ day })
      expect(res.body.habits[0].days_clean).toBe(expected)
    }

    await expectDaysClean('2026-09-27', 0) // creation day itself
    await expectDaysClean('2026-09-28', 1)
    await expectDaysClean('2026-09-29', 2)
    await expectDaysClean('2026-09-30', 0)
    await expectDaysClean('2026-10-01', 1)
  })

  it('days_clean is null for a build habit (only meaningful for break)', async () => {
    const { app } = makeApp()
    await request(app).post('/api/life/habits').send({ type: 'build', name: 'x', implementation: 'y' })
    const res = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    expect(res.body.habits[0].days_clean).toBeNull()
  })
})

export {}
