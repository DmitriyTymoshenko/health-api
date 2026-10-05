// #1299 — static guard: no route derives a calendar day from a UTC ISO slice.
import * as fs from 'fs'
import * as path from 'path'
const { toKyivDay, addDaysToKyivDay } = require('../../lib/kyiv-day')

describe('#1299 routes use the Kyiv-day helper', () => {
  const dir = path.join(__dirname, '../../routes')
  it('no toISOString().split/slice day derivation in routes/', () => {
    const bad = fs.readdirSync(dir).filter(f => f.endsWith('.js')).filter(f =>
      /toISOString\(\)\.(split|slice)/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(bad).toEqual([])
  })
  it('weight baseline: instant at 22:30Z (01:30 Kyiv next day) maps to the Kyiv day', () => {
    expect(toKyivDay('2026-10-01T22:30:00Z')).toBe('2026-10-02')
  })
  it('date-only −1 day (repeat/readiness) is boundary-free', () => {
    expect(addDaysToKyivDay('2026-03-29', -1)).toBe('2026-03-28')
    expect(addDaysToKyivDay('2026-01-01', -7)).toBe('2025-12-25')
  })
})
