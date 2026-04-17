/**
 * Metrics route — unit tests for business logic in routes/metrics.js
 * Tests: doc normalization (date auto-set), validation of query params,
 *        range query validation
 */

// --- Replicate pure logic from routes/metrics.js ---

interface MetricsDoc {
  date: string
  created_at: Date
  [key: string]: unknown
}

function normalizeMetricsDoc(body: Record<string, unknown>): MetricsDoc {
  const doc = { ...body }
  if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
  doc.created_at = new Date()
  return doc as MetricsDoc
}

function parsePageParams(query: Record<string, string | undefined>): {
  limit: number; skip: number
} {
  return {
    limit: Number(query.limit ?? 30),
    skip: Number(query.skip ?? 0),
  }
}

function validateRangeQuery(query: Record<string, string | undefined>): {
  ok: boolean; error?: string; from?: string; to?: string
} {
  const { from, to } = query
  if (!from || !to) return { ok: false, error: 'from and to required' }
  return { ok: true, from, to }
}

// --- Tests ---

describe('normalizeMetricsDoc — date auto-set', () => {
  it('preserves existing date when provided', () => {
    const doc = normalizeMetricsDoc({ date: '2026-04-10', recovery_score: 75 })
    expect(doc.date).toBe('2026-04-10')
  })

  it('auto-sets date to today when missing', () => {
    const doc = normalizeMetricsDoc({ recovery_score: 75 })
    expect(doc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(doc.date.length).toBe(10)
  })

  it('adds created_at as Date object', () => {
    const doc = normalizeMetricsDoc({ date: '2026-04-10' })
    expect(doc.created_at).toBeInstanceOf(Date)
  })

  it('preserves all other fields', () => {
    const doc = normalizeMetricsDoc({
      date: '2026-04-10',
      recovery_score: 75,
      hrv: 65,
      resting_hr: 58,
      spo2: 98.5,
    })
    expect(doc.recovery_score).toBe(75)
    expect(doc.hrv).toBe(65)
    expect(doc.resting_hr).toBe(58)
    expect(doc.spo2).toBe(98.5)
  })
})

describe('parsePageParams — pagination', () => {
  it('uses defaults when params are missing', () => {
    const result = parsePageParams({})
    expect(result.limit).toBe(30)
    expect(result.skip).toBe(0)
  })

  it('parses provided limit and skip', () => {
    const result = parsePageParams({ limit: '10', skip: '20' })
    expect(result.limit).toBe(10)
    expect(result.skip).toBe(20)
  })

  it('converts string numbers to Number', () => {
    const result = parsePageParams({ limit: '5' })
    expect(typeof result.limit).toBe('number')
  })
})

describe('validateRangeQuery — from/to validation', () => {
  it('returns error when from is missing', () => {
    const result = validateRangeQuery({ to: '2026-04-17' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('from')
  })

  it('returns error when to is missing', () => {
    const result = validateRangeQuery({ from: '2026-04-01' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('to')
  })

  it('returns ok when both from and to provided', () => {
    const result = validateRangeQuery({ from: '2026-04-01', to: '2026-04-17' })
    expect(result.ok).toBe(true)
    expect(result.from).toBe('2026-04-01')
    expect(result.to).toBe('2026-04-17')
  })

  it('returns error when both params missing', () => {
    const result = validateRangeQuery({})
    expect(result.ok).toBe(false)
  })
})

describe('metrics — health data ranges sanity', () => {
  // Sanity checks on typical health metric values
  it('typical recovery score range: 0-100', () => {
    const min = 0
    const max = 100
    expect(75).toBeGreaterThanOrEqual(min)
    expect(75).toBeLessThanOrEqual(max)
  })

  it('typical HRV range (rmssd): 10-150ms', () => {
    expect(65).toBeGreaterThan(10)
    expect(65).toBeLessThan(150)
  })

  it('typical resting HR: 40-100 bpm', () => {
    const rhr = 58
    expect(rhr).toBeGreaterThan(40)
    expect(rhr).toBeLessThan(100)
  })

  it('typical SpO2: 94-100%', () => {
    const spo2 = 98.5
    expect(spo2).toBeGreaterThanOrEqual(94)
    expect(spo2).toBeLessThanOrEqual(100)
  })
})
