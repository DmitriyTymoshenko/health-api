/**
 * Tests for supplement catalog business logic
 */
import { normalizeSupplementId } from '../middleware/validate'
import { Request, Response, NextFunction } from 'express'
import { SupplementCatalog, SupplementIntake } from '../types'

function buildReq(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}): Request {
  return { body: { ...body }, query: { ...query } } as unknown as Request
}
const res = {} as Response
const next = jest.fn() as NextFunction

beforeEach(() => jest.clearAllMocks())

describe('supplement_id normalization', () => {
  it('converts string "1" to number 1', () => {
    const req = buildReq({ supplement_id: '1', date: '2026-03-31' })
    normalizeSupplementId(req, res, next)
    expect(req.body.supplement_id).toBe(1)
    expect(typeof req.body.supplement_id).toBe('number')
  })

  it('converts string "8" to number 8 (ZMA)', () => {
    const req = buildReq({ supplement_id: '8', date: '2026-03-31' })
    normalizeSupplementId(req, res, next)
    expect(req.body.supplement_id).toBe(8)
  })

  it('leaves number unchanged', () => {
    const req = buildReq({ supplement_id: 3, date: '2026-03-31' })
    normalizeSupplementId(req, res, next)
    expect(req.body.supplement_id).toBe(3)
  })
})

describe('SupplementCatalog type validation', () => {
  it('catalog entry has required fields', () => {
    const entry: SupplementCatalog = {
      id: 1,
      name: 'GymBeam Vitamin D3',
      short_name: 'Vitamin D3',
      brand: 'GymBeam',
      dose: '2000 IU (1 капс)',
      schedule: 'morning',
      notes: 'після сніданку',
      active: true,
    }
    expect(entry.id).toBe(1)
    expect(entry.schedule).toBe('morning')
    expect(entry.active).toBe(true)
  })

  it('all schedules are valid', () => {
    const validSchedules: SupplementCatalog['schedule'][] = ['morning', 'pre_meal', 'pre_workout', 'evening']
    expect(validSchedules).toHaveLength(4)
  })
})

describe('SupplementIntake type validation', () => {
  it('intake has numeric supplement_id', () => {
    const intake: SupplementIntake = {
      supplement_id: 3,
      date: '2026-03-31',
      taken_at: new Date().toISOString(),
    }
    expect(typeof intake.supplement_id).toBe('number')
    expect(intake.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('Cycle date calculations', () => {
  it('calculates end date correctly for 8-week cycle', () => {
    const startDate = new Date('2026-03-30')
    const durationWeeks = 8
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + durationWeeks * 7)

    expect(endDate.toISOString().split('T')[0]).toBe('2026-05-25')
  })

  it('calculates days left correctly', () => {
    const endDate = new Date('2026-05-25')
    const today = new Date('2026-03-31')
    const daysLeft = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

    expect(daysLeft).toBe(55)
  })

  it('detects overdue cycle', () => {
    const endDate = new Date('2026-03-20')
    const today = new Date('2026-03-31')
    const daysLeft = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

    expect(daysLeft).toBeLessThan(0)
  })
})
