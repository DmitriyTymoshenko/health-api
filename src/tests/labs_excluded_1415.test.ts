/**
 * #1415 (R9-дані, audit #1409 §2.7/§4): live route-level proof that GET /api/labs,
 * /api/labs/latest and /api/labs/reminders all skip a document flagged `excluded:true`
 * (the one-off Mongo mutation applied to `extra_res_50964.pdf`, a garbled duplicate PDF
 * parse — alt 184 vs the real 23, hba1c 1, free_t4 4). Route-level (supertest) against the
 * ACTUAL `routes/labs.js` code path, not a re-implemented mock of the filter logic.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const labsRoute = require('../../routes/labs')

function matchesExcludedFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true
  const excludedFilter = filter.excluded as { $ne?: unknown } | undefined
  if (excludedFilter && typeof excludedFilter === 'object' && '$ne' in excludedFilter) {
    return row.excluded !== excludedFilter.$ne
  }
  return true
}

function chain(rows: Array<Record<string, unknown>>) {
  return {
    sort() { return this },
    toArray: async () => rows,
  }
}

function makeApp(rows: Array<Record<string, unknown>>) {
  const db = {
    collection(name: string) {
      if (name !== 'lab_results') throw new Error(`unexpected collection ${name}`)
      return {
        find(filter: Record<string, unknown>) {
          return chain(rows.filter((r) => matchesExcludedFilter(r, filter)))
        },
      }
    },
  }
  const app = express()
  app.use('/api/labs', labsRoute(() => db))
  return app
}

// Mirrors the LIVE post-#1415 state: main_result.pdf (valid) + extra_res_50964.pdf
// (excluded:true after the #1415 mutation) for the same date, 2026-03-31.
const ROWS = [
  {
    _id: '69cbbb7762a7ccf460a0a995',
    date: '2026-03-31',
    values: { alt: 23, hba1c: null, testosterone: 11.8 },
    source: 'pdf',
    filename: 'main_result.pdf',
  },
  {
    _id: '69cbbc68203a8883cd33fc40',
    date: '2026-03-31',
    values: { alt: 184, hba1c: 1, free_t4: 4, testosterone: 11.8 },
    source: 'pdf',
    filename: 'extra_res_50964.pdf',
    excluded: true,
    excluded_reason: '#1409 R9: битий парсинг',
    parse_status: 'invalid',
  },
]

describe('GET /api/labs* — excluded:true document is skipped everywhere (#1415)', () => {
  it('GET /api/labs (Історія) never returns the excluded document', async () => {
    const app = makeApp(ROWS)
    const res = await request(app).get('/api/labs')
    expect(res.status).toBe(200)
    const filenames = res.body.map((d: any) => d.filename)
    expect(filenames).toContain('main_result.pdf')
    expect(filenames).not.toContain('extra_res_50964.pdf')
  })

  it('GET /api/labs/latest takes alt/hba1c/free_t4 from the valid document only', async () => {
    const app = makeApp(ROWS)
    const res = await request(app).get('/api/labs/latest')
    expect(res.status).toBe(200)
    expect(res.body.alt.value).toBe(23) // NOT 184 from the excluded doc
    expect(res.body.hba1c.value).toBeNull() // main_result.pdf's null, not the excluded doc's 1
    expect(res.body.free_t4).toBeUndefined() // only present on the excluded doc
  })

  it('GET /api/labs/reminders never anchors a biomarker date/value on the excluded document', async () => {
    const app = makeApp(ROWS)
    const res = await request(app).get('/api/labs/reminders')
    expect(res.status).toBe(200)
    const all = [...res.body.overdue, ...res.body.soon, ...res.body.upcoming]
    const alt = all.find((i: any) => i.key === 'alt')
    expect(alt).toBeDefined()
    expect(alt.lastValue).toBe(23) // sourced from main_result.pdf, not the excluded 184
  })
})

export {}
