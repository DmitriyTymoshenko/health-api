/**
 * ROUTE-LEVEL RED-FIRST test for #1297 — `weight_log` gets a unique index on
 * `date` (see `scripts/dedupe-weight-log-1297.js`), which turns a second
 * `POST /api/weight` for the SAME date into a raw Mongo E11000 duplicate-key
 * error UNLESS the route itself becomes upsert-based. A 500 on a plain
 * "log today's weight again" action (e.g. a correction) would be a strictly
 * WORSE user experience than the silent duplicate this fix set out to close.
 *
 * ACCEPTANCE (task #1297, criterion e-adjacent): two POSTs to `/api/weight`
 * for the same date must produce exactly ONE stored document (latest value
 * wins — matches the dedup script's own "keep the newest" rule) and neither
 * response may be a 5xx.
 *
 * RED-FIRST (verified before commit): with `routes/weight.js`'s ORIGINAL
 * `insertOne(doc)`, a stub DB that rejects a second insert on the same date
 * with a duplicate-key-shaped error (mirroring what a real unique index does)
 * makes the second POST 500. Switching to `findOneAndUpdate(..., {upsert:
 * true})` makes the second POST 201 with the SAME `_id` and the new value.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const weightRouter = require('../../routes/weight')

type Doc = Record<string, any>

/**
 * Minimal `weight_log` stub that enforces uniqueness on `date` the same way a
 * real Mongo unique index would: `insertOne` on a date that already exists
 * throws (E11000-shaped), while `findOneAndUpdate` with `upsert: true`
 * replaces the existing document for that date instead of erroring.
 */
function makeUniqueDateCollection() {
  let docs: Doc[] = []
  let seq = 1
  return {
    async insertOne(doc: Doc) {
      if (docs.some((d) => d.date === doc.date)) {
        const err: any = new Error('E11000 duplicate key error collection: weight_log index: date_unique_1297')
        err.code = 11000
        throw err
      }
      const _id = `w${seq++}`
      docs.push({ ...doc, _id })
      return { insertedId: _id }
    },
    async findOneAndUpdate(filter: Doc, update: Doc, opts: Doc) {
      const idx = docs.findIndex((d) => d.date === filter.date)
      if (idx === -1) {
        if (!opts?.upsert) return null
        const _id = `w${seq++}`
        const doc = { ...update.$set, _id }
        docs.push(doc)
        return doc
      }
      docs[idx] = { ...docs[idx], ...update.$set }
      return docs[idx]
    },
    async find() {
      return { sort: () => ({ limit: () => ({ toArray: async () => docs.slice() }) }) }
    },
    __docs: () => docs,
  }
}

function buildApp(col: ReturnType<typeof makeUniqueDateCollection>) {
  const app = express()
  app.use(express.json())
  const getDB = () => ({ collection: () => col })
  app.use('/api/weight', weightRouter(getDB))
  return app
}

describe('#1297 POST /api/weight upserts by date instead of throwing on a repeat', () => {
  it('two POSTs for the same date produce ONE document, neither is a 5xx', async () => {
    const col = makeUniqueDateCollection()
    const app = buildApp(col)

    const first = await request(app).post('/api/weight').send({ date: '2026-09-12', weight_kg: 93.4 })
    expect(first.status).toBeLessThan(500)

    const second = await request(app).post('/api/weight').send({ date: '2026-09-12', weight_kg: 93.1 })
    expect(second.status).toBeLessThan(500)

    const docsForDate = col.__docs().filter((d) => d.date === '2026-09-12')
    expect(docsForDate).toHaveLength(1)
    expect(docsForDate[0].weight_kg).toBe(93.1) // latest submission wins
  })

  it('still rejects a body with no weight_kg (400, unaffected by the upsert change)', async () => {
    const col = makeUniqueDateCollection()
    const app = buildApp(col)
    const res = await request(app).post('/api/weight').send({ date: '2026-09-12' })
    expect(res.status).toBe(400)
  })
})
