import { Request, Response, NextFunction } from 'express'
import { normalizeNutrition, requireFields, validateDate, normalizeSupplementId } from '../middleware/validate'

function mockReqRes(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  const req = { body: { ...body }, query: { ...query } } as unknown as Request
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response
  const next = jest.fn() as NextFunction
  return { req, res, next }
}

describe('normalizeNutrition', () => {
  it('converts protein → protein_g', () => {
    const { req, res, next } = mockReqRes({ protein: 28, fat: 25, carbs: 42, kcal: 535 })
    normalizeNutrition(req, res, next)
    expect(req.body.protein_g).toBe(28)
    expect(req.body.fat_g).toBe(25)
    expect(req.body.carbs_g).toBe(42)
    expect(next).toHaveBeenCalled()
  })

  it('does not overwrite existing protein_g', () => {
    const { req, res, next } = mockReqRes({ protein: 10, protein_g: 30 })
    normalizeNutrition(req, res, next)
    expect(req.body.protein_g).toBe(30)
  })

  it('copies name → food_name if food_name missing', () => {
    const { req, res, next } = mockReqRes({ name: 'Банан' })
    normalizeNutrition(req, res, next)
    expect(req.body.food_name).toBe('Банан')
  })

  it('does not overwrite existing food_name', () => {
    const { req, res, next } = mockReqRes({ name: 'Банан', food_name: 'Banana' })
    normalizeNutrition(req, res, next)
    expect(req.body.food_name).toBe('Banana')
  })

  it('sets default date if missing', () => {
    const { req, res, next } = mockReqRes({})
    normalizeNutrition(req, res, next)
    expect(req.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('does not overwrite existing date', () => {
    const { req, res, next } = mockReqRes({ date: '2026-01-15' })
    normalizeNutrition(req, res, next)
    expect(req.body.date).toBe('2026-01-15')
  })

  it('accepts protein_g directly without conversion', () => {
    const { req, res, next } = mockReqRes({ protein_g: 45, fat_g: 10, carbs_g: 60 })
    normalizeNutrition(req, res, next)
    expect(req.body.protein_g).toBe(45)
    expect(next).toHaveBeenCalled()
  })
})

describe('requireFields', () => {
  it('calls next when all fields present', () => {
    const { req, res, next } = mockReqRes({ date: '2026-03-31', kcal: 500 })
    requireFields('date', 'kcal')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 400 when field missing', () => {
    const { req, res, next } = mockReqRes({ date: '2026-03-31' })
    requireFields('date', 'kcal')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('kcal') }))
    expect(next).not.toHaveBeenCalled()
  })
})

describe('validateDate', () => {
  it('calls next for valid date in body', () => {
    const { req, res, next } = mockReqRes({ date: '2026-03-31' })
    validateDate(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('calls next for valid date in query', () => {
    const { req, res, next } = mockReqRes({}, { date: '2026-03-31' })
    validateDate(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns 400 for invalid date format', () => {
    const { req, res, next } = mockReqRes({ date: '31-03-2026' })
    validateDate(req, res, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })

  it('calls next when no date provided', () => {
    const { req, res, next } = mockReqRes({})
    validateDate(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})

describe('normalizeSupplementId', () => {
  it('converts string supplement_id to number in body', () => {
    const { req, res, next } = mockReqRes({ supplement_id: '5' })
    normalizeSupplementId(req, res, next)
    expect(req.body.supplement_id).toBe(5)
    expect(typeof req.body.supplement_id).toBe('number')
    expect(next).toHaveBeenCalled()
  })

  it('keeps numeric supplement_id unchanged', () => {
    const { req, res, next } = mockReqRes({ supplement_id: 3 })
    normalizeSupplementId(req, res, next)
    expect(req.body.supplement_id).toBe(3)
  })
})
