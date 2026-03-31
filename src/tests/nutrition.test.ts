/**
 * Unit tests for nutrition normalization logic
 * Tests the normalize function in isolation (no MongoDB needed)
 */

import { normalizeNutrition } from '../middleware/validate'
import { Request, Response, NextFunction } from 'express'

function buildReq(body: Record<string, unknown>): Request {
  return { body: { ...body }, query: {} } as unknown as Request
}
const res = {} as Response
const next = jest.fn() as NextFunction

beforeEach(() => jest.clearAllMocks())

describe('Nutrition field normalization', () => {
  const cases = [
    {
      desc: 'МакДональдз Біф Рол — protein/fat/carbs format',
      input: { name: "Біф Рол", meal_type: 'breakfast', kcal: 535, protein: 28, fat: 25, carbs: 42 },
      expected: { protein_g: 28, fat_g: 25, carbs_g: 42, food_name: 'Біф Рол' },
    },
    {
      desc: 'Bakoma shake — protein_g format',
      input: { food_name: 'Bakoma Shake', meal_type: 'lunch', kcal: 171, protein_g: 20, fat_g: 2, carbs_g: 20 },
      expected: { protein_g: 20, fat_g: 2, carbs_g: 20 },
    },
    {
      desc: 'Шаурма — mixed (some _g some not)',
      input: { food_name: 'Шаурма', kcal: 693, protein_g: 56, fat: 30, carbs: 42 },
      expected: { protein_g: 56, fat_g: 30, carbs_g: 42 },
    },
    {
      desc: 'Date auto-set when missing',
      input: { food_name: 'Test', kcal: 100, protein_g: 5, fat_g: 2, carbs_g: 10 },
      expectedDatePattern: /^\d{4}-\d{2}-\d{2}$/,
    },
  ]

  for (const tc of cases) {
    it(tc.desc, () => {
      const req = buildReq(tc.input)
      normalizeNutrition(req, res, next)

      if (tc.expected) {
        for (const [key, val] of Object.entries(tc.expected)) {
          expect(req.body[key]).toBe(val)
        }
      }
      if (tc.expectedDatePattern) {
        expect(req.body.date).toMatch(tc.expectedDatePattern)
      }
      expect(next).toHaveBeenCalled()
    })
  }

  it('calculates correct macro totals', () => {
    const entries = [
      { protein: 28, fat: 25, carbs: 42 },  // Біф Рол
      { protein: 20, fat: 2, carbs: 20 },   // Bakoma
      { protein: 27, fat: 12.5, carbs: 65 }, // Гранола
    ]

    let totalProtein = 0, totalFat = 0, totalCarbs = 0
    for (const e of entries) {
      const req = buildReq(e)
      normalizeNutrition(req, res, next)
      totalProtein += req.body.protein_g as number
      totalFat += req.body.fat_g as number
      totalCarbs += req.body.carbs_g as number
    }

    expect(totalProtein).toBe(75)
    expect(totalFat).toBe(39.5)
    expect(totalCarbs).toBe(127)
  })
})
