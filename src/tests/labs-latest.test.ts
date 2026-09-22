/**
 * Unit tests for lib/labs-latest.js (#1488, stage C of #1485).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeLatestLabs, getStatus, REFERENCE_RANGES } = require('../../lib/labs-latest')

describe('computeLatestLabs', () => {
  it('picks the FIRST (most recent, assuming DESC-sorted input) value per marker and computes age_days', () => {
    const data = [
      { date: '2026-09-10', source: 'pdf', values: { ferritin: 45, vitamin_d: 60 } },
      { date: '2026-08-01', source: 'manual', values: { ferritin: 40 } },
    ]
    const out = computeLatestLabs(data, '2026-09-22')
    expect(out.ferritin.value).toBe(45)
    expect(out.ferritin.date).toBe('2026-09-10')
    expect(out.ferritin.age_days).toBe(12)
    expect(out.vitamin_d.value).toBe(60)
    expect(out.vitamin_d.status).toBe('low') // 60 < min 75
  })

  it('defaults source to "manual" when missing', () => {
    const out = computeLatestLabs([{ date: '2026-09-01', values: { glucose: 5 } }], '2026-09-22')
    expect(out.glucose.source).toBe('manual')
  })

  it('an unknown marker key still appears with ref:null, status "unknown"', () => {
    const out = computeLatestLabs([{ date: '2026-09-01', values: { made_up_marker: 1 } }], '2026-09-22')
    expect(out.made_up_marker.ref).toBeNull()
    expect(out.made_up_marker.status).toBe('unknown')
  })

  it('empty input returns {}', () => {
    expect(computeLatestLabs([], '2026-09-22')).toEqual({})
  })
})

describe('getStatus / REFERENCE_RANGES (re-exported from routes/labs.js, single source)', () => {
  it('getStatus classifies low/normal/high correctly for a known marker', () => {
    expect(getStatus('vitamin_d', 50)).toBe('low')
    expect(getStatus('vitamin_d', 150)).toBe('normal')
    expect(getStatus('vitamin_d', 300)).toBe('high')
  })
  it('REFERENCE_RANGES has the vitamin_d entry with expected shape', () => {
    expect(REFERENCE_RANGES.vitamin_d).toMatchObject({ min: 75, max: 250 })
  })
})

export {}
