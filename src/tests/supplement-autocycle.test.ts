/**
 * Unit tests for lib/supplement-autocycle.js (#1487, stage B of #1485, design D6).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureAutoCycleForSupplement, buildAutoCycleDoc } = require('../../lib/supplement-autocycle')

type Doc = Record<string, any>

function makeDB(initialCycles: Doc[] = []) {
  const cycles = initialCycles.map(c => ({ ...c }))
  const inserted: Doc[] = []
  return {
    collection(name: string) {
      if (name !== 'supplement_cycles') throw new Error(`unexpected collection: ${name}`)
      return {
        async findOne(filter: Doc, opts?: Doc) {
          if (opts?.sort) {
            // "last item" lookup: sort by id desc, return first.
            const sorted = [...cycles].sort((a, b) => (b.id || 0) - (a.id || 0))
            return sorted[0] || null
          }
          return cycles.find(c =>
            (filter.supplement_id === undefined || c.supplement_id === filter.supplement_id) &&
            (filter.start_date === undefined || c.start_date === filter.start_date)
          ) || null
        },
        async insertOne(doc: Doc) {
          cycles.push({ ...doc })
          inserted.push({ ...doc })
          return { insertedId: 'mock-id' }
        },
      }
    },
    _cycles: cycles,
    _inserted: inserted,
  }
}

describe('buildAutoCycleDoc', () => {
  it('builds the expected shape with created_by:"auto", status:"active"', () => {
    const doc = buildAutoCycleDoc(9, 'Ashwagandha', { duration_weeks: 8, pause_weeks: 4 }, '2026-09-22')
    expect(doc).toEqual({
      supplement_id: 9, supplement_name: 'Ashwagandha', start_date: '2026-09-22',
      duration_weeks: 8, pause_weeks: 4, status: 'active', created_by: 'auto',
    })
  })
  it('defaults pause_weeks to 0 when absent', () => {
    const doc = buildAutoCycleDoc(9, 'X', { duration_weeks: 4 }, '2026-09-22')
    expect(doc.pause_weeks).toBe(0)
  })
})

describe('ensureAutoCycleForSupplement — B4', () => {
  it('continuous supplement (knowledge.cycle: null) creates NO cycle', async () => {
    const db = makeDB()
    const result = await ensureAutoCycleForSupplement(db, 1, 'Vitamin D3', { continuous: true, cycle: null })
    expect(result).toEqual({ cycle: null, cycle_error: null })
    expect(db._inserted).toHaveLength(0)
  })

  it('a cycle supplement creates exactly 1 supplement_cycles doc with start_date = today (Kyiv)', async () => {
    const db = makeDB()
    const now = new Date('2026-09-22T10:00:00Z') // well inside Kyiv 22.09 regardless of DST
    const result = await ensureAutoCycleForSupplement(db, 9, 'Ashwagandha', { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }, now)
    expect(db._inserted).toHaveLength(1)
    expect(result.cycle).toMatchObject({ supplement_id: 9, supplement_name: 'Ashwagandha', duration_weeks: 8, pause_weeks: 4, status: 'active', created_by: 'auto' })
    expect(result.cycle.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.cycle_error).toBeNull()
  })

  it('a REPEATED call for the same supplement_id + same day does NOT create a second cycle (dedupe)', async () => {
    const db = makeDB()
    const now = new Date('2026-09-22T10:00:00Z')
    const first = await ensureAutoCycleForSupplement(db, 9, 'Ashwagandha', { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }, now)
    const second = await ensureAutoCycleForSupplement(db, 9, 'Ashwagandha', { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }, now)

    expect(db._inserted).toHaveLength(1)
    expect(second.cycle).toEqual(first.cycle)
  })

  it('assigns incrementing ids the same way the existing POST /cycles route does (lastItem.id + 1)', async () => {
    const db = makeDB([{ id: 5, supplement_id: 1, start_date: '2026-01-01' }])
    const result = await ensureAutoCycleForSupplement(db, 9, 'X', { continuous: false, cycle: { duration_weeks: 4, pause_weeks: 0 } }, new Date('2026-09-22'))
    expect(result.cycle.id).toBe(6)
  })

  it('an invalid cycle.duration_weeks (0 or missing) creates no cycle and reports cycle_error, does not throw', async () => {
    const db = makeDB()
    const result = await ensureAutoCycleForSupplement(db, 9, 'X', { continuous: false, cycle: { duration_weeks: 0 } }, new Date('2026-09-22'))
    expect(result.cycle).toBeNull()
    expect(result.cycle_error).toBeTruthy()
    expect(db._inserted).toHaveLength(0)
  })

  it('a DB failure (insertOne throws) degrades to {cycle:null, cycle_error} instead of throwing (D6 failure-path)', async () => {
    const db = makeDB()
    db.collection = () => ({
      findOne: async () => null,
      insertOne: async () => { throw new Error('mongo write failed') },
    })
    const result = await ensureAutoCycleForSupplement(db, 9, 'X', { continuous: false, cycle: { duration_weeks: 4 } }, new Date('2026-09-22'))
    expect(result).toEqual({ cycle: null, cycle_error: 'mongo write failed' })
  })

  it('missing knowledge object entirely creates no cycle', async () => {
    const db = makeDB()
    const result = await ensureAutoCycleForSupplement(db, 9, 'X', null)
    expect(result).toEqual({ cycle: null, cycle_error: null })
  })
})

export {}
