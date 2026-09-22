/**
 * Unit tests for lib/supplement-knowledge-fill.js (#1487, stage B of #1485, design D5).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeFieldsToWrite, buildPrompt } = require('../../lib/supplement-knowledge-fill')

const KOLIADA_SOURCE = { kind: 'confirms', by: 'koliada', ref: 'Lesson 12', quote: 'x' }
const NOT_COVERED = { kind: 'not_covered', by: 'external' }

describe('computeFieldsToWrite — D5 "only write empty fields"', () => {
  it('a doc with continuous:undefined (never filled) + continuous:true result -> sets continuous + cycle:null + continuous_source', () => {
    const out = computeFieldsToWrite({}, { continuous: true, cycle: null }, KOLIADA_SOURCE, null)
    expect(out).toEqual({ continuous: true, cycle: null, continuous_source: KOLIADA_SOURCE })
  })

  it('a doc with continuous:undefined + continuous:false result -> sets continuous + cycle object WITH source embedded', () => {
    const out = computeFieldsToWrite({}, { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }, KOLIADA_SOURCE, null)
    expect(out).toEqual({ continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4, source: KOLIADA_SOURCE } })
  })

  it('a doc that already has continuous SET is completely untouched on that field, even if the LLM disagrees', () => {
    const existing = { continuous: true, cycle: null }
    const out = computeFieldsToWrite(existing, { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }, KOLIADA_SOURCE, null)
    expect(out.continuous).toBeUndefined()
    expect(out.cycle).toBeUndefined()
  })

  it('D4 special case: catalog_id 3 has a real cycle {duration_weeks:8,pause_weeks:4} with NO source — only cycle.source is added, duration/pause untouched', () => {
    // continuous is already set (owner data) so only the cycle.source gap remains.
    const existingWithContinuous = { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }
    const out = computeFieldsToWrite(existingWithContinuous, { continuous: false, cycle: { duration_weeks: 99, pause_weeks: 99 } }, KOLIADA_SOURCE, null)
    expect(out).toEqual({ 'cycle.source': KOLIADA_SOURCE })
    // Proves duration_weeks/pause_weeks from the (wrong) LLM result never leak in.
    expect(out.cycle).toBeUndefined()
  })

  it('a fully-filled doc (continuous set, cycle.source set, purchase_url set) writes NOTHING', () => {
    const existing = { continuous: true, cycle: null, continuous_source: KOLIADA_SOURCE, purchase_url: 'https://x.com', purchase_verified: false }
    const out = computeFieldsToWrite(existing, { continuous: false, cycle: { duration_weeks: 4, pause_weeks: 0 } }, KOLIADA_SOURCE, 'https://y.com')
    expect(out).toEqual({})
  })

  it('purchase_url is added only when missing, and only when the LLM actually returned one', () => {
    const out1 = computeFieldsToWrite({ continuous: true, cycle: null, continuous_source: KOLIADA_SOURCE }, { continuous: true, cycle: null }, KOLIADA_SOURCE, 'https://examine.com/x')
    expect(out1).toEqual({ purchase_url: 'https://examine.com/x', purchase_verified: false })

    const out2 = computeFieldsToWrite({ continuous: true, cycle: null, continuous_source: KOLIADA_SOURCE }, { continuous: true, cycle: null }, KOLIADA_SOURCE, null)
    expect(out2).toEqual({})
  })

  it('an ungrounded verdict (NOT_COVERED) still writes continuous/cycle — the classification stands, only the citation is downgraded', () => {
    const out = computeFieldsToWrite({}, { continuous: true, cycle: null }, NOT_COVERED, null)
    expect(out).toEqual({ continuous: true, cycle: null, continuous_source: NOT_COVERED })
  })

  // #1487 REAL BUG (found live, --apply run on 22.09): Gemini's schema marks
  // `cycle` nullable:true unconditionally (no way to express "nullable only
  // when continuous=false"), so it legally returned
  // `{continuous:false, cycle:null}` for catalog_id 12 (Beta-Alanine). The
  // pre-fix version of this function wrote `{cycle:{source:...}}` with NO
  // duration_weeks/pause_weeks — violating the exact invariant
  // lib/validate.js::validateKnowledgeCycleInvariant enforces at the HTTP
  // layer (bypassed here since the script writes to Mongo directly). RED
  // (pre-fix behaviour, reproduced against the CURRENT code by asserting it
  // now throws instead of silently returning the broken shape):
  it('continuous:false with cycle:null (the exact live bug input) THROWS instead of writing a broken cycle', () => {
    expect(() => computeFieldsToWrite({}, { continuous: false, cycle: null }, NOT_COVERED, null)).toThrow(/continuous:false requires a valid cycle/)
  })

  it('continuous:false with a cycle missing duration_weeks also throws', () => {
    expect(() => computeFieldsToWrite({}, { continuous: false, cycle: { pause_weeks: 4 } }, NOT_COVERED, null)).toThrow(/continuous:false requires a valid cycle/)
  })

  it('continuous:false with duration_weeks:0 (invalid per the same invariant as the HTTP validator) throws', () => {
    expect(() => computeFieldsToWrite({}, { continuous: false, cycle: { duration_weeks: 0, pause_weeks: 4 } }, NOT_COVERED, null)).toThrow()
  })

  it('a VALID continuous:false + real cycle still succeeds (not a blanket ban on continuous:false)', () => {
    const out = computeFieldsToWrite({}, { continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }, KOLIADA_SOURCE, null)
    expect(out.continuous).toBe(false)
    expect(out.cycle).toEqual({ duration_weeks: 8, pause_weeks: 4, source: KOLIADA_SOURCE })
  })

  // #1487 REPAIR path: a doc already left in the broken shape by the bug
  // above (continuous:false already written, cycle malformed) must be
  // self-healed on the NEXT run, not stuck forever because `doc.continuous`
  // is no longer `undefined`.
  it('REPAIR: continuous already false, cycle already malformed (the live bug artifact) — a valid LLM cycle replaces the whole broken cycle object', () => {
    const broken = { continuous: false, cycle: { source: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' } } }
    const out = computeFieldsToWrite(broken, { continuous: false, cycle: { duration_weeks: 6, pause_weeks: 2 } }, KOLIADA_SOURCE, null)
    expect(out.continuous).toBeUndefined() // continuous itself was already set, untouched
    expect(out.cycle).toEqual({ duration_weeks: 6, pause_weeks: 2, source: KOLIADA_SOURCE })
  })

  it('REPAIR: if the retry ALSO returns an invalid cycle, it throws again rather than giving up silently', () => {
    const broken = { continuous: false, cycle: null }
    expect(() => computeFieldsToWrite(broken, { continuous: false, cycle: null }, NOT_COVERED, null)).toThrow(/continuous:false requires a valid cycle/)
  })
})

describe('buildPrompt', () => {
  it('embeds the supplement label and the full corpus text, and names the allowlisted external domains', () => {
    const prompt = buildPrompt('GymBeam Vitamin D3', 'CORPUS CONTENT HERE')
    expect(prompt).toContain('GymBeam Vitamin D3')
    expect(prompt).toContain('CORPUS CONTENT HERE')
    expect(prompt).toContain('examine.com')
    expect(prompt).toContain('not_covered')
  })
})

export {}
