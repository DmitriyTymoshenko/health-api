/**
 * Unit tests for lib/recovery-zone.js — task #1292 (Ф3). Thresholds extracted
 * VERBATIM from routes/activity_plan.js (>=67 hard / >=34 moderate / else light)
 * so GET /api/readiness and GET /api/activity-plan/suggest can never disagree on
 * the zone for the same recovery score.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RECOVERY_ZONE_THRESHOLDS, recoveryZone, ZONE_TO_COLOR } = require('../../lib/recovery-zone')

describe('recoveryZone — same boundaries as activity_plan.js:suggest (getStrainZone in activity_plan.test.ts)', () => {
  it('thresholds are 67 (hard) / 34 (moderate) — matches activity_plan.js live behavior', () => {
    expect(RECOVERY_ZONE_THRESHOLDS).toEqual({ hard: 67, moderate: 34 })
  })

  it('recovery >= 67 -> hard', () => {
    expect(recoveryZone(67)).toBe('hard')
    expect(recoveryZone(100)).toBe('hard')
  })

  it('recovery 34-66 -> moderate', () => {
    expect(recoveryZone(34)).toBe('moderate')
    expect(recoveryZone(50)).toBe('moderate')
    expect(recoveryZone(66)).toBe('moderate')
  })

  it('recovery < 34 -> light', () => {
    expect(recoveryZone(33)).toBe('light')
    expect(recoveryZone(0)).toBe('light')
  })

  it('ZONE_TO_COLOR maps hard/moderate/light to green/yellow/red', () => {
    expect(ZONE_TO_COLOR).toEqual({ hard: 'green', moderate: 'yellow', light: 'red' })
  })
})

export {}
