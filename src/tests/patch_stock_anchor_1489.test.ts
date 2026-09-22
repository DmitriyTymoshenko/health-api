/**
 * #1489 (stage E of #1485, design E2): the one `routes/supplement_catalog.js`
 * edit this stage makes — PATCH /:id/stock now also writes
 * stock_anchor_date/stock_anchor_count. Separate test file (not touching
 * supplement_catalog_knowledge_cycle_1487.test.ts, which is #1487/Lucas's
 * concurrent stage's file) — same makeDB convention, only the `catalog`
 * collection is needed here.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const buildRouter = require('../../routes/supplement_catalog')

type Doc = Record<string, any>

function makeDB(seed: { catalog?: Doc[] } = {}) {
  const catalog = (seed.catalog || []).map((d) => ({ ...d }))

  function col(list: Doc[]) {
    return {
      async findOneAndUpdate(filter: Doc, update: Doc, opts: Doc = {}) {
        const existing = list.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
        if (!existing) return null
        Object.assign(existing, update.$set || {})
        return { ...existing }
      },
    }
  }

  return {
    collection(name: string) {
      if (name === 'supplement_catalog') return col(catalog)
      throw new Error(`unexpected collection in this test: ${name}`)
    },
  }
}

function buildApp(db: ReturnType<typeof makeDB>) {
  const app = express()
  app.use(express.json())
  app.use('/api/catalog', buildRouter(() => db))
  return app
}

describe('PATCH /api/catalog/:id/stock — E2 anchor write', () => {
  it('writes stock_anchor_date (today, Kyiv) and stock_anchor_count = the sent stock_remaining', async () => {
    const db = makeDB({ catalog: [{ id: 13, name: 'Ashwagandha', stock_remaining: 60, stock_count: 60 }] })
    const res = await request(buildApp(db)).patch('/api/catalog/13/stock').send({ stock_remaining: 45 })
    expect(res.status).toBe(200)
    expect(res.body.stock_remaining).toBe(45)
    expect(res.body.stock_anchor_count).toBe(45)
    expect(res.body.stock_anchor_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('anchor_count follows stock_count when that field is the one sent instead', async () => {
    const db = makeDB({ catalog: [{ id: 13, name: 'Ashwagandha' }] })
    const res = await request(buildApp(db)).patch('/api/catalog/13/stock').send({ stock_count: 60 })
    expect(res.status).toBe(200)
    expect(res.body.stock_anchor_count).toBe(60)
  })

  it('still 400s when neither field is sent (unchanged pre-existing behaviour)', async () => {
    const db = makeDB({ catalog: [{ id: 13, name: 'Ashwagandha' }] })
    const res = await request(buildApp(db)).patch('/api/catalog/13/stock').send({})
    expect(res.status).toBe(400)
  })

  it('404 for an unknown id (unchanged pre-existing behaviour)', async () => {
    const db = makeDB({ catalog: [] })
    const res = await request(buildApp(db)).patch('/api/catalog/999/stock').send({ stock_remaining: 10 })
    expect(res.status).toBe(404)
  })
})
