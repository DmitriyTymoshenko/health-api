/**
 * Unit tests for lib/koliada-validate.js (#1487, stage B of #1485, design D3).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateVerdict, isAllowlistedUrl } = require('../../lib/koliada-validate')

const CORPUS = `## Vitamin D
In Lesson 12, Koliada explains that vitamin D absorption improves with fat-soluble co-ingestion, and recommends a continuous daily dose rather than a cycled one for most adults.

## Creatine
Per урок 27, creatine monohydrate has no established need for cycling — continuous daily dosing is both safe and standard per current evidence.`

describe('validateVerdict — (a) real quote + lesson ref stays koliada-grounded', () => {
  it('a genuine substring of the corpus with a valid "Lesson N" ref keeps kind/by/ref/quote', () => {
    const verdict = {
      kind: 'confirms',
      by: 'koliada',
      ref: 'Lesson 12',
      quote: 'vitamin D absorption improves with fat-soluble co-ingestion',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual(verdict)
  })

  it('also accepts a Ukrainian "урок N" ref', () => {
    const verdict = {
      kind: 'neutral',
      by: 'koliada',
      ref: 'урок 27',
      quote: 'creatine monohydrate has no established need for cycling',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual(verdict)
  })

  it('also accepts a plural lesson-range ref from the vault file header', () => {
    const verdict = {
      kind: 'neutral',
      by: 'koliada',
      ref: 'lessons 1–38',
      quote: 'creatine monohydrate has no established need for cycling',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual(verdict)
  })

  it('normalizes whitespace before matching (multi-line/extra-space quote still matches)', () => {
    const verdict = {
      kind: 'confirms',
      by: 'koliada',
      ref: 'Lesson 12',
      quote: 'vitamin   D absorption   improves with  fat-soluble co-ingestion',
    }
    const out = validateVerdict(verdict, CORPUS)
    expect(out.kind).toBe('confirms')
    expect(out.by).toBe('koliada')
  })

  it('normalizes case, quotes, dashes, and punctuation before exact substring matching', () => {
    const verdict = {
      kind: 'confirms',
      by: 'koliada',
      ref: 'Lesson 12',
      quote: 'Vitamin D absorption improves with “fat soluble” co ingestion',
    }
    const corpus = 'lesson 12 says: vitamin d absorption improves with fat-soluble co-ingestion.'
    expect(validateVerdict(verdict, corpus)).toEqual({
      kind: 'confirms',
      by: 'koliada',
      ref: 'Lesson 12',
      quote: 'Vitamin D absorption improves with “fat soluble” co ingestion',
    })
  })
})

describe('validateVerdict — (b) fabricated quote downgrades to not_covered', () => {
  it('a quote not present anywhere in the corpus is downgraded, ref/quote dropped', () => {
    const verdict = {
      kind: 'confirms',
      by: 'koliada',
      ref: 'Lesson 12',
      quote: 'this exact sentence was never said in the course at all',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })

  it('a real quote but WITHOUT a valid lesson-N ref is also downgraded', () => {
    const verdict = {
      kind: 'confirms',
      by: 'koliada',
      ref: 'somewhere in the course',
      quote: 'vitamin D absorption improves with fat-soluble co-ingestion',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })

  it('a paraphrase (not a literal substring) does not count as grounded', () => {
    const verdict = {
      kind: 'confirms',
      by: 'koliada',
      ref: 'Lesson 12',
      quote: 'vitamin D is better absorbed together with fat',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })
})

describe('validateVerdict — (c) external ref outside the allowlist downgrades to not_covered', () => {
  it('a random blog URL is rejected', () => {
    const verdict = { kind: 'confirms', by: 'external', ref: 'https://some-random-supplement-blog.com/vitamin-d' }
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })

  it('an allowlisted domain (examine.com) is accepted, ref preserved', () => {
    const verdict = { kind: 'confirms', by: 'external', ref: 'https://examine.com/supplements/vitamin-d/' }
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'confirms', by: 'external', ref: 'https://examine.com/supplements/vitamin-d/' })
  })

  it('a subdomain of an allowlisted domain is accepted (pubmed.ncbi.nlm.nih.gov)', () => {
    const verdict = { kind: 'neutral', by: 'external', ref: 'https://pubmed.ncbi.nlm.nih.gov/12345678/' }
    expect(validateVerdict(verdict, CORPUS).kind).toBe('neutral')
  })

  it('not a valid URL at all → rejected without throwing', () => {
    const verdict = { kind: 'confirms', by: 'external', ref: 'examine.com/vitamin-d (see the article)' }
    expect(() => validateVerdict(verdict, CORPUS)).not.toThrow()
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })
})

describe('validateVerdict — (d) "against" kind is preserved through the same grounding checks', () => {
  it('a properly grounded koliada quote with kind=against keeps kind=against', () => {
    const verdict = {
      kind: 'against',
      by: 'koliada',
      ref: 'урок 27',
      quote: 'creatine monohydrate has no established need for cycling',
    }
    expect(validateVerdict(verdict, CORPUS)).toEqual(verdict)
  })

  it('an ungrounded "against" claim is downgraded exactly like any other kind', () => {
    const verdict = { kind: 'against', by: 'koliada', ref: 'Lesson 99', quote: 'fabricated' }
    expect(validateVerdict(verdict, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })
})

describe('validateVerdict — malformed input never throws', () => {
  it('null/undefined verdict → not_covered', () => {
    expect(validateVerdict(null, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
    expect(validateVerdict(undefined, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })
  it('unknown kind → not_covered', () => {
    expect(validateVerdict({ kind: 'maybe', by: 'koliada', ref: 'Lesson 1', quote: 'x' }, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })
  it('unknown "by" value → not_covered', () => {
    expect(validateVerdict({ kind: 'confirms', by: 'wikipedia', ref: 'x' }, CORPUS)).toEqual({ kind: 'not_covered', by: 'external' })
  })
})

describe('isAllowlistedUrl', () => {
  it('accepts all 4 named domains', () => {
    expect(isAllowlistedUrl('https://examine.com/x')).toBe(true)
    expect(isAllowlistedUrl('https://cochranelibrary.com/x')).toBe(true)
    expect(isAllowlistedUrl('https://ods.od.nih.gov/x')).toBe(true)
    expect(isAllowlistedUrl('https://pubmed.ncbi.nlm.nih.gov/x')).toBe(true)
  })
  it('rejects a lookalike domain (typosquat/subdomain trick)', () => {
    expect(isAllowlistedUrl('https://examine.com.evil.tld/x')).toBe(false)
    expect(isAllowlistedUrl('https://notexamine.com/x')).toBe(false)
  })
})

export {}
