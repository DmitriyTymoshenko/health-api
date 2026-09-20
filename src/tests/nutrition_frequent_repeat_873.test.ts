/**
 * ROUTE-LEVEL tests for the 3 new #873 Частина 2 endpoints (drive the REAL
 * router via supertest, not a mirror re-implementation — #909 class):
 *   - GET  /api/nutrition/frequent   — «Мої продукти», real frequency + last portion (а)
 *   - POST /api/nutrition/repeat     — «Повторити вчорашній сніданок/день» (б)
 *   - POST /api/foods/:id/log-use    — use_count increment for library re-use (г)
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const foodsRouter = require('../../routes/foods')

type Doc = Record<string, any>

function makeArrayCollection(name: string, initialArr: Doc[]) {
  return {
    async findOne(filter: Doc = {}) {
      let list = initialArr.slice()
      if (filter.date) list = list.filter((x) => x.date === filter.date)
      return list[0] ?? null
    },
    find(filter: Doc = {}) {
      let list = initialArr.slice()
      if (filter.date) {
        if (typeof filter.date === 'string') list = list.filter((x) => x.date === filter.date)
        else if (filter.date.$gte) list = list.filter((x) => x.date >= filter.date.$gte)
      }
      if (filter.meal_type) list = list.filter((x) => x.meal_type === filter.meal_type)
      return {
        sort(spec: Record<string, number>) {
          const [key, dir] = Object.entries(spec)[0]
          list = list.slice().sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir as number))
          return this
        },
        toArray: async () => list,
      }
    },
    async insertMany(docs: Doc[]) {
      const insertedIds: Record<number, string> = {}
      docs.forEach((d, i) => { insertedIds[i] = `fake-${name}-${initialArr.length + i}` })
      initialArr.push(...docs)
      return { insertedIds }
    },
  }
}

function makeNutritionApp(nutritionLog: Doc[]) {
  const app = express()
  app.use(express.json())
  const collections: Record<string, any> = {
    nutrition_log: makeArrayCollection('nutrition_log', nutritionLog),
  }
  const getDB = () => ({
    collection(n: string) {
      if (collections[n]) return collections[n]
      throw new Error(`unexpected collection: ${n}`)
    },
  })
  app.use('/api/nutrition', nutritionRouter(getDB))
  return app
}

describe('GET /api/nutrition/frequent (#873 Частина 2а)', () => {
  const LOGS: Doc[] = [
    // Valio Pro Feel logged 3x — must rank #1, matching the live ticket premise
    // ("Valio Pro Feel 11x") over a food logged once.
    { date: '2026-09-01', meal_type: 'snack', food_name: 'Valio Pro Feel', amount_g: 175, kcal: 119, protein_g: 14.9, fat_g: 0.35, carbs_g: 13.1 },
    { date: '2026-09-05', meal_type: 'snack', food_name: 'Valio Pro Feel', amount_g: 175, kcal: 119, protein_g: 14.9, fat_g: 0.35, carbs_g: 13.1 },
    { date: '2026-09-10', meal_type: 'snack', food_name: 'Valio Pro Feel', amount_g: 200, kcal: 136, protein_g: 17, fat_g: 0.4, carbs_g: 15 }, // most RECENT — its portion is the "last used"
    { date: '2026-09-02', meal_type: 'breakfast', food_name: 'Банан', amount_g: 118, kcal: 105, protein_g: 1.3, fat_g: 0.4, carbs_g: 27 },
  ]

  it('ranks by REAL frequency (count of nutrition_log rows), never a stored use_count', async () => {
    const app = makeNutritionApp(LOGS)
    const res = await request(app).get('/api/nutrition/frequent')
    expect(res.status).toBe(200)
    expect(res.body[0].food_name).toBe('Valio Pro Feel')
    expect(res.body[0].use_count).toBe(3)
  })

  it('carries the LAST-used portion (most recent occurrence), not the first/average', async () => {
    const app = makeNutritionApp(LOGS)
    const res = await request(app).get('/api/nutrition/frequent')
    const valio = res.body.find((f: Doc) => f.food_name === 'Valio Pro Feel')
    // Most recent (2026-09-10) logged 200g/136kcal, not the earlier 175g/119kcal.
    expect(valio.last_amount_g).toBe(200)
    expect(valio.last_kcal).toBe(136)
    expect(valio.last_date).toBe('2026-09-10')
  })

  it('respects a `days` window — old entries outside it are excluded', async () => {
    const oldLog = [{ date: '2020-01-01', meal_type: 'snack', food_name: 'Ancient Food', amount_g: 100, kcal: 100, protein_g: 1, fat_g: 1, carbs_g: 1 }]
    const app = makeNutritionApp(oldLog)
    const res = await request(app).get('/api/nutrition/frequent?days=90')
    expect(res.status).toBe(200)
    expect(res.body.find((f: Doc) => f.food_name === 'Ancient Food')).toBeUndefined()
  })

  it('respects `limit`', async () => {
    const app = makeNutritionApp(LOGS)
    const res = await request(app).get('/api/nutrition/frequent?limit=1')
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
  })
})

describe('POST /api/nutrition/repeat (#873 Частина 2б)', () => {
  it('copies the WHOLE previous day when no meal_type given', async () => {
    const yesterday: Doc[] = [
      { date: '2026-09-19', meal_type: 'breakfast', food_name: 'Вівсянка', amount_g: 300, kcal: 264, protein_g: 9, fat_g: 5.1, carbs_g: 45 },
      { date: '2026-09-19', meal_type: 'lunch', food_name: 'Куряча грудка', amount_g: 200, kcal: 330, protein_g: 62, fat_g: 7.2, carbs_g: 0 },
    ]
    const app = makeNutritionApp(yesterday)
    const res = await request(app).post('/api/nutrition/repeat').send({ date: '2026-09-20' })
    expect(res.status).toBe(201)
    expect(res.body.inserted).toBe(2)
    expect(res.body.source_date).toBe('2026-09-19')
    expect(res.body.entries.every((e: Doc) => e.date === '2026-09-20')).toBe(true)
    expect(res.body.entries.map((e: Doc) => e.food_name).sort()).toEqual(['Вівсянка', 'Куряча грудка'])
  })

  it('copies only the named meal_type when given', async () => {
    const yesterday: Doc[] = [
      { date: '2026-09-19', meal_type: 'breakfast', food_name: 'Вівсянка', amount_g: 300, kcal: 264, protein_g: 9, fat_g: 5.1, carbs_g: 45 },
      { date: '2026-09-19', meal_type: 'lunch', food_name: 'Куряча грудка', amount_g: 200, kcal: 330, protein_g: 62, fat_g: 7.2, carbs_g: 0 },
    ]
    const app = makeNutritionApp(yesterday)
    const res = await request(app).post('/api/nutrition/repeat').send({ date: '2026-09-20', meal_type: 'breakfast' })
    expect(res.status).toBe(201)
    expect(res.body.inserted).toBe(1)
    expect(res.body.entries[0].food_name).toBe('Вівсянка')
    expect(res.body.entries[0].meal_type).toBe('breakfast')
  })

  it('returns inserted:0 (not an error) when the previous day has nothing to repeat', async () => {
    const app = makeNutritionApp([])
    const res = await request(app).post('/api/nutrition/repeat').send({ date: '2026-09-20' })
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(0)
  })

  it('rejects a missing/malformed date with 400', async () => {
    const app = makeNutritionApp([])
    const res1 = await request(app).post('/api/nutrition/repeat').send({})
    expect(res1.status).toBe(400)
    const res2 = await request(app).post('/api/nutrition/repeat').send({ date: 'not-a-date' })
    expect(res2.status).toBe(400)
  })
})

describe('POST /api/foods/:id/log-use (#873 Частина 2г)', () => {
  function makeFoodsApp(doc: Doc | null) {
    const state = { doc }
    const app = express()
    app.use(express.json())
    const getDB = () => ({
      collection(name: string) {
        if (name !== 'foods_library') throw new Error(`unexpected collection: ${name}`)
        return {
          async findOneAndUpdate(filter: Doc, update: Doc) {
            if (!state.doc) return null
            state.doc.use_count = (state.doc.use_count || 0) + (update.$inc?.use_count || 0)
            return state.doc
          },
        }
      },
    })
    app.use('/api/foods', foodsRouter(getDB))
    return { app, state }
  }

  it('increments use_count for an EXISTING library food (the missing case: submitFood only called this for source!=="library")', async () => {
    const { ObjectId } = require('mongodb')
    const id = new ObjectId()
    const { app } = makeFoodsApp({ _id: id, name: 'Valio Pro Feel', use_count: 0 })
    const res = await request(app).post(`/api/foods/${id}/log-use`)
    expect(res.status).toBe(200)
    expect(res.body.use_count).toBe(1)
  })

  it('404s when the food does not exist', async () => {
    const { ObjectId } = require('mongodb')
    const id = new ObjectId()
    const { app } = makeFoodsApp(null)
    const res = await request(app).post(`/api/foods/${id}/log-use`)
    expect(res.status).toBe(404)
  })
})
