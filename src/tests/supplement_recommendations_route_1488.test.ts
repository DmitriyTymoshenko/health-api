/**
 * ROUTE-LEVEL tests for GET/POST /api/catalog/recommendations(/refresh)
 * (#1488, stage C of #1485, acceptance C1/C3). Mocks global.fetch (Gemini)
 * — same convention as nutrition_recognize.test.ts's route-level suite —
 * and uses an in-memory mock db, same convention as
 * supplement_catalog_knowledge_cycle_1487.test.ts.
 */
import request from 'supertest'
import express from 'express'

type Doc = Record<string, any>

function makeDB(seed: { catalog?: Doc[]; knowledge?: Doc[]; labs?: Doc[]; metrics?: Doc[]; recs?: Doc[] } = {}) {
  const catalog = (seed.catalog || []).map(d => ({ ...d }))
  const knowledge = (seed.knowledge || []).map(d => ({ ...d }))
  const labs = (seed.labs || []).map(d => ({ ...d }))
  const metrics = (seed.metrics || []).map(d => ({ ...d }))
  const recs = (seed.recs || []).map(d => ({ ...d }))

  function col(list: Doc[]) {
    return {
      find(filter: Doc = {}) {
        let out = list.slice()
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && '$ne' in (v as Doc)) {
            out = out.filter(d => d[k] !== (v as Doc).$ne)
          } else {
            out = out.filter(d => d[k] === v)
          }
        }
        return {
          toArray: async () => out.map(d => ({ ...d })),
          sort: () => ({
            toArray: async () => out.map(d => ({ ...d })),
            limit: (n: number) => ({ toArray: async () => out.slice(0, n).map(d => ({ ...d })) }),
          }),
        }
      },
      async findOne(filter: Doc = {}) {
        const found = list.find(d => Object.entries(filter).every(([k, v]) => d[k] === v))
        return found ? { ...found } : null
      },
      async updateOne(filter: Doc, update: Doc, opts: Doc = {}) {
        let doc = list.find(d => Object.entries(filter).every(([k, v]) => d[k] === v))
        if (!doc) {
          if (!opts.upsert) return { matchedCount: 0 }
          doc = { ...filter }
          list.push(doc)
        }
        Object.assign(doc, update.$set || {})
        return { matchedCount: 1 }
      },
    }
  }

  return {
    collection(name: string) {
      if (name === 'supplement_catalog') return col(catalog)
      if (name === 'supplement_knowledge') return col(knowledge)
      if (name === 'lab_results') return col(labs)
      if (name === 'daily_metrics') return col(metrics)
      if (name === 'supplement_recommendations') return col(recs)
      throw new Error(`unexpected collection: ${name}`)
    },
    _recs: recs,
  }
}

function buildApp(db: ReturnType<typeof makeDB>) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const buildRouter = require('../../routes/supplement_catalog')
  const app = express()
  app.use(express.json())
  app.use('/api/catalog', buildRouter(() => db))
  return app
}

const ACTIVE_STACK = [
  { id: 1, name: 'Amix Creatine HCl', short_name: 'Creatine HCl', schedule: 'morning', dose: '3г', active: true },
  { id: 2, name: 'GymBeam Vitamin D3', short_name: 'Vitamin D3', schedule: 'morning', dose: '2000 IU', active: true },
  { id: 3, name: 'GymBeam Omega 3', short_name: 'Omega 3', schedule: 'morning', dose: '2 капс', active: true },
  { id: 4, name: 'VPLab ZMA', short_name: 'ZMA', schedule: 'evening', dose: '3 капс', active: true },
]
const KNOWLEDGE = [
  { catalog_id: 1, continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } },
  { catalog_id: 2, continuous: true, cycle: null },
]
const LABS = [
  { date: '2026-09-10', source: 'pdf', values: { ferritin: 45 } }, // age_days ~12 from 2026-09-22
  { date: '2026-08-08', source: 'pdf', values: { vitamin_d: 50 } }, // age_days ~45 — stale
]

function mockGeminiFetch(items: any[]) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items }) }] } }],
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 80, totalTokenCount: 580 },
    }),
  })) as unknown as typeof fetch
}

const ORIGINAL_ENV = process.env
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
  jest.setSystemTime(new Date('2026-09-22T10:00:00Z'))
  process.env = { ...ORIGINAL_ENV, GOOGLE_AI_API_KEY: 'test-key' }
})
afterEach(() => {
  jest.useRealTimers()
  process.env = ORIGINAL_ENV
})

describe('GET /api/catalog/recommendations — C1', () => {
  it('a mocked Gemini response with a fresh-lab item + a stale vitamin_d item -> stale one goes to warnings, not recommendations', async () => {
    mockGeminiFetch([
      { key: 'iron', name: 'Iron Bisglycinate', reason: 'ferritin normal but could use support', source: 'lab', lab_marker: 'ferritin', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/iron' }, suggested_dose: '25mg', suggested_schedule: 'morning', continuous: true },
      { key: 'vitd', name: 'Vitamin D3 boost', reason: 'low vitamin D', source: 'lab', lab_marker: 'vitamin_d', verdict: { kind: 'confirms', by: 'external', ref: 'https://examine.com/vitamin-d' }, suggested_dose: '4000 IU', suggested_schedule: 'morning', continuous: true },
    ])
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: LABS })
    const res = await request(buildApp(db)).get('/api/catalog/recommendations')

    expect(res.status).toBe(200)
    expect(res.body.recommendations.length).toBeGreaterThanOrEqual(1)
    expect(res.body.recommendations.find((r: any) => r.name === 'Vitamin D3 boost')).toBeUndefined()
    expect(res.body.recommendations.find((r: any) => r.name === 'Iron Bisglycinate')).toBeTruthy()
    const staleWarning = res.body.warnings.find((w: any) => w.type === 'stale_lab')
    expect(staleWarning).toMatchObject({ marker: 'vitamin_d' })
    expect(res.body.recommendations[0].verdict.by).toBeTruthy()
    expect(res.body.recommendations[0].verdict.ref).toBeTruthy()
  })

  it('every recommendation carries verdict.by and verdict.ref', async () => {
    mockGeminiFetch([
      { key: 'mg', name: 'Magnesium Glycinate', reason: 'sleep support', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/magnesium' }, suggested_dose: '400mg', suggested_schedule: 'evening', continuous: true },
    ])
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: [] })
    const res = await request(buildApp(db)).get('/api/catalog/recommendations')
    for (const rec of res.body.recommendations) {
      expect(rec.verdict.by).toBeTruthy()
      expect(rec.verdict.ref).toBeTruthy()
    }
  })
})

describe('GET /api/catalog/recommendations — C3 cache behaviour', () => {
  it('two GETs on the same Kyiv day call Gemini exactly ONCE (second GET is served from cache)', async () => {
    mockGeminiFetch([])
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: [] })
    const app = buildApp(db)
    await request(app).get('/api/catalog/recommendations')
    await request(app).get('/api/catalog/recommendations')
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1)
  })

  it('a Gemini failure returns 200 with recommendations:[] + errors, and does NOT cache the doc', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' })) as unknown as typeof fetch
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: [] })
    const res = await request(buildApp(db)).get('/api/catalog/recommendations')
    expect(res.status).toBe(200)
    expect(res.body.recommendations).toEqual([])
    expect(res.body.errors.length).toBeGreaterThan(0)
    expect(db._recs).toHaveLength(0)
  })

  it('missing GOOGLE_AI_API_KEY returns 200 with an error, no crash', async () => {
    delete process.env.GOOGLE_AI_API_KEY
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: [] })
    const res = await request(buildApp(db)).get('/api/catalog/recommendations')
    expect(res.status).toBe(200)
    expect(res.body.errors[0]).toContain('GOOGLE_AI_API_KEY')
  })
})

describe('POST /api/catalog/recommendations/refresh — C3 cap', () => {
  it('the 6th refresh call in one day returns 429, the first 5 succeed', async () => {
    mockGeminiFetch([])
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: [] })
    const app = buildApp(db)
    await request(app).get('/api/catalog/recommendations') // refresh_count stays 0

    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/catalog/recommendations/refresh').send({})
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })

  it('refresh calls Gemini again (does not reuse the GET cache) each successful time', async () => {
    mockGeminiFetch([])
    const db = makeDB({ catalog: ACTIVE_STACK, knowledge: KNOWLEDGE, labs: [] })
    const app = buildApp(db)
    await request(app).get('/api/catalog/recommendations')
    await request(app).post('/api/catalog/recommendations/refresh').send({})
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2)
  })
})

export {}
