/**
 * #1489 (stage E of #1485, design E6): ROUTE-LEVEL test for
 * GET /api/catalog/stack-check. Drives the REAL router via supertest against
 * a fake in-memory db — same convention as
 * supplement_catalog_knowledge_cycle_1487.test.ts's makeDB (mirrors
 * findOne/findOneAndUpdate/find semantics closely enough for this route's
 * read-only usage).
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const buildRouter = require('../../routes/supplement_stack')

type Doc = Record<string, any>

function makeDB(seed: { catalog?: Doc[]; cycles?: Doc[]; knowledge?: Doc[] } = {}) {
  const catalog = (seed.catalog || []).map((d) => ({ ...d }))
  const cycles = (seed.cycles || []).map((d) => ({ ...d }))
  const knowledge = (seed.knowledge || []).map((d) => ({ ...d }))

  function col(list: Doc[]) {
    return {
      find(filter: Doc = {}) {
        const keys = Object.keys(filter)
        const out = keys.length === 0 ? list.slice() : list.filter((d) => keys.every((k) => d[k] === filter[k]))
        return { toArray: async () => out.map((d) => ({ ...d })) }
      },
    }
  }

  return {
    collection(name: string) {
      if (name === 'supplement_catalog') return col(catalog)
      if (name === 'supplement_cycles') return col(cycles)
      if (name === 'supplement_knowledge') return col(knowledge)
      throw new Error(`unexpected collection: ${name}`)
    },
  }
}

function buildApp(db: ReturnType<typeof makeDB>) {
  const app = express()
  app.use(express.json())
  app.use('/api/catalog', buildRouter(() => db))
  return app
}

describe('GET /api/catalog/stack-check', () => {
  it('200 with {date, stock, nutrients, interactions} on a populated fixture DB', async () => {
    const db = makeDB({
      catalog: [
        { id: 1, name: 'GymBeam Vitamin D3', short_name: 'Vitamin D3', schedule: 'morning', active: true, stock_anchor_date: '2026-09-12', stock_anchor_count: 30 },
        { id: 8, name: 'VPLab ZMA', short_name: 'ZMA', schedule: 'evening', active: true },
        { id: 9, name: 'Archived item', schedule: 'morning', active: false },
      ],
      knowledge: [
        { catalog_id: 1, active_ingredients: [{ name: 'Vitamin D3', amount_per_dose: 2000, unit: 'IU' }] },
        { catalog_id: 8, active_ingredients: [{ name: 'Zinc (aspartate)', amount_per_dose: 30, unit: 'mg' }, { name: 'Magnesium (aspartate)', amount_per_dose: 450, unit: 'mg' }] },
      ],
      cycles: [],
    })
    const res = await request(buildApp(db)).get('/api/catalog/stack-check')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('date')
    expect(Array.isArray(res.body.stock)).toBe(true)
    expect(Array.isArray(res.body.nutrients)).toBe(true)
    expect(Array.isArray(res.body.interactions)).toBe(true)
  })

  it('only includes ACTIVE items in stock/nutrients (archived item id 9 excluded)', async () => {
    const db = makeDB({
      catalog: [
        { id: 1, name: 'Active', schedule: 'morning', active: true },
        { id: 9, name: 'Archived', schedule: 'morning', active: false },
      ],
      knowledge: [],
      cycles: [],
    })
    const res = await request(buildApp(db)).get('/api/catalog/stack-check')
    const ids = res.body.stock.map((s: any) => s.catalog_id)
    expect(ids).toContain(1)
    expect(ids).not.toContain(9)
  })

  it('an item with no anchor/stock_remaining reports remaining:null (not a crash)', async () => {
    const db = makeDB({ catalog: [{ id: 19, name: 'Vitamin C 500mg', short_name: 'Vitamin C 500mg', schedule: 'morning', active: true }] })
    const res = await request(buildApp(db)).get('/api/catalog/stack-check')
    expect(res.status).toBe(200)
    const row = res.body.stock.find((s: any) => s.catalog_id === 19)
    expect(row.remaining).toBeNull()
  })

  it('picks the most-recently-started cycle per supplement_id (a restart supersedes the old cycle)', async () => {
    const db = makeDB({
      catalog: [{ id: 3, name: 'Creatine', schedule: 'morning', active: true, stock_anchor_date: '2026-01-01', stock_anchor_count: 1000, servings_per_day: 1 }],
      cycles: [
        { id: 1, supplement_id: 3, start_date: '2026-01-01', duration_weeks: 1, pause_weeks: 0, status: 'completed' },
        { id: 2, supplement_id: 3, start_date: '2026-06-01', duration_weeks: 52, pause_weeks: 0, status: 'active' },
      ],
    })
    const res = await request(buildApp(db)).get('/api/catalog/stack-check')
    // The old (Jan) cycle would already be long "completed" by date math too, but
    // if the wrong (older) cycle were picked, dateStatus would resolve to
    // 'completed' from ~2026-01-08 onward -> remaining would equal the full
    // anchor count (no consumption). The June cycle is still active -> stock
    // SHOULD have decremented since 2026-01-01. This proves the June cycle won,
    // not the January one.
    const row = res.body.stock.find((s: any) => s.catalog_id === 3)
    expect(row.remaining).toBeLessThan(1000)
  })

  it('live-shape smoke: reproduces the 22.09 measured live stack (id1 D3, id8 ZMA zinc under UL, 0 interactions)', async () => {
    const db = makeDB({
      catalog: [
        { id: 1, name: 'GymBeam Vitamin D3', short_name: 'Vitamin D3', schedule: 'morning', active: true },
        { id: 8, name: 'VPLab ZMA', short_name: 'ZMA', schedule: 'evening', active: true },
      ],
      knowledge: [
        { catalog_id: 1, active_ingredients: [{ name: 'Vitamin D3', amount_per_dose: 2000, unit: 'IU' }] },
        { catalog_id: 8, active_ingredients: [{ name: 'Zinc (aspartate)', amount_per_dose: 30, unit: 'mg' }, { name: 'Magnesium (aspartate)', amount_per_dose: 450, unit: 'mg' }, { name: 'Vitamin B6', amount_per_dose: 10.5, unit: 'mg' }] },
      ],
    })
    const res = await request(buildApp(db)).get('/api/catalog/stack-check')
    expect(res.body.interactions).toEqual([])
    const zinc = res.body.nutrients.find((n: any) => n.nutrient_key === 'zinc')
    expect(zinc.total).toBe(30)
    expect(zinc.over_ul).toBe(false)
  })
})
