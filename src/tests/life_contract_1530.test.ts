/**
 * Contract tests for `/api/life/*` GET responses (#1530 — Якість: єдиний
 * контракт API). Validates the REAL route output (not a hand-typed mock)
 * against the single source of truth `contracts/life-contracts.schema.json`
 * (same file me-dashboard's `mockLifeApi.contract.test.js` validates its
 * mock layer against — see `src/tests/utils/validateLifeContract.ts`).
 *
 * Root cause this guards: #1520 (mock embedded a `profile` key /today never
 * returns, used `today_check` instead of `check`) and #1524 (GET /habits and
 * /habits/:id missing embedded `rules[]`) both passed the route's OWN
 * hand-written assertions because those assertions only checked the few
 * fields the test author happened to think of. `assertMatchesContract` uses
 * `additionalProperties:false` on every response-root shape, so an UNLISTED
 * extra field (or a missing required one) fails here even if nobody wrote
 * an assertion for that exact field.
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
const lifeDayGoalsRoute = require('../../routes/life_day_goals')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeProfileRoute = require('../../routes/life_profile')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'

function makeApp(
  seed: { habits?: any[]; rules?: any[]; checks?: any[]; dayGoals?: any[]; profile?: any[] } = {}
) {
  const collections: Record<string, ReturnType<typeof makeMockCollection>> = {
    life_habits: makeMockCollection(seed.habits || []),
    life_habit_rules: makeMockCollection(seed.rules || []),
    life_rule_checks: makeMockCollection(seed.checks || []),
    life_day_goals: makeMockCollection(seed.dayGoals || []),
    life_profile: makeMockCollection(seed.profile || []),
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
  app.use('/api/life', lifeDayGoalsRoute(() => db))
  app.use('/api/life', lifeProfileRoute(() => db))
  return { app, collections }
}

describe('Contract (#1530) — GET /api/life/today', () => {
  it('a realistic multi-habit/multi-goal day matches TodayResponse exactly', async () => {
    const { app } = makeApp()
    const buildRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'Читати', implementation: 'x', identity: 'y', two_minute: 'z' })
    const ruleRes = await request(app)
      .post(`/api/life/habits/${buildRes.body._id}/rules`)
      .send({ text: 'Прочитати сторінку' })
    await request(app)
      .post(`/api/life/rules/${ruleRes.body._id}/check`)
      .send({ day: '2026-10-01', done: true, two_minute_version: false, source: 'dashboard' })

    const breakRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'break', name: 'Менше цукру', implementation: 'x' })
    await request(app).post(`/api/life/habits/${breakRes.body._id}/rules`).send({ text: 'Не їсти солодке' })

    await request(app).post('/api/life/day-goals').send({ text: 'Закрити задачу', day: '2026-10-01' })

    const res = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    expect(res.status).toBe(200)
    assertMatchesContract('TodayResponse', res.body)
  })

  it('a day with no habits/goals at all still matches TodayResponse (empty arrays, not missing keys)', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/life/today').query({ day: '2026-10-01' })
    expect(res.status).toBe(200)
    assertMatchesContract('TodayResponse', res.body)
  })
})

describe('Contract (#1530) — GET /api/life/habits', () => {
  it('matches HabitsListResponse (#1524 regression: embedded rules[], no done_today/days_clean)', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'build', name: 'Читати', implementation: 'x' })
    await request(app).post(`/api/life/habits/${habitRes.body._id}/rules`).send({ text: 'Правило 1' })

    const res = await request(app).get('/api/life/habits')
    expect(res.status).toBe(200)
    assertMatchesContract('HabitsListResponse', res.body)
  })

  it('an empty list matches HabitsListResponse', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/life/habits')
    expect(res.status).toBe(200)
    assertMatchesContract('HabitsListResponse', res.body)
  })
})

describe('Contract (#1530) — GET /api/life/habits/:id', () => {
  it('matches HabitListItem (#1524 regression)', async () => {
    const { app } = makeApp()
    const habitRes = await request(app)
      .post('/api/life/habits')
      .send({ type: 'break', name: 'Менше цукру', implementation: 'x' })
    await request(app).post(`/api/life/habits/${habitRes.body._id}/rules`).send({ text: 'Не їсти солодке' })

    const res = await request(app).get(`/api/life/habits/${habitRes.body._id}`)
    expect(res.status).toBe(200)
    assertMatchesContract('HabitListItem', res.body)
  })
})

describe('Contract (#1530/#1587) — implementation:null still matches HabitListItem', () => {
  // #1587 P0-2 made `implementation` optional; the contract schema's
  // `implementation` was `"type":"string"` (not nullable) until this same
  // task — this test proves the actual live shape (a habit created without
  // an implementation intention) still passes additionalProperties:false
  // strict validation, not just that the field is present.
  it('a habit created without implementation (null) matches HabitListItem', async () => {
    const { app } = makeApp()
    const habitRes = await request(app).post('/api/life/habits').send({ type: 'build', name: 'Пити воду' })
    expect(habitRes.body.implementation).toBeNull()

    const res = await request(app).get(`/api/life/habits/${habitRes.body._id}`)
    expect(res.status).toBe(200)
    assertMatchesContract('HabitListItem', res.body)
  })
})

describe('Contract (#1530) — GET /api/life/profile', () => {
  // Real shape, measured live 2026-10-01 against
  // https://srv1532186.hstgr.cloud/me/api-life/api/life/profile (QA
  // BLOCKED Max/Codex #8918 unblock condition item 1): 8 root fields, all
  // required — `_id`/`updated_at` are NOT optional, the singleton always
  // carries them (Mongo auto _id + upsert's $set updated_at).
  const LIVE_PROFILE_SEED = {
    _id: new ObjectId(),
    version: 1,
    source: 'vault:EN/00-09 System & Personal/01 About/dmytro-profile.md#51.01',
    strengths: [{ key: 'learner', name: 'Learner', description: 'x' }],
    dominant_domain: 'Стратегічне мислення',
    leadership_style: 'Аналітик-стратег',
    balance_formula: {
      label: 'Аналітика + Дія + Довіра = Ріст',
      components: [{ key: 'analytics', label: 'Аналітика', description: 'дає силу приймати розумні рішення' }],
    },
    updated_at: new Date(),
  }

  it('matches Profile (all 8 live root fields required, additionalProperties:false)', async () => {
    const { app } = makeApp({ profile: [LIVE_PROFILE_SEED] })
    const res = await request(app).get('/api/life/profile')
    expect(res.status).toBe(200)
    assertMatchesContract('Profile', res.body)
  })

  // RED-FIRST PROOF (#1530 fix-cycle, QA BLOCKED Max/Codex #8918): this is
  // Max's exact negative probe. Against the PRE-FIX schema (git HEAD before
  // this commit — `definitions/Profile` had no `additionalProperties:false`
  // anywhere) this payload validated `valid=true, errors=null` — reproduced
  // independently via a direct ajv compile of `git show HEAD:contracts/
  // life-contracts.schema.json` before writing this test. After the fix it
  // MUST throw.
  it('rejects an unexpected ROOT field (Max\'s probe #8918)', () => {
    const payload = {
      ...LIVE_PROFILE_SEED,
      _id: String(LIVE_PROFILE_SEED._id),
      updated_at: LIVE_PROFILE_SEED.updated_at.toISOString(),
      unexpected_root_field: 'passes',
    }
    expect(() => assertMatchesContract('Profile', payload)).toThrow(/additionalProperties|unexpected_root_field/)
  })

  it('rejects an unexpected NESTED field on strengths[] (Max\'s probe #8918)', () => {
    const payload = {
      ...LIVE_PROFILE_SEED,
      _id: String(LIVE_PROFILE_SEED._id),
      updated_at: LIVE_PROFILE_SEED.updated_at.toISOString(),
      strengths: [{ key: 'learner', name: 'Learner', description: 'x', extra_strength_field: 'passes' }],
    }
    expect(() => assertMatchesContract('Profile', payload)).toThrow(/additionalProperties|extra_strength_field/)
  })

  it('rejects balance_formula.components[] as bare strings (the real mockLifeApi.js bug this fix-cycle found)', () => {
    const payload = {
      ...LIVE_PROFILE_SEED,
      _id: String(LIVE_PROFILE_SEED._id),
      updated_at: LIVE_PROFILE_SEED.updated_at.toISOString(),
      balance_formula: { label: 'x', components: ['Аналітика', 'Дія', 'Довіра'] },
    }
    expect(() => assertMatchesContract('Profile', payload)).toThrow()
  })
})

export {}
