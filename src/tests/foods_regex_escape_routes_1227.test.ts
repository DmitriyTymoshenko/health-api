/**
 * Route-level regression for #1227: POST /api/foods duplicate check and
 * GET /api/foods?search=... must escape raw user input before Mongo $regex.
 *
 * The fake collection compiles $regex into a real RegExp, so an unescaped
 * "(" or "*" reproduces the pre-fix 500 without duplicating the route helper.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const foodsRouter = require('../../routes/foods')

type Doc = Record<string, any>

function compileClause(clause: Doc) {
  const field = Object.keys(clause)[0]
  const { $regex: pattern, $options: opts } = clause[field]
  return { field, re: new RegExp(pattern, opts) }
}

function matchesRegexFilter(doc: Doc, filter: Doc) {
  if (filter.name?.$regex) {
    const { field, re } = compileClause({ name: filter.name })
    return typeof doc[field] === 'string' && re.test(doc[field])
  }
  if (Array.isArray(filter.$or)) {
    return filter.$or
      .map(compileClause)
      .some(({ field, re }) => typeof doc[field] === 'string' && re.test(doc[field]))
  }
  return true
}

function makeGetDB(state: { docs: Doc[]; inserted: Doc[] }) {
  return () => ({
    collection(name: string) {
      if (name !== 'foods_library') throw new Error(`unexpected collection: ${name}`)
      return {
        findOne: async (filter: Doc) => state.docs.find((doc) => matchesRegexFilter(doc, filter)) || null,
        insertOne: async (doc: Doc) => {
          state.inserted.push(doc)
          state.docs.push({ ...doc, _id: `fake-${state.inserted.length}` })
          return { insertedId: `fake-${state.inserted.length}` }
        },
        updateOne: async () => ({ modifiedCount: 1 }),
        find: (filter: Doc) => {
          const matched = state.docs.filter((doc) => matchesRegexFilter(doc, filter))
          return {
            sort: () => ({
              limit: () => ({
                toArray: async () => matched,
              }),
            }),
          }
        },
      }
    },
  })
}

function makeApp(state: { docs: Doc[]; inserted: Doc[] }) {
  const app = express()
  app.use(express.json())
  app.use('/api/foods', foodsRouter(makeGetDB(state)))
  return app
}

describe('foods routes escape regex metacharacters (#1227)', () => {
  it('POST /api/foods accepts a new food name with an unbalanced parenthesis', async () => {
    const state = { docs: [] as Doc[], inserted: [] as Doc[] }

    const res = await request(makeApp(state))
      .post('/api/foods')
      .send({ name: 'Псиліум (лушпиння)', kcal_per_100g: 20 })

    expect(res.status).toBe(201)
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0].name).toBe('Псиліум (лушпиння)')
  })

  it('GET /api/foods?search=( returns 200 instead of regex SyntaxError -> 500', async () => {
    const state = {
      docs: [{ _id: '1', name: 'Псиліум (лушпиння)', name_ua: '', brand: '', use_count: 1 }],
      inserted: [] as Doc[],
    }

    const res = await request(makeApp(state)).get('/api/foods').query({ search: '(' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]._id).toBe('1')
  })
})

export {}
