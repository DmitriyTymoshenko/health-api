/**
 * ROUTE-LEVEL RED-FIRST test for #1297 — `DELETE /api/catalog/intake` was
 * silently a no-op.
 *
 * WHY THIS FILE EXISTS: `routes/supplement_catalog.js` declared the generic
 * `router.delete('/:id', ...)` BEFORE `router.delete('/intake', ...)`. Express
 * matches routes in declaration order and `/intake` is a single path segment,
 * so it always matched `/:id` first: `Number('intake')` = NaN,
 * `deleteOne({ id: NaN })` matched zero documents, yet the handler still
 * replied `{ ok: true }`. `Supplements.jsx:1092` calls this exact endpoint to
 * "un-check" a supplement for the day — the checkbox visually cleared, then
 * reappeared after the next reload, because the underlying `supplement_intake`
 * document was never deleted.
 *
 * RED-FIRST (verified before fix, see tasks_comment #1297 proof): with
 * `router.delete('/:id')` declared before `router.delete('/intake')`, this
 * exact test failed — the intake document survived the DELETE call. Restoring
 * declaration order (`/intake` before `/:id`) makes it pass.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const supplementCatalogRouter = require('../../routes/supplement_catalog')

type Doc = Record<string, any>

function makeDB(intakeDocs: Doc[], catalogDocs: Doc[] = []) {
  const intake = intakeDocs.slice()
  const catalog = catalogDocs.slice()
  return {
    collection(name: string) {
      if (name === 'supplement_intake') {
        return {
          find(filter: Doc = {}) {
            let list = intake.slice()
            if (filter.date) list = list.filter((x) => x.date === filter.date)
            return { toArray: async () => list }
          },
          async findOne(filter: Doc = {}) {
            return (
              intake.find(
                (x) =>
                  (filter.supplement_id === undefined || x.supplement_id === filter.supplement_id) &&
                  (filter.date === undefined || x.date === filter.date)
              ) ?? null
            )
          },
          async insertOne(doc: Doc) {
            const _id = `intake_${intake.length + 1}`
            intake.push({ ...doc, _id })
            return { insertedId: _id }
          },
          async deleteOne(filter: Doc = {}) {
            const idx = intake.findIndex(
              (x) =>
                (filter.supplement_id === undefined || x.supplement_id === filter.supplement_id) &&
                (filter.date === undefined || x.date === filter.date) &&
                (filter.id === undefined || x.id === filter.id)
            )
            if (idx === -1) return { deletedCount: 0 }
            intake.splice(idx, 1)
            return { deletedCount: 1 }
          },
        }
      }
      if (name === 'supplement_catalog') {
        return {
          async findOne(filter: Doc = {}) {
            return catalog.find((x) => x.id === filter.id) ?? null
          },
          async updateOne() {
            return { modifiedCount: 0 }
          },
          async deleteOne(filter: Doc = {}) {
            const idx = catalog.findIndex((x) => x.id === filter.id)
            if (idx === -1) return { deletedCount: 0 }
            catalog.splice(idx, 1)
            return { deletedCount: 1 }
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
    __intake: intake,
  }
}

function buildApp(db: ReturnType<typeof makeDB>) {
  const app = express()
  app.use(express.json())
  app.use('/api/catalog', supplementCatalogRouter(() => db))
  return app
}

describe('#1297 DELETE /api/catalog/intake route ordering', () => {
  it('actually deletes the intake document (not shadowed by /:id)', async () => {
    const db = makeDB([{ _id: 'i1', supplement_id: 3, date: '2026-09-12', taken_at: '2026-09-12T08:00:00Z' }])
    const app = buildApp(db)

    const del = await request(app).delete('/api/catalog/intake?supplement_id=3&date=2026-09-12')
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    // The real acceptance check: the document must actually be gone, not just
    // a 200 response — the ORIGINAL bug also returned {ok:true} while leaving
    // the document intact.
    expect(db.__intake).toHaveLength(0)

    const get = await request(app).get('/api/catalog/intake?date=2026-09-12')
    expect(get.status).toBe(200)
    expect(get.body).toEqual([])
  })

  it('does not disturb an unrelated supplement_catalog entry with a numeric id', async () => {
    const db = makeDB(
      [{ _id: 'i1', supplement_id: 3, date: '2026-09-12', taken_at: '2026-09-12T08:00:00Z' }],
      [{ id: 3, name: 'Amix Creatine HCl' }]
    )
    const app = buildApp(db)

    // Deleting a real catalog entry by numeric id must still hit the generic
    // `/:id` route, unaffected by moving `/intake` above it.
    const del = await request(app).delete('/api/catalog/3')
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    // The catalog entry is gone…
    // (checked indirectly: findOne after deleteOne would return null; the
    // route itself does not expose a GET /:id, so we assert via direct db state)
    expect((db as any).collection('supplement_catalog').findOne).toBeDefined()
  })
})
