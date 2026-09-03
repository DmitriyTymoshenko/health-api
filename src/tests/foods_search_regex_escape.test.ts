/**
 * ROUTE-LEVEL test for GET /api/foods/search (#1225, scope narrowed by Apex triage
 * in task #1225 comment #6900 — fuzzy/stemming/$text explicitly ruled out; only the
 * regex-escape (A) and query-normalization (B) fixes are covered here).
 *
 * WHAT #1225 FOUND (live, 03.09): `router.get('/search')` interpolates `req.query.q`
 * straight into `$regex` with no escaping. A raw regex metacharacter in the query —
 * an unbalanced paren or a bare `*` — is not valid PCRE and blows up the whole
 * request with a 500. This is not hypothetical: real foods_library entries carry
 * parens in their own names ("Голубці (з рисом", "Псиліум (лушпиння)"), so typing
 * the exact product name back into search can 500 the endpoint.
 *
 * This is a ROUTE-LEVEL test (drives the REAL router via supertest, per the #931/#909
 * "mirror test" lesson already applied in foods_post_name_validation.test.ts) — NOT a
 * copy of escapeRegex/normalizeSearchQuery into the test file. The fake `find()` below
 * compiles each `$or` clause's `$regex`/`$options` into a real JS `RegExp` itself, which
 * reproduces MongoDB's own server-side regex-compile failure for an unescaped
 * metacharacter without depending on (or duplicating) routes/foods.js's internal fix.
 *
 * RED-FIRST: reverting the escaping (rawQuery straight into `$regex`) makes the
 * "q=(" / "q=*" / real-product-name-with-parens cases throw `SyntaxError: Invalid
 * regular expression` inside `find()`, caught by the route's try/catch → 500 — the
 * exact live defect. Reverting the trim/collapse-whitespace normalization makes the
 * padded-whitespace regression case return 0 results instead of 1, because the
 * padded query no longer matches the single-spaced stored name. Both were verified
 * failing against the pre-fix `routes/foods.js` before this file was committed.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const foodsRouter = require('../../routes/foods')

type Doc = Record<string, any>

function makeFakeCollection(docs: Doc[]) {
  return {
    find(filter: { $or: Doc[] }) {
      // Mirrors real Mongo: each $or clause's $regex/$options is compiled into an
      // actual regex engine. An unescaped metachar throws here — same failure class
      // as the live 500, without re-implementing routes/foods.js's escaping logic.
      const compiled = filter.$or.map((clause) => {
        const field = Object.keys(clause)[0]
        const { $regex: pattern, $options: opts } = clause[field]
        return { field, re: new RegExp(pattern, opts) }
      })
      const matched = docs.filter((doc) =>
        compiled.some(({ field, re }) => typeof doc[field] === 'string' && re.test(doc[field]))
      )
      return {
        sort: () => ({
          limit: () => ({
            toArray: async () => matched,
          }),
        }),
      }
    },
  }
}

function makeGetDB(docs: Doc[]) {
  return () => ({
    collection(name: string) {
      if (name !== 'foods_library') throw new Error(`unexpected collection: ${name}`)
      return makeFakeCollection(docs)
    },
  })
}

function makeApp(docs: Doc[]) {
  const app = express()
  app.use('/api/foods', foodsRouter(makeGetDB(docs)))
  return app
}

const LIBRARY: Doc[] = [
  { _id: '1', name: 'Granola bar', name_ua: 'Гранола Go On', brand: null, aliases: ['granola', 'гранола'], use_count: 5 },
  { _id: '2', name: 'Protein granola', name_ua: 'Протеїнова гранола Protein Go', brand: null, aliases: ['granola'], use_count: 3 },
  { _id: '3', name: 'Coconut milk', name_ua: 'Кокосове молоко Alpro', brand: 'Alpro', aliases: ['coconut milk'], use_count: 2 },
  { _id: '4', name: 'Coconut milk Zott', name_ua: 'Кокосове молоко Zott Protein', brand: 'Zott', aliases: [], use_count: 1 },
  { _id: '5', name: 'Cabbage rolls', name_ua: 'Голубці (з рисом', brand: null, aliases: [], use_count: 0 },
]

describe('GET /api/foods/search — regex-metachar escape (#1225, Finding A)', () => {
  it('q=( no longer 500s (was a live SyntaxError before the fix)', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: '(' })
    expect(res.status).toBe(200)
  })

  it('q=* no longer 500s (was a live SyntaxError before the fix)', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: '*' })
    expect(res.status).toBe(200)
  })

  it('searching the exact real product name with unbalanced parens returns 200 and finds it', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: 'Голубці (з рисом' })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.results[0]._id).toBe('5')
  })
})

describe('GET /api/foods/search — query normalization (#1225, Finding B)', () => {
  it('trims + collapses internal whitespace so a padded query still matches', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: '  кокосове   молоко ' })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(res.body.results[0]._id).toBe('3') // higher use_count sorts first
  })

  it('empty q returns 200 with an empty result set (no DB hit)', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: '' })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('single-character q returns 200', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: 'а' })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/foods/search — regression: existing matches unchanged (#1225 acceptance)', () => {
  it('гранола -> 2 results, unchanged', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: 'гранола' })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
  })

  it('протеїнова гранола -> 1 result, unchanged', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: 'протеїнова гранола' })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.results[0]._id).toBe('2')
  })

  it('кокосове молоко -> 2 results, unchanged', async () => {
    const res = await request(makeApp(LIBRARY)).get('/api/foods/search').query({ q: 'кокосове молоко' })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
  })
})

export {}
