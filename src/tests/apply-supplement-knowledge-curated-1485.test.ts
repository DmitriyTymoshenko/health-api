/**
 * Unit tests for scripts/apply-supplement-knowledge-curated-1485.js (#1490,
 * stage F of #1485). Exercises the pure `buildFieldsToWrite()` gate against
 * the REAL Koliada corpus (lib/koliada-corpus.js reads the live vault files
 * on disk — no mock) so a passing test here is proof the grounding checks
 * actually discriminate real quotes from fabricated ones, not proof of a
 * mocked validator's own logic.
 *
 * RED-FIRST PROOF (rules/dev-protocol.md §"RED-FIRST PROOF for any
 * guard/gate/monitor"): this gate's job is exactly "detect an ungrounded
 * claim and refuse to write it" — so before asserting the happy path, we
 * assert it actually turns RED on a genuine fabricated quote and a genuine
 * invariant violation.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildFieldsToWrite } = require('../../scripts/apply-supplement-knowledge-curated-1485')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadCorpus } = require('../../lib/koliada-corpus')

const { text: REAL_CORPUS } = loadCorpus()

describe('sanity: real corpus is actually loaded (guards against a silent empty-corpus false-green)', () => {
  it('the live vault corpus is non-empty', () => {
    expect(REAL_CORPUS.length).toBeGreaterThan(10000)
  })
})

describe('buildFieldsToWrite — RED: a fabricated koliada quote is dropped, not written', () => {
  it('a quote that is NOT a literal substring of the corpus is downgraded and continuous_source is omitted', () => {
    const record = {
      catalog_id: 999,
      continuous: true,
      cycle: null,
      continuous_source: {
        kind: 'confirms',
        by: 'koliada',
        ref: 'Lesson 60',
        quote: 'This exact sentence was never said by Koliada anywhere in the corpus, it is fabricated for the test.',
      },
    }
    const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
    expect(set.continuous_source).toBeUndefined()
    expect(dropped.some((d: any) => d.field === 'continuous_source')).toBe(true)
  })

  it('a real quote but a malformed lesson ref (no "Lesson N"/"урок N") is also dropped', () => {
    const record = {
      catalog_id: 999,
      continuous: true,
      cycle: null,
      continuous_source: {
        kind: 'confirms',
        by: 'koliada',
        ref: 'somewhere in the course',
        quote: 'psyllium husk mixed into yogurt (swells quickly, easy to eat a useful dose)',
      },
    }
    const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
    expect(set.continuous_source).toBeUndefined()
    expect(dropped.some((d: any) => d.field === 'continuous_source')).toBe(true)
  })

  it('an external source on a non-allowlisted domain is dropped', () => {
    const record = {
      catalog_id: 999,
      continuous: true,
      cycle: null,
      continuous_source: { kind: 'confirms', by: 'external', ref: 'https://wikipedia.org/wiki/Creatine' },
    }
    const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
    expect(set.continuous_source).toBeUndefined()
    expect(dropped.some((d: any) => d.field === 'continuous_source')).toBe(true)
  })

  it('a fabricated interaction source quote is dropped from interactions[] but does not block the rest of the record', () => {
    const record = {
      catalog_id: 999,
      continuous: true,
      cycle: null,
      active_ingredients: [{ name: 'X', nutrient_key: 'zinc', amount_per_dose: 1, unit: 'mg' }],
      interactions: [
        { with: 'iron', kind: 'conflict', rule: 'separate', source: { kind: 'confirms', by: 'koliada', ref: 'Lesson 5', quote: 'fully fabricated interaction claim not present anywhere in the corpus text' } },
      ],
    }
    const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
    expect(set.interactions).toEqual([])
    expect(set.active_ingredients).toHaveLength(1)
    expect(dropped.some((d: any) => String(d.field).includes('interactions'))).toBe(true)
  })
})

describe('buildFieldsToWrite — RED: continuous/cycle invariant violation blocks the whole continuous/cycle/source write', () => {
  it('continuous:true with a non-null cycle is rejected — continuous_source/cycle are not written', () => {
    const record = {
      catalog_id: 999,
      continuous: true,
      cycle: { duration_weeks: 8, pause_weeks: 4 },
      continuous_source: { kind: 'confirms', by: 'koliada', ref: 'Lesson 1', quote: 'psyllium husk mixed into yogurt' },
    }
    const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
    expect(set.continuous).toBeUndefined()
    expect(set.cycle).toBeUndefined()
    expect(set.continuous_source).toBeUndefined()
    expect(dropped.some((d: any) => d.field === 'continuous/cycle')).toBe(true)
  })
})

describe('buildFieldsToWrite — GREEN: real curated data passes every gate for all 14 catalog items', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const curated = require('../../data/supplement-knowledge-curated-1485.json')

  it('the curated dataset covers exactly the 14 documented catalog ids', () => {
    const ids = curated.map((r: any) => r.catalog_id).sort((a: number, b: number) => a - b)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 19])
  })

  it('every record\'s continuous_source survives grounding (ref present, kind !== not_covered)', () => {
    for (const record of curated) {
      const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
      expect(dropped).toEqual([])
      expect(set.continuous_source).toBeDefined()
      expect(set.continuous_source.kind).not.toBe('not_covered')
      expect(set.continuous_source.ref).toBeTruthy()
    }
  })

  it('at least 8 of the 14 records are koliada-sourced (F-A acceptance)', () => {
    const koliadaCount = curated.filter((record: any) => {
      const { set } = buildFieldsToWrite(record, REAL_CORPUS)
      return set.continuous_source && set.continuous_source.by === 'koliada'
    }).length
    expect(koliadaCount).toBeGreaterThanOrEqual(8)
  })

  it('every active_ingredients[] entry across all 14 records has a nutrient_key (F-C acceptance)', () => {
    for (const record of curated) {
      for (const ing of record.active_ingredients || []) {
        expect(ing.nutrient_key).toBeTruthy()
      }
    }
  })

  it('catalog_id 3 (Creatine) satisfies the invariant: continuous:true, cycle:null (F-B fix)', () => {
    const record = curated.find((r: any) => r.catalog_id === 3)
    const { set } = buildFieldsToWrite(record, REAL_CORPUS)
    expect(set.continuous).toBe(true)
    expect(set.cycle).toBeNull()
  })

  it('no record violates the continuous/cycle invariant after the gate runs', () => {
    for (const record of curated) {
      const { dropped } = buildFieldsToWrite(record, REAL_CORPUS)
      expect(dropped.some((d: any) => d.field === 'continuous/cycle')).toBe(false)
    }
  })

  it('every interactions[] entry across all 14 records survives grounding (0 silently dropped)', () => {
    for (const record of curated) {
      const { set, dropped } = buildFieldsToWrite(record, REAL_CORPUS)
      const claimedCount = (record.interactions || []).length
      expect(set.interactions).toHaveLength(claimedCount)
      expect(dropped.filter((d: any) => String(d.field).includes('interactions'))).toEqual([])
    }
  })
})

export {}
