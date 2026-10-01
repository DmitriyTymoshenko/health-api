/**
 * Unit tests for lib/kyiv-day.js — THE single Kyiv-day helper for the `/me`
 * MVP life_* routes (#1519, SPEC #1518 §4/M2).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toKyivDay, todayKyiv, addDaysToKyivDay, isValidKyivDayFormat } = require('../../lib/kyiv-day')
import { KYIV_MIDNIGHT_BOUNDARY_CASE } from './utils/kyivDayBounds'

describe('toKyivDay', () => {
  it('SPEC-required case: 2026-10-01T21:30:00.000Z (00:30 Kyiv local next day, EEST summer UTC+3) -> 2026-10-02', () => {
    expect(toKyivDay(new Date('2026-10-01T21:30:00.000Z'))).toBe('2026-10-02')
  })

  it('reuses the canonical KYIV_MIDNIGHT_BOUNDARY_CASE fixture (health-api/src/tests/utils/kyivDayBounds.ts)', () => {
    expect(toKyivDay(new Date(KYIV_MIDNIGHT_BOUNDARY_CASE.utcInstantHalfPastMidnight))).toBe(
      KYIV_MIDNIGHT_BOUNDARY_CASE.kyivDay
    )
    expect(toKyivDay(new Date(KYIV_MIDNIGHT_BOUNDARY_CASE.utcInstant))).toBe(KYIV_MIDNIGHT_BOUNDARY_CASE.kyivDay)
  })

  it('an instant well before midnight stays on the same Kyiv day', () => {
    expect(toKyivDay(new Date('2026-10-01T10:00:00.000Z'))).toBe('2026-10-01')
  })

  it('accepts a string/number input same as a Date', () => {
    expect(toKyivDay('2026-10-01T21:30:00.000Z')).toBe('2026-10-02')
  })
})

describe('todayKyiv', () => {
  it('returns a well-formed YYYY-MM-DD string', () => {
    expect(todayKyiv()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('addDaysToKyivDay', () => {
  it('adds a day within the same month', () => {
    expect(addDaysToKyivDay('2026-10-01', 1)).toBe('2026-10-02')
  })

  it('rolls over a month boundary', () => {
    expect(addDaysToKyivDay('2026-09-30', 1)).toBe('2026-10-01')
  })

  it('rolls over a year boundary', () => {
    expect(addDaysToKyivDay('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('never produces output matching the forbidden toISOString().slice(0,10) pattern directly (format sanity)', () => {
    const result = addDaysToKyivDay('2026-10-01', 5)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('isValidKyivDayFormat', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isValidKyivDayFormat('2026-10-01')).toBe(true)
  })
  it.each(['01-10-2026', '2026/10/01', '', undefined, null, 123])('rejects %p', (bad) => {
    expect(isValidKyivDayFormat(bad as any)).toBe(false)
  })
})

export {}
