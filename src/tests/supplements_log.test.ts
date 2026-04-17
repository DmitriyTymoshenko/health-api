/**
 * Supplements log route — unit tests for business logic in routes/supplements.js
 * Tests: doc normalization (date auto-set, taken default), toggle logic
 */

// --- Replicate pure logic from routes/supplements.js ---

interface SupplementsLogDoc {
  date: string
  taken: boolean
  [key: string]: unknown
}

function normalizeSupplementsDoc(body: Record<string, unknown>): SupplementsLogDoc {
  const doc = { ...body }
  if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
  if (doc.taken === undefined) doc.taken = false
  return doc as SupplementsLogDoc
}

function toggleTaken(current: boolean): boolean {
  return !current
}

function sortByTiming(a: { timing?: string }, b: { timing?: string }): number {
  const order = ['morning', 'pre_meal', 'pre_workout', 'evening']
  const ai = order.indexOf(a.timing || '')
  const bi = order.indexOf(b.timing || '')
  if (ai === -1 && bi === -1) return 0
  if (ai === -1) return 1
  if (bi === -1) return -1
  return ai - bi
}

// --- Tests ---

describe('normalizeSupplementsDoc — doc defaults', () => {
  it('auto-sets date when missing', () => {
    const doc = normalizeSupplementsDoc({ name: 'Vitamin D3', dose: '2000 IU' })
    expect(doc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('preserves provided date', () => {
    const doc = normalizeSupplementsDoc({ date: '2026-04-10', name: 'Vitamin D3' })
    expect(doc.date).toBe('2026-04-10')
  })

  it('defaults taken to false', () => {
    const doc = normalizeSupplementsDoc({ name: 'ZMA' })
    expect(doc.taken).toBe(false)
  })

  it('preserves taken=true if provided', () => {
    const doc = normalizeSupplementsDoc({ name: 'ZMA', taken: true })
    expect(doc.taken).toBe(true)
  })

  it('preserves taken=false if explicitly set', () => {
    const doc = normalizeSupplementsDoc({ name: 'ZMA', taken: false })
    expect(doc.taken).toBe(false)
  })

  it('preserves all other fields', () => {
    const doc = normalizeSupplementsDoc({
      name: 'Omega-3',
      dose: '2g',
      timing: 'morning',
    })
    expect(doc.name).toBe('Omega-3')
    expect(doc.dose).toBe('2g')
    expect(doc.timing).toBe('morning')
  })
})

describe('toggleTaken — taken status toggle', () => {
  it('false → true', () => {
    expect(toggleTaken(false)).toBe(true)
  })

  it('true → false', () => {
    expect(toggleTaken(true)).toBe(false)
  })

  it('double toggle returns original', () => {
    expect(toggleTaken(toggleTaken(false))).toBe(false)
    expect(toggleTaken(toggleTaken(true))).toBe(true)
  })
})

describe('sortByTiming — supplement schedule ordering', () => {
  it('morning before pre_meal before pre_workout before evening', () => {
    const sorted = [
      { timing: 'evening' },
      { timing: 'morning' },
      { timing: 'pre_workout' },
      { timing: 'pre_meal' },
    ].sort(sortByTiming)

    expect(sorted[0].timing).toBe('morning')
    expect(sorted[1].timing).toBe('pre_meal')
    expect(sorted[2].timing).toBe('pre_workout')
    expect(sorted[3].timing).toBe('evening')
  })

  it('unknown timing goes to end', () => {
    const sorted = [
      { timing: 'morning' },
      { timing: 'unknown' },
    ].sort(sortByTiming)
    expect(sorted[0].timing).toBe('morning')
    expect(sorted[1].timing).toBe('unknown')
  })
})
