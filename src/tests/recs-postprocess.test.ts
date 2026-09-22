/**
 * Unit tests for lib/recs-postprocess.js (#1488, stage C of #1485, acceptance C2).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeForMatch, findStackMatch, postprocessOne, postprocessRecommendations } = require('../../lib/recs-postprocess')

const CORPUS = `In Lesson 12, Koliada explains that vitamin D absorption improves with fat-soluble co-ingestion.
Per урок 27, creatine monohydrate has no established need for cycling.`

const ACTIVE_STACK = [
  { id: 1, short_name: 'Creatine HCl', name: 'Amix Creatine HCl' },
  { id: 2, short_name: 'Vitamin D3', name: 'GymBeam Vitamin D3' },
]

function koliadaVerdict(kind: string, overrides: Record<string, unknown> = {}) {
  return { kind, by: 'koliada', ref: 'Lesson 12', quote: 'vitamin D absorption improves with fat-soluble co-ingestion', ...overrides }
}

describe('normalizeForMatch / findStackMatch — ported from dashboard #1426/#1427', () => {
  it('matches case/spacing/Cyrillic-insensitively, same as the dashboard version', () => {
    expect(normalizeForMatch('  Vitamin   D3  ')).toBe(normalizeForMatch('vitamin d3'))
  })
  it('findStackMatch finds by short_name', () => {
    expect(findStackMatch('creatine hcl', ACTIVE_STACK)).toMatchObject({ id: 1 })
  })
  it('findStackMatch returns null for a genuine miss', () => {
    expect(findStackMatch('Magnesium Glycinate', ACTIVE_STACK)).toBeNull()
  })
})

describe('postprocessOne — Rule 2: against never becomes a recommendation', () => {
  it('an against verdict targeting a stack item -> null rec + warning with supplement_id', () => {
    const raw = { key: 'creatine', name: 'Creatine HCl', source: 'koliada', verdict: koliadaVerdict('against', { ref: 'урок 27', quote: 'creatine monohydrate has no established need for cycling' }) }
    const { rec, warning } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec).toBeNull()
    expect(warning).toEqual({ type: 'against', supplement_id: 1, name: 'Creatine HCl', verdict: { kind: 'against', by: 'koliada', ref: 'урок 27', quote: 'creatine monohydrate has no established need for cycling' } })
  })

  it('an against verdict on something NOT in the stack -> silently dropped, no warning', () => {
    const raw = { key: 'x', name: 'Some New Herb', source: 'external', verdict: { kind: 'against', by: 'external', ref: 'https://examine.com/x' } }
    const { rec, warning } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec).toBeNull()
    expect(warning).toBeNull()
  })
})

describe('postprocessOne — Rule 3: invalid koliada citation downgrades the verdict', () => {
  it('a fabricated quote downgrades kind to not_covered, rec still created (not_covered is a valid recommendation state)', () => {
    const raw = { key: 'x', name: 'New Supplement', source: 'koliada', verdict: koliadaVerdict('confirms', { quote: 'this sentence was never said' }) }
    const { rec } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec.verdict).toEqual({ kind: 'not_covered', by: 'external' })
  })
})

describe('postprocessOne — Rule 3: stale lab source is dropped regardless of what the LLM claims', () => {
  it('age_days > 30 -> dropped with a stale_lab warning', () => {
    const raw = { key: 'vitamin_d', name: 'Vitamin D3 boost', source: 'lab', lab: { marker: 'vitamin_d', age_days: 45, test_date: '2026-08-08' }, verdict: koliadaVerdict('confirms') }
    const { rec, warning } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec).toBeNull()
    expect(warning).toEqual({ type: 'stale_lab', marker: 'vitamin_d', age_days: 45, test_date: '2026-08-08' })
  })
  it('age_days === 30 (boundary) is still fresh, rec is created', () => {
    const raw = { key: 'vitamin_d', name: 'New Vit D Item', source: 'lab', lab: { marker: 'vitamin_d', age_days: 30, test_date: '2026-08-23' }, verdict: koliadaVerdict('confirms') }
    const { rec, warning } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(warning).toBeNull()
    expect(rec).not.toBeNull()
  })
  it('missing age_days (LLM omitted it) fails CLOSED — treated as stale', () => {
    const raw = { key: 'vitamin_d', name: 'X', source: 'lab', lab: { marker: 'vitamin_d' }, verdict: koliadaVerdict('confirms') }
    const { rec, warning } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec).toBeNull()
    expect(warning?.type).toBe('stale_lab')
  })
})

describe('postprocessOne — Rule 5: dedupe against the active stack', () => {
  it('a candidate matching an active stack item (by short_name, the field findStackMatch actually compares) is dropped, no rec, no warning', () => {
    const raw = { key: 'x', name: 'Vitamin D3', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' } }
    const { rec, warning } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec).toBeNull()
    expect(warning).toBeNull()
  })
  it('a genuinely new candidate (no stack match) is kept', () => {
    const raw = { key: 'x', name: 'Magnesium Glycinate', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' } }
    const { rec } = postprocessOne(raw, { activeStack: ACTIVE_STACK, corpusText: CORPUS })
    expect(rec).not.toBeNull()
    expect(rec.name).toBe('Magnesium Glycinate')
  })
})

describe('postprocessRecommendations — Rule 4: affects only lists continuous:false stack items', () => {
  it('a stale_lab warning\'s affects[] includes ONLY the continuous:false supplement, excludes the continuous:true one', () => {
    const knowledgeByCatalogId = new Map([
      [1, { catalog_id: 1, continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }], // Creatine — cyclic
      [2, { catalog_id: 2, continuous: true, cycle: null }], // Vitamin D3 — continuous
    ])
    const rawItems = [
      { key: 'vitamin_d', name: 'X', source: 'lab', lab: { marker: 'vitamin_d', age_days: 45, test_date: '2026-08-08' }, verdict: koliadaVerdict('confirms') },
    ]
    const { recommendations, warnings } = postprocessRecommendations(rawItems, { activeStack: ACTIVE_STACK, knowledgeByCatalogId, corpusText: CORPUS })
    expect(recommendations).toHaveLength(0)
    const staleWarning = warnings.find((w: any) => w.type === 'stale_lab')
    expect(staleWarning.affects).toEqual(['Creatine HCl'])
    expect(staleWarning.affects).not.toContain('Vitamin D3')
  })

  it('multiple candidates for the SAME stale marker produce only ONE stale_lab warning entry', () => {
    const knowledgeByCatalogId = new Map()
    const rawItems = [
      { key: 'vitamin_d', name: 'A', source: 'lab', lab: { marker: 'vitamin_d', age_days: 40, test_date: '2026-08-13' }, verdict: koliadaVerdict('confirms') },
      { key: 'vitamin_d', name: 'B', source: 'lab', lab: { marker: 'vitamin_d', age_days: 40, test_date: '2026-08-13' }, verdict: koliadaVerdict('neutral') },
    ]
    const { warnings } = postprocessRecommendations(rawItems, { activeStack: [], knowledgeByCatalogId, corpusText: CORPUS })
    expect(warnings.filter((w: any) => w.type === 'stale_lab')).toHaveLength(1)
  })

  it('end-to-end: mixed batch produces the right recommendations + warnings split', () => {
    const knowledgeByCatalogId = new Map([[1, { catalog_id: 1, continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }]])
    const rawItems = [
      { key: 'ok1', name: 'Magnesium Glycinate', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/mg' } }, // kept
      { key: 'ok2', name: 'Creatine HCl', source: 'koliada', verdict: koliadaVerdict('against', { ref: 'урок 27', quote: 'creatine monohydrate has no established need for cycling' }) }, // -> against warning
      { key: 'stale', name: 'X', source: 'lab', lab: { marker: 'vitamin_d', age_days: 99, test_date: '2026-06-15' }, verdict: koliadaVerdict('confirms') }, // -> stale warning
      { key: 'dupe', name: 'Vitamin D3', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/d' } }, // dedupe, silent
    ]
    const { recommendations, warnings } = postprocessRecommendations(rawItems, { activeStack: ACTIVE_STACK, knowledgeByCatalogId, corpusText: CORPUS })
    expect(recommendations).toHaveLength(1)
    expect(recommendations[0].name).toBe('Magnesium Glycinate')
    expect(warnings).toHaveLength(2)
    expect(warnings.find((w: any) => w.type === 'against')).toMatchObject({ supplement_id: 1, name: 'Creatine HCl' })
    expect(warnings.find((w: any) => w.type === 'stale_lab')).toMatchObject({ marker: 'vitamin_d', age_days: 99 })
  })
})

export {}
