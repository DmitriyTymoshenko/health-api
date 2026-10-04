import express from 'express'
import request from 'supertest'

jest.mock('../../lib/gemini-text', () => ({ GEMINI_MODEL: 'test', callGemini: jest.fn() }))
jest.mock('../../lib/koliada-corpus', () => ({ loadCorpus: () => ({ text: 'fixture educational corpus' }) }))
const { callGemini } = require('../../lib/gemini-text')
const buildRouter = require('../../routes/supplement_catalog')
const SECRET = 'SYNTHETIC_PRIVATE_MEDICAL_CONTEXT_2037'
const emptyPayload = { recommendations: [], warnings: [], errors: [] }

function fixture({ cached = false, profile = null, profileError = false, cacheError = false, capped = false }: any = {}) {
  const state: any = { profile, writes: [], reads: [], cached: cached ? { refresh_count: capped ? 999 : 0, payload: { ...emptyPayload, personal_safety: { status: 'safe' } } } : null }
  const db = { collection(name: string) {
    if (name === 'personal_profile') return { findOne: async (query: any) => {
      state.reads.push(query)
      if (profileError) throw new Error(SECRET)
      return state.profile
    } }
    if (name === 'supplement_recommendations') return {
      findOne: async () => { if (cacheError) throw new Error('cache unavailable'); return state.cached },
      updateOne: async (_query: any, update: any) => { state.writes.push(update); state.cached = update.$set },
    }
    const cursor: any = { toArray: async () => [], sort: () => cursor, limit: () => cursor }
    return { find: () => cursor }
  } }
  const app = express(); app.use(express.json()); app.use('/catalog', buildRouter(() => db))
  return { app, state }
}
const env = process.env.GOOGLE_AI_API_KEY
beforeEach(() => { process.env.GOOGLE_AI_API_KEY = 'fake-test-only'; callGemini.mockReset(); callGemini.mockResolvedValue({ json: { items: [] }, usage: {} }) })
afterAll(() => { if (env === undefined) delete process.env.GOOGLE_AI_API_KEY; else process.env.GOOGLE_AI_API_KEY = env })

it.each([false, true])('fresh/cache=%s missing profile is explicitly not assessed', async cached => {
  const { app, state } = fixture({ cached })
  const res = await request(app).get('/catalog/recommendations')
  expect(res.status).toBe(200)
  expect(res.body.personal_safety).toMatchObject({ status: 'not_assessed', fields: { medications: 'missing', allergies: 'missing', chronic_conditions: 'missing' } })
  expect(res.body.personal_safety.reasons).toContain('profile_missing')
  expect(state.reads).toEqual([{ _type: 'profile' }])
  expect(callGemini).toHaveBeenCalledTimes(cached ? 0 : 1)
})

it.each([
  [{ medications: [], allergies: [], chronic_conditions: [], updated_at: '2026-10-05' }, 'empty_unconfirmed'],
  [{ medications: null, allergies: 'none', chronic_conditions: {} }, 'invalid'],
  [{ medications: [''], allergies: [null], chronic_conditions: [{ name: 'unknown shape' }] }, 'invalid'],
  [{ medications: [SECRET], allergies: [SECRET], chronic_conditions: [SECRET] }, 'available'],
])('classifies context without declaring safety: %j', async (profile, expected) => {
  const { app, state } = fixture({ profile })
  const res = await request(app).get('/catalog/recommendations')
  expect(res.body.personal_safety.status).toBe('not_assessed')
  expect(Object.values(res.body.personal_safety.fields)).toEqual([expected, expected, expected])
  expect(res.body.personal_safety.reasons).toContain('clinical_safety_not_assessed')
  expect(JSON.stringify(callGemini.mock.calls)).not.toContain(SECRET)
  expect(JSON.stringify(state.writes)).not.toContain(SECRET)
  expect(state.writes[0].$set.payload.personal_safety).toBeUndefined()
  expect(JSON.stringify(res.body)).not.toContain(SECRET)
})

it('rereads current context for the same cached recommendations without mutating cache or calling provider', async () => {
  const { app, state } = fixture({ cached: true })
  const before = JSON.stringify(state.cached)
  const first = await request(app).get('/catalog/recommendations')
  state.profile = { medications: [SECRET], allergies: [], chronic_conditions: [] }
  const second = await request(app).get('/catalog/recommendations')
  expect(first.body.personal_safety.fields.medications).toBe('missing')
  expect(second.body.personal_safety.fields.medications).toBe('available')
  expect(second.body.personal_safety.fields.allergies).toBe('empty_unconfirmed')
  expect(second.body.personal_safety.status).toBe('not_assessed')
  expect(JSON.stringify(state.cached)).toBe(before)
  expect(state.writes).toEqual([])
  expect(callGemini).not.toHaveBeenCalled()
})

it.each([false, true])('profile read failure remains explicit and preserves fresh/cache=%s educational payload', async cached => {
  const { app } = fixture({ cached, profileError: true })
  const res = await request(app).get('/catalog/recommendations')
  expect(res.status).toBe(200)
  expect(res.body.recommendations).toEqual([])
  expect(res.body.personal_safety).toMatchObject({ status: 'not_assessed', reasons: expect.arrayContaining(['profile_unavailable']) })
  expect(JSON.stringify(res.body)).not.toContain(SECRET)
})

it('generation failure is not cached and is never safety assessed', async () => {
  callGemini.mockRejectedValue(new Error('mock provider unavailable'))
  const { app, state } = fixture()
  const res = await request(app).get('/catalog/recommendations')
  expect(res.body.errors).toEqual(['mock provider unavailable'])
  expect(res.body.personal_safety.status).toBe('not_assessed')
  expect(state.writes).toEqual([])
})

it.each([
  ['get', '/catalog/recommendations', { cacheError: true }, 500],
  ['post', '/catalog/recommendations/refresh', { cacheError: true }, 500],
  ['post', '/catalog/recommendations/refresh', { cached: true, capped: true }, 429],
  ['post', '/catalog/recommendations/refresh', {}, 200],
] as const)('%s %s status %j retains explicit safety status', async (method, path, options, code) => {
  const { app } = fixture(options)
  const res = await request(app)[method](path)
  expect(res.status).toBe(code)
  expect(res.body.personal_safety.status).toBe('not_assessed')
})

it.each([[], 'invalid profile', 5])('invalid profile root %j does not become confirmed absence', async profile => {
  const { app } = fixture({ cached: true, profile })
  const res = await request(app).get('/catalog/recommendations')
  expect(res.body.personal_safety).toMatchObject({ status: 'not_assessed', reasons: expect.arrayContaining(['profile_invalid']) })
})
