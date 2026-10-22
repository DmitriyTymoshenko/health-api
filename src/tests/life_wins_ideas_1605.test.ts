const express = require('express'), request = require('supertest')
const { ObjectId } = require('mongodb')
const winsRoute = require('../../routes/life_wins_ideas'), planRoute = require('../../routes/life_planning'), habitsRoute = require('../../routes/life_habits')
const { todayKyiv, addDaysToKyivDay } = require('../../lib/kyiv-day')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'

function setup(seed: Record<string, any[]> = {}) {
  const collections: Record<string, any> = {}
  const db = { collection: (n: string) => collections[n] || (collections[n] = makeMockCollection(seed[n] || [])) }
  const app = express(); app.use(express.json())
  app.use('/api/life', winsRoute(() => db)); app.use('/api/life', planRoute(() => db)); app.use('/api/life', habitsRoute(() => db))
  return { app, db }
}
const IDEA = {
  knowledge_ref: 'knowledge_items:4242', source_title: 'Атомні звички: система 1%', source_date: '2026-09-15',
  source_url: 'https://example.com/atomic-habits', quote: 'Не піднімайся до рівня цілей — опускайся до рівня своїх систем.',
  proposal: 'Щоранку 5 хвилин планувати день', area: 'personal_efficiency',
}

describe('wins journal (#1605)', () => {
  it('manual + lisa wins are stored, idempotent per day/text/source and match the contract', async () => {
    const { app } = setup()
    const a = await request(app).post('/api/life/wins').send({ text: 'Пробіг 5 км' })
    expect(a.status).toBe(201); assertMatchesContract('Win', a.body); expect(a.body.source).toBe('manual'); expect(a.body.day).toBe(todayKyiv())
    const again = await request(app).post('/api/life/wins').send({ text: 'Пробіг 5 км' })
    expect(again.status).toBe(200); expect(again.body._id).toBe(a.body._id)
    const l = await request(app).post('/api/life/wins').send({ text: 'Закрив квартальний звіт', source: 'lisa' })
    expect(l.body.source).toBe('lisa')
    const list = await request(app).get('/api/life/wins'); expect(list.status).toBe(200)
    assertMatchesContract('WinsResponse', list.body)
    expect(list.body.summary).toEqual({ total: 2, by_source: { manual: 1, lisa: 1, auto: 0 }, days_with_wins: 1 })
  })
  it('rejects blank text, future/invalid day, unknown links and unknown fields', async () => {
    const { app } = setup()
    for (const body of [{ text: '   ' }, { text: '' }, { text: 'x', day: addDaysToKyivDay(todayKyiv(), 2) }, { text: 'x', day: '2026-02-30' },
      { text: 'x', goal_id: String(new ObjectId()) }, { text: 'x', habit_id: String(new ObjectId()) }, { text: 'x', source: 'auto' }, { text: 'x', extra: 1 }]) {
      expect((await request(app).post('/api/life/wins').send(body)).status).toBe(400)
    }
  })
  it('closing a goal creates exactly one auto win, even after repeated reads', async () => {
    const { app, db } = setup()
    const plan = (await request(app).post('/api/life/plans').send({ title: 'Запустити сайт', kind: 'goal', outcome: 'Сайт працює' })).body
    expect((await request(app).get('/api/life/wins')).body.wins).toHaveLength(0)
    await request(app).put('/api/life/plans/' + plan._id).send({ status: 'done', evidence: 'Сайт відкривається' })
    const [r1, r2] = [await request(app).get('/api/life/wins'), await request(app).get('/api/life/wins')]
    expect(r1.body.wins).toHaveLength(1); expect(r2.body.wins).toHaveLength(1)
    expect(r1.body.wins[0]).toMatchObject({ source: 'auto', text: 'Ціль закрито: Запустити сайт', goal_id: plan._id, day: todayKyiv() })
    assertMatchesContract('WinsResponse', r1.body)
  })
  it('a 7-day habit streak yields one auto win for the highest milestone only', async () => {
    const hid = new ObjectId(), today = todayKyiv(), created = new Date(Date.now() - 20 * 86400000)
    const checks = Array.from({ length: 9 }, (_, i) => ({ _id: new ObjectId(), habit_id: hid, rule_id: 'r1', day: addDaysToKyivDay(today, -i), done: true, two_minute_version: false }))
    const { app } = setup({
      life_habits: [{ _id: hid, type: 'build', name: 'Читання', active: true, frequency: { kind: 'daily' }, tracker: null, created_at: created }],
      life_habit_rules: [{ _id: 'r1', habit_id: hid, text: 'Читати 10 хв', active: true }],
      life_rule_checks: checks.map(c => ({ ...c, rule_id: 'r1' })),
    })
    const res = await request(app).get('/api/life/wins')
    const streak = res.body.wins.filter((w: any) => w.text.startsWith('Серія'))
    expect(streak).toHaveLength(1); expect(streak[0].text).toBe('Серія 7 днів поспіль: Читання'); expect(streak[0].habit_id).toBe(String(hid))
    expect((await request(app).get('/api/life/wins')).body.wins.filter((w: any) => w.text.startsWith('Серія'))).toHaveLength(1)
  })
  it('rejects an inverted/invalid period', async () => {
    const { app } = setup()
    expect((await request(app).get('/api/life/wins?from=2026-10-10&to=2026-10-01')).status).toBe(400)
    expect((await request(app).get('/api/life/wins?from=nope')).status).toBe(400)
  })
})

describe('personal ideas from sources (#1605, anti-fabrication)', () => {
  it('stores a fully-sourced idea, is idempotent per knowledge_ref and matches the contract', async () => {
    const { app } = setup()
    const a = await request(app).post('/api/life/ideas').send(IDEA)
    expect(a.status).toBe(201); assertMatchesContract('Idea', a.body); expect(a.body.status).toBe('new')
    const dup = await request(app).post('/api/life/ideas').send({ ...IDEA, proposal: 'Інша пропозиція' })
    expect(dup.status).toBe(200); expect(dup.body._id).toBe(a.body._id); expect(dup.body.proposal).toBe(IDEA.proposal)
    const list = await request(app).get('/api/life/ideas?status=new'); assertMatchesContract('IdeasResponse', list.body); expect(list.body.ideas).toHaveLength(1)
    expect((await request(app).get('/api/life/ideas?status=weird')).status).toBe(400)
  })
  it.each(['source_title', 'source_date', 'source_url', 'quote', 'knowledge_ref', 'proposal', 'area'])('rejects an idea without %s (400)', async field => {
    const { app } = setup(); const body: any = { ...IDEA }; delete body[field]
    expect((await request(app).post('/api/life/ideas').send(body)).status).toBe(400)
    expect((await request(app).post('/api/life/ideas').send({ ...IDEA, [field]: '   ' })).status).toBe(400)
  })
  it('rejects a too-short quote, a non-http URL, a future or impossible source date', async () => {
    const { app } = setup()
    for (const patch of [{ quote: 'Коротко' }, { source_url: 'ftp://x' }, { source_url: 'не посилання' }, { source_date: addDaysToKyivDay(todayKyiv(), 3) }, { source_date: '2026-02-30' }, { area: 'finance' }, { extra: 1 }])
      expect((await request(app).post('/api/life/ideas').send({ ...IDEA, ...patch })).status).toBe(400)
  })
  it('accept as goal creates an active goal linked to the source; status is final', async () => {
    const { app, db } = setup(); const idea = (await request(app).post('/api/life/ideas').send(IDEA)).body
    const bad = await request(app).put('/api/life/ideas/' + idea._id).send({ status: 'accepted' }); expect(bad.status).toBe(400)
    const ok = await request(app).put('/api/life/ideas/' + idea._id).send({ status: 'accepted', accept_as: 'goal', name: 'Планувати день' })
    expect(ok.status).toBe(200); assertMatchesContract('Idea', ok.body); expect(ok.body.accepted_as.kind).toBe('goal'); expect(ok.body.decided_at).toBeTruthy()
    const plans = await request(app).get('/api/life/plans')
    expect(plans.body.plans).toHaveLength(1); expect(plans.body.plans[0]).toMatchObject({ title: 'Планувати день', kind: 'goal', status: 'active' })
    expect(plans.body.plans[0].why).toContain(IDEA.source_title)
    expect((await request(app).put('/api/life/ideas/' + idea._id).send({ status: 'dismissed' })).status).toBe(400)
  })
  it('accept as habit creates a build habit with one rule; dismiss creates nothing', async () => {
    const { app } = setup(); const a = (await request(app).post('/api/life/ideas').send(IDEA)).body
    const b = (await request(app).post('/api/life/ideas').send({ ...IDEA, knowledge_ref: 'knowledge_items:7' })).body
    const ok = await request(app).put('/api/life/ideas/' + a._id).send({ status: 'accepted', accept_as: 'habit' })
    expect(ok.body.accepted_as.kind).toBe('habit')
    const habits = await request(app).get('/api/life/habits'); expect(habits.body).toHaveLength(1)
    expect(habits.body[0]).toMatchObject({ type: 'build', name: IDEA.proposal }); expect(habits.body[0].rules).toHaveLength(1)
    const d = await request(app).put('/api/life/ideas/' + b._id).send({ status: 'dismissed' })
    expect(d.body.status).toBe('dismissed'); expect(d.body.accepted_as).toBeNull()
    expect((await request(app).put('/api/life/ideas/' + b._id).send({ status: 'dismissed', accept_as: 'goal' })).status).toBe(400)
    expect((await request(app).get('/api/life/habits')).body).toHaveLength(1)
    expect((await request(app).put('/api/life/ideas/' + new ObjectId()).send({ status: 'dismissed' })).status).toBe(404)
  })
})
export {}
