/**
 * Unit tests for the pure helpers exported from
 * scripts/fill-supplement-knowledge-1485.js (#1487, stage B of #1485,
 * design D5). Full Gemini/Mongo I/O is NOT exercised here — that's covered
 * by a live --dry-run run against the real vault + real Mongo (closing
 * comment proof); these tests cover the deterministic target-selection logic
 * that decides WHICH catalog items need an LLM call at all.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTargets, needsFill, supplementLabel } = require('../../scripts/fill-supplement-knowledge-1485')

describe('buildTargets — D4 target set (catalog items + orphaned knowledge docs)', () => {
  it('includes every catalog item (active and archived)', () => {
    const catalog = [{ id: 1, name: 'A', active: true }, { id: 2, name: 'B', active: false }]
    const targets = buildTargets(catalog, [])
    expect(targets.map((t: any) => t.catalog_id).sort()).toEqual([1, 2])
  })

  it('includes a knowledge doc whose catalog_id has NO matching catalog row (D4: ids 4/5/14)', () => {
    const catalog = [{ id: 1, name: 'A' }]
    const knowledge = [{ catalog_id: 14, name: 'Orphaned Item' }]
    const targets = buildTargets(catalog, knowledge)
    expect(targets.map((t: any) => t.catalog_id).sort()).toEqual([1, 14])
    const orphan = targets.find((t: any) => t.catalog_id === 14)
    expect(orphan.catalogDoc).toBeNull()
    expect(orphan.knowledgeDoc).toEqual(knowledge[0])
  })

  it('a catalog item WITH a matching knowledge doc carries both', () => {
    const catalog = [{ id: 3, name: 'Creatine' }]
    const knowledge = [{ catalog_id: 3, cycle: { duration_weeks: 8, pause_weeks: 4 } }]
    const targets = buildTargets(catalog, knowledge)
    expect(targets).toHaveLength(1)
    expect(targets[0].catalogDoc).toEqual(catalog[0])
    expect(targets[0].knowledgeDoc).toEqual(knowledge[0])
  })

  it('11 catalog items (none numbered 4/5/14) + 3 orphaned knowledge ids (4,5,14) -> 14 targets, matching Apex measurement', () => {
    const catalogIds = [1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13] // 11 items, deliberately skips 4/5/14
    const catalog = catalogIds.map(id => ({ id, name: `Item${id}` }))
    const knowledge = [
      ...catalog.filter(c => c.id !== 10).map(c => ({ catalog_id: c.id })), // 10 has no knowledge (Lion's Mane)
      { catalog_id: 4 }, { catalog_id: 5 }, { catalog_id: 14 }, // orphaned per D4 — no catalog row
    ]
    const targets = buildTargets(catalog, knowledge)
    expect(targets).toHaveLength(14)
  })
})

describe('needsFill', () => {
  it('a target with no knowledge doc at all needs filling', () => {
    expect(needsFill({ catalog_id: 10, knowledgeDoc: null })).toBe(true)
  })
  it('a knowledge doc with continuous:undefined needs filling', () => {
    expect(needsFill({ knowledgeDoc: { catalog_id: 1, purchase_url: 'x' } })).toBe(true)
  })
  it('a knowledge doc with continuous SET and no cycle needs no fill', () => {
    expect(needsFill({ knowledgeDoc: { catalog_id: 1, continuous: true, cycle: null } })).toBe(false)
  })
  it('D4 special case: continuous SET, cycle present but missing .source still needs (partial) fill', () => {
    expect(needsFill({ knowledgeDoc: { catalog_id: 3, continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } } })).toBe(true)
  })
  it('a fully complete doc (continuous set, cycle.source set) needs no fill', () => {
    expect(needsFill({ knowledgeDoc: { catalog_id: 3, continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4, source: { kind: 'confirms', by: 'koliada', ref: 'Lesson 1', quote: 'x' } } } })).toBe(false)
  })
  // #1487 real bug (see lib/supplement-knowledge-fill.js header): a doc left
  // with continuous:false + cycle:null (or any invalid cycle) is a broken
  // state, not "complete" — must be re-offered so it self-heals.
  it('continuous:false with cycle:null (the exact live bug shape) needs re-fill, is never silently treated as complete', () => {
    expect(needsFill({ knowledgeDoc: { catalog_id: 12, continuous: false, cycle: null } })).toBe(true)
  })
  it('continuous:false with a cycle missing duration_weeks needs re-fill', () => {
    expect(needsFill({ knowledgeDoc: { catalog_id: 12, continuous: false, cycle: { source: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' } } } })).toBe(true)
  })
})

describe('supplementLabel', () => {
  it('prefers catalogDoc brand + short_name when a catalog row exists', () => {
    expect(supplementLabel({ brand: 'GymBeam', short_name: 'Vitamin D3', name: 'GymBeam Vitamin D3' }, null)).toBe('GymBeam Vitamin D3')
  })
  it('falls back to the knowledge doc name for an orphaned target', () => {
    expect(supplementLabel(null, { catalog_id: 14, name: 'Old Vitamin C' })).toBe('Old Vitamin C')
  })
  it('falls back to catalog_id when neither has a usable name', () => {
    expect(supplementLabel(null, { catalog_id: 14 })).toBe('catalog_id 14')
  })
})

export {}
