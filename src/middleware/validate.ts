import { Request, Response, NextFunction } from 'express'
import { NutritionInput } from '../types'

/**
 * Normalize nutrition fields:
 * Accepts both protein/fat/carbs and protein_g/fat_g/carbs_g
 * Also normalizes name → food_name and sets default date
 */
export function normalizeNutrition(req: Request, res: Response, next: NextFunction): void {
  if (req.body) {
    const b = req.body as NutritionInput & Record<string, unknown>

    if (b.protein !== undefined && b.protein_g === undefined) {
      b.protein_g = Number(b.protein)
    }
    if (b.fat !== undefined && b.fat_g === undefined) {
      b.fat_g = Number(b.fat)
    }
    if (b.carbs !== undefined && b.carbs_g === undefined) {
      b.carbs_g = Number(b.carbs)
    }
    if (b.name && !b.food_name) {
      b.food_name = String(b.name)
    }
    if (!b.date) {
      b.date = new Date().toISOString().split('T')[0]
    }
  }
  next()
}

/**
 * Validate required fields in request body
 */
export function requireFields(...fields: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const missing = fields.filter(f => req.body[f] === undefined || req.body[f] === null)
    if (missing.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` })
      return
    }
    next()
  }
}

/**
 * Validate date format YYYY-MM-DD
 */
export function validateDate(req: Request, res: Response, next: NextFunction): void {
  const date = (req.body?.date || req.query?.date) as string | undefined
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
    return
  }
  next()
}

/**
 * Ensure supplement_id is stored as a number, not string
 */
export function normalizeSupplementId(req: Request, res: Response, next: NextFunction): void {
  if (req.body?.supplement_id !== undefined) {
    req.body.supplement_id = Number(req.body.supplement_id)
  }
  if (req.query?.supplement_id !== undefined) {
    req.query.supplement_id = String(Number(req.query.supplement_id))
  }
  next()
}
