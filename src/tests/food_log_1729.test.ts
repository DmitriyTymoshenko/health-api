/**
 * #1729 — POST /api/nutrition/log-food route test (real router via supertest, fake Mongo).
 * Covers: found item logged with scaled macros; unknown item → not_found (not logged);
 * brand mismatch → not_found; retry of the same message → duplicate, no second insert;
 * portion×serving; Kyiv-day default; validation errors; day_summary returned.
 */
import request from 'supertest'
import express from 'express'

jest.mock('../../routes/nutrition', () => () => ({ computeSummary: async (_db: any, date: string) => ({ date, kcal: 123 }) }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../routes/nutrition_log_food')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const F = require('../../lib/food-log')

type Doc = Record<string, any>
const LIB: Doc[] = [
  { _id: 'b1', name: 'Банан', name_ua: 'Банан', kcal_per_100g: 89, protein_per_100g: 1, fat_per_100g: 0.3, carbs_per_100g: 23, fiber_per_100g: 2.6, sugar_per_100g: 12, serving_size_g: 120, aliases: ['banana'] },
  { _id: 'y1', name: 'Yummy Bar', name_ua: 'Батончик FitWin YummY Bar', brand: 'FitWin', kcal_per_100g: 353, protein_per_100g: 30, fat_per_100g: 12, carbs_per_100g: 30, sat_fat_per_100g: 5, serving_size_g: 55 },
  { _id: 's1', name: 'Сирники', name_ua: 'Сирники', kcal_per_100g: 220, protein_per_100g: 14, fat_per_100g: 9, carbs_per_100g: 21 },
  { _id: 'pg1', name: 'Протеїнова гранола Protein Go', name_ua: 'Протеїнова гранола Protein Go', kcal_per_100g: 416, protein_per_100g: 22, fat_per_100g: 17, carbs_per_100g: 43, aliases: ['гранола', 'протеїнова гранола', 'protein go granola'], use_count: 0 },
  { _id: 'go1', name: 'Go On Nutrition Protein Granola (брауні вишня)', name_ua: 'Гранола Go On Nutrition Protein Granola 300 г брауні вишня', kcal_per_100g: 408, protein_per_100g: 21, fat_per_100g: 13, carbs_per_100g: 46, aliases: ['granola', 'гранола', 'go on granola'], use_count: 2 },
  { _id: 'al1', name: 'Кокосове молоко Alpro Coconut Original', name_ua: 'Кокосове молоко Alpro Coconut Original', kcal_per_100g: 20, protein_per_100g: 0.1, fat_per_100g: 0.9, carbs_per_100g: 2.7, aliases: ['кокосове молоко', 'coconut milk', 'алпро кокосове'], use_count: 0 },
]

function app() {
  const logged: Doc[] = []
  const db = {
    collection(n: string) {
      if (n === 'foods_library') {
        return {
          find: (flt: any) => ({ limit: () => ({ toArray: async () => LIB.filter((d) => flt.$or.some((c: Doc) => { const f = Object.keys(c)[0]; const re = new RegExp(c[f].$regex, 'i'); const v = d[f]; return Array.isArray(v) ? v.some((x: string) => re.test(x)) : typeof v === 'string' && re.test(v) })) }) }),
          updateMany: async () => ({}),
        }
      }
      if (n === 'nutrition_log') {
        return {
          findOne: async (f: Doc) => logged.find((l) => l.idem_key === f.idem_key && (!f.created_at || l.created_at >= f.created_at.$gte)) || null,
          insertOne: async (d: Doc) => { logged.push(d); return { insertedId: 'id' + logged.length } },
        }
      }
      throw new Error('unexpected collection ' + n)
    },
  }
  const a = express(); a.use(express.json()); a.use('/', router(() => db)); return { a, logged }
}

describe('POST log-food (#1729)', () => {
  test('logs found item with scaled macros, returns not_found + day_summary', async () => {
    const { a, logged } = app()
    const r = await request(a).post('/').send({ items: [{ name: 'банан', grams: 150 }, { name: 'пельмені', grams: 100 }], meal_type: 'lunch', date: '2026-10-02' })
    expect(r.status).toBe(201)
    expect(r.body.logged).toHaveLength(1)
    expect(r.body.logged[0].kcal).toBe(133.5)
    expect(r.body.not_found.map((x: Doc) => x.name)).toEqual(['пельмені'])
    expect(r.body.day_summary).toEqual({ date: '2026-10-02', kcal: 123 })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ date: '2026-10-02', meal_type: 'lunch', amount_g: 150 })
  })
  test('idempotent: same message twice → second is duplicate, one insert', async () => {
    const { a, logged } = app()
    const body = { items: [{ name: 'банан', grams: 100 }], meal_type: 'snack', date: '2026-10-02' }
    await request(a).post('/').send(body)
    const r2 = await request(a).post('/').send(body)
    expect(r2.body.duplicates).toHaveLength(1)
    expect(r2.body.logged).toHaveLength(0)
    expect(logged).toHaveLength(1)
  })
  test('brand must match; portion = servings × serving_size_g', async () => {
    const { a } = app()
    const bad = await request(a).post('/').send({ items: [{ name: 'YummY Bar', brand: 'Other', portion: 1 }] })
    expect(bad.body.not_found).toHaveLength(1)
    const ok = await request(a).post('/').send({ items: [{ name: 'YummY Bar', brand: 'FitWin', portion: '1' }], date: '2026-10-02' })
    expect(ok.body.logged[0].amount_g).toBe(55)
    expect(ok.body.logged[0].kcal).toBe(194.2)
    expect(ok.body.logged[0].sat_fat_g).toBe(2.8)
  })
  test('stem match: сирники/сирник; default date is Kyiv today; validation', async () => {
    const { a } = app()
    const r = await request(a).post('/').send({ items: [{ name: 'сирник', grams: 100 }] })
    expect(r.body.logged).toHaveLength(1)
    expect(r.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await request(a).post('/').send({ items: [] })).status).toBe(400)
    expect((await request(a).post('/').send({ items: [{ name: 'x', grams: 1 }], meal_type: 'brunch' })).status).toBe(400)
  })
  test('amount missing and no serving → not_found no_amount, nothing logged', async () => {
    const { a, logged } = app()
    const r = await request(a).post('/').send({ items: [{ name: 'сирники' }] })
    expect(r.body.not_found[0].reason).toBe('no_amount')
    expect(logged).toHaveLength(0)
  })
  test('#1960: later partial aliases must not downgrade exact library matches', async () => {
    const { a } = app()
    const r = await request(a).post('/').send({
      items: [
        { name: 'Протеїнова гранола Protein Go', grams: 10 },
        { name: 'кокосове молоко', grams: 100 },
      ],
      meal_type: 'snack',
      date: '2026-10-03',
    })
    expect(r.status).toBe(201)
    expect(r.body.not_found).toEqual([])
    expect(r.body.logged.map((x: Doc) => x.food_name)).toEqual([
      'Протеїнова гранола Protein Go',
      'Кокосове молоко Alpro Coconut Original',
    ])
  })
  test('mealByHour is by Kyiv hour', () => {
    expect(F.mealByHour(new Date('2026-10-02T06:00:00Z'))).toBe('breakfast') // 09:00 Kyiv
    expect(F.mealByHour(new Date('2026-10-02T17:00:00Z'))).toBe('dinner') // 20:00 Kyiv
  })
})
