/**
 * ROUTE-LEVEL test for POST /api/foods (#931).
 *
 * WHAT #931 FOUND: `router.post('/')` spreads `...req.body` into the document it inserts
 * into `foods_library` with NO validation that `name` is present. A body with no `name`
 * sails through `findOne({ name: { $regex: '^undefined$' } })` (matches nothing, since the
 * field is literally absent, not the string "undefined"), then `insertOne()`s a document
 * with no `name` field at all. That exact document (`_id 6a64cacf4bb7059c8a62aa5f`) is what
 * crashed `/nutrition/meal-suggest` in #926 (`f.name.toLowerCase()` on a nameless doc).
 *
 * This is a route-level test (drives the REAL router via supertest, not a re-implementation
 * of the validation in the test file — the "mirror test" class, #909) because the existing
 * foods.test.ts re-implements pure helpers instead of importing routes/foods.js at all and
 * would stay green even if this exact validation were deleted.
 *
 * RED-FIRST: reverting the fix (dropping the `name` check) makes both assertions below fail
 * — POST returns 201 instead of 400, and `insertOne` gets called once instead of zero times —
 * verified live before this file was committed (see task #931 comment for the transcript).
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const foodsRouter = require('../../routes/foods')

type Doc = Record<string, any>

function makeGetDB(state: { inserted: Doc[] }) {
  return () => ({
    collection(name: string) {
      if (name !== 'foods_library') {
        throw new Error(`unexpected collection: ${name}`)
      }
      return {
        findOne: async () => null, // no existing match — forces the insertOne path if reached
        insertOne: async (doc: Doc) => {
          state.inserted.push(doc)
          return { insertedId: `fake-id-${state.inserted.length}` }
        },
        updateOne: async () => ({ modifiedCount: 1 }),
      }
    },
  })
}

function makeApp(state: { inserted: Doc[] }) {
  const app = express()
  app.use(express.json())
  app.use('/api/foods', foodsRouter(makeGetDB(state)))
  return app
}

describe('POST /api/foods — name validation (#931)', () => {
  it('rejects a body with no `name` field: 400, zero documents inserted', async () => {
    const state = { inserted: [] as Doc[] }
    const app = makeApp(state)

    const res = await request(app)
      .post('/api/foods')
      .send({ fiber_per_100g: 0, sugar_per_100g: 0, salt_per_100g: 0 })

    expect(res.status).toBe(400)
    expect(state.inserted.length).toBe(0)
  })

  it('rejects a body with `name: ""` (empty/whitespace string): 400, zero documents inserted', async () => {
    const state = { inserted: [] as Doc[] }
    const app = makeApp(state)

    const res = await request(app).post('/api/foods').send({ name: '   ' })

    expect(res.status).toBe(400)
    expect(state.inserted.length).toBe(0)
  })

  it('still accepts a valid body with a real name: 201, one document inserted with that name', async () => {
    const state = { inserted: [] as Doc[] }
    const app = makeApp(state)

    const res = await request(app).post('/api/foods').send({ name: 'Куряче філе' })

    expect(res.status).toBe(201)
    expect(state.inserted.length).toBe(1)
    expect(state.inserted[0].name).toBe('Куряче філе')
  })
})
