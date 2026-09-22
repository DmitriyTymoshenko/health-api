/**
 * ROUTE-LEVEL tests for the #1487 (stage B of #1485) additions to
 * routes/supplement_catalog.js: POST /catalog knowledge+autocycle wiring
 * (D6), PUT /:id reactivation autocycle (D6), GET /cycles computed fields
 * (D7), POST /cycles/:id/restart (D7), PUT /knowledge/:id invariant gate
 * (D3/D4). Uses an in-memory mock db, same convention as
 * supplement_catalog_intake_delete_1297.test.ts (deleted in stage A) and
 * cycle-notify.test.ts's makeDB.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const buildRouter = require('../../routes/supplement_catalog')

type Doc = Record<string, any>

function makeDB(seed: { catalog?: Doc[]; cycles?: Doc[]; knowledge?: Doc[] } = {}) {
  const catalog = (seed.catalog || []).map(d => ({ ...d }))
  const cycles = (seed.cycles || []).map(d => ({ ...d }))
  const knowledge = (seed.knowledge || []).map(d => ({ ...d }))

  function col(list: Doc[], key = 'id', matchKey = key) {
    return {
      async countDocuments() { return list.length },
      async insertMany(docs: Doc[]) { list.push(...docs.map(d => ({ ...d }))); return {} },
      find(filter: Doc = {}) {
        let out = list.slice()
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && '$in' in (v as Doc)) {
            out = out.filter(d => (v as Doc).$in.includes(d[k]))
          } else {
            out = out.filter(d => d[k] === v)
          }
        }
        return { toArray: async () => out.map(d => ({ ...d })), sort: () => ({ toArray: async () => out.map(d => ({ ...d })) }) }
      },
      async findOne(filter: Doc = {}, opts: Doc = {}) {
        if (opts.sort) {
          const sorted = [...list].sort((a, b) => (b[matchKey] || 0) - (a[matchKey] || 0))
          return sorted[0] ? { ...sorted[0] } : null
        }
        const found = list.find(d => Object.entries(filter).every(([k, v]) => d[k] === v))
        return found ? { ...found } : null
      },
      async insertOne(doc: Doc) { list.push({ ...doc }); return { insertedId: 'mock' } },
      async updateOne(filter: Doc, update: Doc) {
        const doc = list.find(d => Object.entries(filter).every(([k, v]) => d[k] === v))
        if (!doc) return { matchedCount: 0 }
        Object.assign(doc, update.$set || {})
        return { matchedCount: 1 }
      },
      async findOneAndUpdate(filter: Doc, update: Doc, opts: Doc = {}) {
        const existing = list.find(d => Object.entries(filter).every(([k, v]) => d[k] === v))
        if (!existing) {
          if (!opts.upsert) return null
          const created: Doc = { ...filter, ...(update.$set || {}) }
          list.push(created)
          return { ...created }
        }
        Object.assign(existing, update.$set || {})
        return { ...existing }
      },
      async deleteOne(filter: Doc) {
        const idx = list.findIndex(d => Object.entries(filter).every(([k, v]) => d[k] === v))
        if (idx === -1) return { deletedCount: 0 }
        list.splice(idx, 1)
        return { deletedCount: 1 }
      },
    }
  }

  return {
    collection(name: string) {
      if (name === 'supplement_catalog') return col(catalog)
      if (name === 'supplement_cycles') return col(cycles)
      if (name === 'supplement_knowledge') return col(knowledge, 'catalog_id')
      throw new Error(`unexpected collection: ${name}`)
    },
    _catalog: catalog,
    _cycles: cycles,
    _knowledge: knowledge,
  }
}

function buildApp(db: ReturnType<typeof makeDB>) {
  const app = express()
  app.use(express.json())
  app.use('/api/catalog', buildRouter(() => db))
  return app
}

describe('POST /api/catalog — D6 knowledge + autocycle wiring', () => {
  it('a request with no knowledge field creates the item, knowledge/cycle are both null (backward compatible)', async () => {
    const db = makeDB({ catalog: [{ id: 1, name: 'Existing' }] })
    const res = await request(buildApp(db)).post('/api/catalog').send({ short_name: 'New Item', name: 'New Item', schedule: 'morning' })
    expect(res.status).toBe(201)
    expect(res.body.item).toMatchObject({ id: 2, name: 'New Item', active: true })
    expect(res.body.knowledge).toBeNull()
    expect(res.body.cycle).toBeNull()
  })

  it('continuous:true, cycle:null creates knowledge but NO auto-cycle', async () => {
    const db = makeDB()
    const res = await request(buildApp(db))
      .post('/api/catalog')
      .send({ short_name: 'Vitamin C', name: 'Vitamin C', schedule: 'morning', knowledge: { continuous: true, cycle: null } })
    expect(res.status).toBe(201)
    expect(res.body.knowledge).toMatchObject({ continuous: true, cycle: null, catalog_id: 1 })
    expect(res.body.cycle).toBeNull()
    expect(db._cycles).toHaveLength(0)
  })

  it('continuous:false with a cycle creates exactly 1 supplement_cycles doc with start_date=today', async () => {
    const db = makeDB()
    const res = await request(buildApp(db))
      .post('/api/catalog')
      .send({ short_name: 'Ashwagandha', name: 'Ashwagandha', schedule: 'evening', knowledge: { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } } })
    expect(res.status).toBe(201)
    expect(db._cycles).toHaveLength(1)
    expect(res.body.cycle).toMatchObject({ supplement_id: 1, duration_weeks: 8, pause_weeks: 4, status: 'active', created_by: 'auto' })
  })

  it('a repeated POST-with-knowledge for the SAME new id is impossible (each POST gets a new id) — but the SAME supplement_id+day dedupe is proven at the lib level (supplement-autocycle.test.ts); here we prove the invariant gate fires BEFORE any cycle is created', async () => {
    const db = makeDB()
    const res = await request(buildApp(db))
      .post('/api/catalog')
      .send({ short_name: 'Bad', name: 'Bad', schedule: 'morning', knowledge: { continuous: true, cycle: { duration_weeks: 8 } } })
    expect(res.status).toBe(201)
    expect(res.body.cycle_error).toBeTruthy()
    expect(res.body.cycle).toBeNull()
    // Item itself was still created — D6's explicit failure-path.
    expect(res.body.item).toMatchObject({ id: 1, active: true })
    expect(db._cycles).toHaveLength(0)
  })
})

describe('PUT /api/catalog/:id — D6 reactivation autocycle', () => {
  it('active:false -> active:true with a knowledge.cycle creates a new auto-cycle', async () => {
    const db = makeDB({
      catalog: [{ id: 9, name: 'Asian Ginseng', active: false }],
      knowledge: [{ catalog_id: 9, continuous: false, cycle: { duration_weeks: 6, pause_weeks: 2 } }],
    })
    const res = await request(buildApp(db)).put('/api/catalog/9').send({ active: true })
    expect(res.status).toBe(200)
    expect(res.body.active).toBe(true)
    expect(res.body.cycle).toMatchObject({ supplement_id: 9, duration_weeks: 6, pause_weeks: 2 })
    expect(db._cycles).toHaveLength(1)
  })

  it('a plain edit (not a reactivation) never touches cycles', async () => {
    const db = makeDB({
      catalog: [{ id: 1, name: 'X', active: true, dose: 'old' }],
      knowledge: [{ catalog_id: 1, continuous: false, cycle: { duration_weeks: 4, pause_weeks: 0 } }],
    })
    const res = await request(buildApp(db)).put('/api/catalog/1').send({ dose: 'new dose' })
    expect(res.status).toBe(200)
    expect(res.body.dose).toBe('new dose')
    expect(res.body.cycle).toBeUndefined()
    expect(db._cycles).toHaveLength(0)
  })

  it('reactivating a supplement whose knowledge is continuous (cycle:null) creates no cycle', async () => {
    const db = makeDB({
      catalog: [{ id: 9, name: 'Vitamin C', active: false }],
      knowledge: [{ catalog_id: 9, continuous: true, cycle: null }],
    })
    const res = await request(buildApp(db)).put('/api/catalog/9').send({ active: true })
    expect(res.status).toBe(200)
    expect(res.body.cycle).toBeNull()
    expect(db._cycles).toHaveLength(0)
  })

  it('reactivating a double-click (same day) only creates ONE cycle (dedupe via ensureAutoCycleForSupplement)', async () => {
    const db = makeDB({
      catalog: [{ id: 9, name: 'X', active: false }],
      knowledge: [{ catalog_id: 9, continuous: false, cycle: { duration_weeks: 4, pause_weeks: 0 } }],
    })
    const app = buildApp(db)
    await request(app).put('/api/catalog/9').send({ active: true })
    // Second PUT toggles active:false->true AGAIN on the same (already-active) doc:
    // simulate by flipping to false first then true again, same "today".
    db._catalog[0].active = false
    await request(app).put('/api/catalog/9').send({ active: true })
    expect(db._cycles).toHaveLength(1)
  })
})

describe('GET /api/catalog/cycles — D7 computed fields', () => {
  it('every cycle carries computed_status/active_end/pause_end', async () => {
    const db = makeDB({
      cycles: [{ id: 1, supplement_id: 1, supplement_name: 'Creatine HCl', start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 4, status: 'active' }],
    })
    const res = await request(buildApp(db)).get('/api/catalog/cycles')
    expect(res.status).toBe(200)
    expect(res.body[0]).toMatchObject({ active_end: '2026-08-05', pause_end: '2026-09-02' })
    expect(['active', 'pause', 'completed']).toContain(res.body[0].computed_status)
  })
})

describe('POST /api/catalog/cycles/:id/restart — D7', () => {
  it('marks the old cycle completed and creates a new active cycle from today, same duration/pause', async () => {
    const db = makeDB({
      cycles: [{ id: 1, supplement_id: 3, supplement_name: 'Creatine HCl', start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 4, status: 'active' }],
    })
    const res = await request(buildApp(db)).post('/api/catalog/cycles/1/restart').send({})
    expect(res.status).toBe(201)
    expect(db._cycles.find((c: Doc) => c.id === 1)?.status).toBe('completed')
    const newCycle = db._cycles.find((c: Doc) => c.id === 2)
    expect(newCycle).toMatchObject({ supplement_id: 3, duration_weeks: 8, pause_weeks: 4, status: 'active', created_by: 'restart' })
  })

  it('knowledge.cycle overrides the old cycle duration/pause when present', async () => {
    const db = makeDB({
      cycles: [{ id: 1, supplement_id: 3, supplement_name: 'Creatine HCl', start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 4, status: 'active' }],
      knowledge: [{ catalog_id: 3, continuous: false, cycle: { duration_weeks: 10, pause_weeks: 2 } }],
    })
    const res = await request(buildApp(db)).post('/api/catalog/cycles/1/restart').send({})
    expect(res.status).toBe(201)
    expect(res.body.cycle).toMatchObject({ duration_weeks: 10, pause_weeks: 2 })
  })

  it('404s on a nonexistent cycle id', async () => {
    const db = makeDB()
    const res = await request(buildApp(db)).post('/api/catalog/cycles/999/restart').send({})
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/catalog/knowledge/:id — D3/D4 invariant gate', () => {
  it('400s on continuous:true + non-null cycle, does not write to Mongo', async () => {
    const db = makeDB()
    const res = await request(buildApp(db)).put('/api/catalog/knowledge/1').send({ continuous: true, cycle: { duration_weeks: 4 } })
    expect(res.status).toBe(400)
    expect(db._knowledge).toHaveLength(0)
  })

  it('400s on continuous:false + cycle:null', async () => {
    const db = makeDB()
    const res = await request(buildApp(db)).put('/api/catalog/knowledge/1').send({ continuous: false, cycle: null })
    expect(res.status).toBe(400)
  })

  it('a valid body still upserts as before', async () => {
    const db = makeDB()
    const res = await request(buildApp(db)).put('/api/catalog/knowledge/1').send({ continuous: true, cycle: null, purchase_url: 'https://examine.com/x' })
    expect(res.status).toBe(200)
    expect(db._knowledge).toHaveLength(1)
  })

  it('a body that does not mention continuous/cycle at all still passes through (e.g. purchase_url-only update)', async () => {
    const db = makeDB({ knowledge: [{ catalog_id: 1, continuous: true, cycle: null }] })
    const res = await request(buildApp(db)).put('/api/catalog/knowledge/1').send({ purchase_url: 'https://examine.com/y' })
    expect(res.status).toBe(200)
    expect(res.body.purchase_url).toBe('https://examine.com/y')
  })
})

export {}
