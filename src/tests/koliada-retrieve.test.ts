/**
 * Unit tests for lib/koliada-retrieve.js (#1488 D3').
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { retrieveKoliadaSnippets, formatSnippets, expandTerms, termsFromStackAndLabs } = require('../../lib/koliada-retrieve')

const CORPUS = `# Koliada — Evidence-Based Nutrition Science, Part 2 (lessons 39-75)

Distillation of Oleksandr Koliada's course. Lessons 58-63 (vitamins), 64-67 (minerals).

## Vitamin D

- Functions: regulation of calcium and phosphorus absorption/metabolism.
- Correct blood test: 25(OH)D3 specifically.

## Magnesium

- Better taken in the evening — supports the nervous system and falling asleep.`

describe('retrieveKoliadaSnippets', () => {
  it('vitamin D query returns at least one line-numbered excerpt with a lesson reference', () => {
    const snippets = retrieveKoliadaSnippets(CORPUS, ['vitamin D'], { contextLines: 1 })
    expect(snippets.length).toBeGreaterThanOrEqual(1)
    expect(snippets[0].ref).toMatch(/lessons?\s*\d+/i)
    expect(snippets[0].startLine).toBeGreaterThan(0)
    expect(formatSnippets(snippets)).toContain('KOLIADA_SNIPPET_1')
  })

  it('ashwagandha query returns 0 excerpts when the corpus has no matching synonym/term', () => {
    expect(retrieveKoliadaSnippets(CORPUS, ['ashwagandha'])).toEqual([])
  })
})

describe('expandTerms', () => {
  it('expands product-ish names into ingredient synonyms', () => {
    expect(expandTerms(['D3 + Omega 3'])).toEqual(expect.arrayContaining(['vitamin d', 'omega 3', 'epa', 'dha']))
  })

  it('expands ZMA into zinc and magnesium search terms', () => {
    expect(expandTerms(['VPLab ZMA'])).toEqual(expect.arrayContaining(['zinc', 'magnesium']))
  })
})

describe('termsFromStackAndLabs', () => {
  it('includes dose/notes text so ingredient-only products are retrievable', () => {
    const terms = termsFromStackAndLabs([{ short_name: 'ZMA', dose: 'Zinc 30mg + Mg 450mg + B6', notes: 'evening' }], {})
    expect(terms).toEqual(expect.arrayContaining(['Zinc 30mg + Mg 450mg + B6', 'evening']))
  })
})

export {}
