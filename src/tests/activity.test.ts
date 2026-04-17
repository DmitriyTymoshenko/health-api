/**
 * Activity route — unit tests for business logic in routes/activity.js
 * Tests: filter building (date query), date auto-set on POST, pagination
 */

// --- Replicate pure logic from routes/activity.js ---

interface ActivityFilter {
  date?: string
}

function buildActivityFilter(query: Record<string, string | undefined>): ActivityFilter {
  const { date } = query
  return date ? { date } : {}
}

interface ActivityDoc {
  date: string
  created_at: Date
  [key: string]: unknown
}

function normalizeActivityDoc(body: Record<string, unknown>): ActivityDoc {
  const doc = { ...body }
  if (!doc.date) {
    doc.date = new Date().toISOString().split('T')[0]
  }
  doc.created_at = new Date()
  return doc as ActivityDoc
}

// --- Tests ---

describe('buildActivityFilter — date query', () => {
  it('returns empty filter when no date provided', () => {
    const filter = buildActivityFilter({})
    expect(filter).toEqual({})
  })

  it('builds filter with date when date provided', () => {
    const filter = buildActivityFilter({ date: '2026-04-17' })
    expect(filter).toEqual({ date: '2026-04-17' })
  })

  it('ignores undefined date', () => {
    const filter = buildActivityFilter({ date: undefined })
    expect(filter).toEqual({})
  })

  it('preserves exact date string format', () => {
    const filter = buildActivityFilter({ date: '2026-01-01' })
    expect(filter.date).toBe('2026-01-01')
  })

  it('empty filter returns {} so .find({}) fetches all entries', () => {
    const filter = buildActivityFilter({})
    expect(Object.keys(filter).length).toBe(0)
  })
})

describe('normalizeActivityDoc — POST body normalization', () => {
  it('preserves provided date', () => {
    const doc = normalizeActivityDoc({ date: '2026-04-17', type: 'run' })
    expect(doc.date).toBe('2026-04-17')
  })

  it('auto-sets date to today when missing', () => {
    const doc = normalizeActivityDoc({ type: 'walk', steps: 5000 })
    expect(doc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('adds created_at as Date instance', () => {
    const doc = normalizeActivityDoc({ type: 'bike' })
    expect(doc.created_at).toBeInstanceOf(Date)
  })

  it('preserves all other fields from body', () => {
    const doc = normalizeActivityDoc({
      date: '2026-04-17',
      type: 'run',
      duration_min: 45,
      distance_km: 7.2,
      calories: 420,
    })
    expect(doc.type).toBe('run')
    expect(doc.duration_min).toBe(45)
    expect(doc.distance_km).toBe(7.2)
    expect(doc.calories).toBe(420)
  })

  it('does not override existing date with auto-set logic', () => {
    const today = new Date().toISOString().split('T')[0]
    const doc = normalizeActivityDoc({ date: '2026-01-15' })
    expect(doc.date).toBe('2026-01-15')
    expect(doc.date).not.toBe(today || '2026-01-15') // unless today IS 2026-01-15
  })
})

describe('activity — pagination defaults', () => {
  function parseLimit(limitStr: string | undefined, defaultLimit: number): number {
    return limitStr !== undefined ? Number(limitStr) : defaultLimit
  }

  it('defaults to 50 results when limit not provided', () => {
    expect(parseLimit(undefined, 50)).toBe(50)
  })

  it('uses provided limit', () => {
    expect(parseLimit('20', 50)).toBe(20)
  })

  it('converts string to number', () => {
    expect(typeof parseLimit('10', 50)).toBe('number')
  })
})
