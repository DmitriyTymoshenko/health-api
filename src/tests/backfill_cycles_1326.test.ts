/**
 * #1326 backfill script — unit tests for the pure/DB-facing logic in
 * scripts/backfill-cycles-1326.js. The script's job is to fill 64
 * `whoop_cycles` documents that are missing for existing `whoop_recovery`
 * rows; it must NEVER touch `whoop_recovery` and must NEVER self-refresh the
 * WHOOP token (one-shot refresh_token — see sync-whoop.js).
 */

const { findCandidates, checkTokenFreshness, postState } = require('../../scripts/backfill-cycles-1326.js')

// Fake Mongo collection — supports exactly what the script calls: distinct(),
// find({...}).project({...}).toArray(), find({}).toArray(). Same stub pattern
// as src/tests/whoop_weekly_compare_route_1411.test.ts / nutrition_summary_route.test.ts.
function fakeDb({ recoveryCycleIds, cyclesDocs }: { recoveryCycleIds: string[]; cyclesDocs: any[] }) {
  return {
    collection(name: string) {
      if (name === 'whoop_recovery') {
        return {
          distinct: async (_field: string) => recoveryCycleIds,
        }
      }
      if (name === 'whoop_cycles') {
        return {
          distinct: async (_field: string) => cyclesDocs.map(d => d.cycle_id),
          find: (filter: any) => {
            if (filter && filter.end === null) {
              const open = cyclesDocs.filter(d => d.end == null)
              return { project: () => ({ toArray: async () => open.map(d => ({ cycle_id: d.cycle_id })) }) }
            }
            // find({}) — postState's full scan
            return { toArray: async () => cyclesDocs }
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
}

describe('findCandidates — whoop_recovery cycle_ids with no whoop_cycles doc, open cycle excluded', () => {
  it('returns exactly the missing ids, sorted, excluding an open cycle even though it also has no closed doc', async () => {
    const db = fakeDb({
      recoveryCycleIds: ['300', '100', '200', '999'], // 999 = open cycle, must be excluded
      cyclesDocs: [
        { cycle_id: '100', end: '2026-01-01T12:00:00Z', start: '2026-01-01T00:20:00Z', date: '2026-01-01' },
        { cycle_id: '999', end: null, start: '2026-09-19T21:08:00Z', date: '2026-09-19' }, // open, no closed doc for 999 either but excluded
      ],
    })
    const missing = await findCandidates(db as any)
    expect(missing).toEqual(['200', '300'])
  })

  it('returns empty when every recovery cycle_id already has a whoop_cycles doc', async () => {
    const db = fakeDb({
      recoveryCycleIds: ['1', '2'],
      cyclesDocs: [
        { cycle_id: '1', end: '2026-01-01T12:00:00Z', start: '2026-01-01T00:20:00Z', date: '2026-01-01' },
        { cycle_id: '2', end: '2026-01-02T12:00:00Z', start: '2026-01-02T00:20:00Z', date: '2026-01-02' },
      ],
    })
    expect(await findCandidates(db as any)).toEqual([])
  })

  it('live-shaped case: 64 recovery cycle_ids missing out of a larger set, matches the #1326 approved target', async () => {
    const closedIds = Array.from({ length: 553 }, (_, i) => `c${i}`)
    const missingIds = Array.from({ length: 64 }, (_, i) => `m${i}`)
    const openId = 'open1'
    const db = fakeDb({
      recoveryCycleIds: [...closedIds, ...missingIds, openId],
      cyclesDocs: [
        ...closedIds.map(id => ({ cycle_id: id, end: '2026-01-01T12:00:00Z', start: '2026-01-01T00:20:00Z', date: '2026-01-01' })),
        { cycle_id: openId, end: null, start: '2026-09-19T21:00:00Z', date: '2026-09-19' },
      ],
    })
    const missing = await findCandidates(db as any)
    expect(missing.length).toBe(64)
    expect(missing.sort()).toEqual(missingIds.sort())
  })
})

describe('checkTokenFreshness — read-only, NEVER triggers a refresh', () => {
  it('fresh=true when now is before token_expires_at', () => {
    const now = new Date('2026-09-19T12:00:00Z').getTime()
    const creds = { access_token: 'tok-abc', token_expires_at: '2026-09-19T13:00:00Z' }
    const r = checkTokenFreshness(creds, now)
    expect(r.fresh).toBe(true)
    expect(r.token).toBe('tok-abc')
    expect(r.minsLeft).toBe(60)
  })

  it('fresh=false when now is after token_expires_at (the live #1326 state: expired ~29min before this session)', () => {
    const now = new Date('2026-09-19T11:52:00Z').getTime()
    const creds = { access_token: 'tok-abc', token_expires_at: '2026-09-19T11:23:01.563Z' }
    const r = checkTokenFreshness(creds, now)
    expect(r.fresh).toBe(false)
    expect(r.minsLeft).toBeLessThan(0)
  })

  it('fresh=false at the exact expiry instant (boundary, not >=)', () => {
    const now = new Date('2026-09-19T11:23:01.563Z').getTime()
    const creds = { access_token: 'tok-abc', token_expires_at: '2026-09-19T11:23:01.563Z' }
    const r = checkTokenFreshness(creds, now)
    expect(r.fresh).toBe(false)
  })
})

describe('postState — dup groups, Rule B offset histogram, remaining no_cycle_doc, after a simulated backfill', () => {
  it('reports 0 dup groups and 100% Rule-B-aligned closed docs when data is already canonical', async () => {
    const cyclesDocs = [
      // start=2026-01-01T00:20:00Z -> KyivDay(start+12h) = 2026-01-01 (Rule B)
      { cycle_id: 'a', start: '2026-01-01T00:20:00Z', end: '2026-01-01T23:00:00Z', date: '2026-01-01' },
      { cycle_id: 'b', start: '2026-01-02T00:20:00Z', end: '2026-01-02T23:00:00Z', date: '2026-01-02' },
    ]
    const db = fakeDb({ recoveryCycleIds: ['a', 'b'], cyclesDocs })
    const state = await postState(db as any)
    expect(state.dupGroups).toBe(0)
    expect(state.offsetHist).toEqual({ 0: 2 })
    expect(state.remainingNoCycleDoc).toBe(0)
    expect(state.total).toBe(2)
    expect(state.closed).toBe(2)
  })

  it('flags a mismatch bucket when a closed doc date disagrees with Rule B (regression guard)', async () => {
    const cyclesDocs = [
      { cycle_id: 'a', start: '2026-01-01T00:20:00Z', end: '2026-01-01T23:00:00Z', date: '2099-01-01' }, // wrong date on purpose
    ]
    const db = fakeDb({ recoveryCycleIds: ['a'], cyclesDocs })
    const state = await postState(db as any)
    expect(state.offsetHist.mismatch).toBe(1)
  })
})

export {}
