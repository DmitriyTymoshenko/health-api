/**
 * #1489 (stage E of #1485, design E4): lib/nutrient-sum.js — sumStack +
 * normalizeNutrientKey. Ingredient shapes in the fixtures below are copied
 * VERBATIM from the live supplement_knowledge docs (queried 2026-09-22:
 * catalog id 8 "Zinc (aspartate)" 30mg + "Magnesium (aspartate)" 450mg +
 * "Vitamin B6" 10.5mg; id 1 "Vitamin D3" 2000 IU; id 2 "EPA+DHA" 600mg; id 13
 * "Withania somnifera root extract" 500 мг). The zinc-over-UL scenario
 * (15+30=45>40) is the task's own stated E4 fixture, added on top of a
 * synthetic multivitamin item since no live item carries 15mg zinc today.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sumStack, normalizeNutrientKey } = require('../../lib/nutrient-sum')

describe('normalizeNutrientKey — live ingredient name variants', () => {
  it('strips a parenthetical salt/form qualifier before matching', () => {
    expect(normalizeNutrientKey('Zinc (aspartate)')).toBe('zinc')
    expect(normalizeNutrientKey('Magnesium (aspartate)')).toBe('magnesium_supplemental')
  })
  it('maps live ingredient names to canonical keys', () => {
    expect(normalizeNutrientKey('Vitamin D3')).toBe('vitamin_d')
    expect(normalizeNutrientKey('Vitamin B6')).toBe('vitamin_b6')
    expect(normalizeNutrientKey('Vitamin C')).toBe('vitamin_c')
    expect(normalizeNutrientKey('EPA+DHA')).toBe('omega3_epa_dha')
    expect(normalizeNutrientKey('Withania somnifera root extract')).toBe('ashwagandha')
    expect(normalizeNutrientKey('Beta-Alanine')).toBe('beta_alanine')
    expect(normalizeNutrientKey('Creatine HCl')).toBe('creatine')
  })
  it('an unrecognized ingredient still gets a stable generic slug, not "unknown"', () => {
    expect(normalizeNutrientKey('CoQ10')).toBe('coq10')
    expect(normalizeNutrientKey('Fish oil')).toBe('fish_oil')
  })
  it('null/empty name falls back to "unknown"', () => {
    expect(normalizeNutrientKey('')).toBe('unknown')
    expect(normalizeNutrientKey(null)).toBe('unknown')
  })
})

describe('sumStack — E4 acceptance', () => {
  it('zinc from two sources (15 + 30 = 45) exceeds UL 40 -> over_ul true, 2 sources', () => {
    const activeItems = [
      { id: 100, name: 'Multivitamin', short_name: 'Multi', servings_per_day: 1 },
      { id: 8, name: 'VPLab ZMA', short_name: 'ZMA', servings_per_day: 1 },
    ]
    const knowledgeById = new Map([
      [100, { catalog_id: 100, active_ingredients: [{ name: 'Zinc', amount_per_dose: 15, unit: 'mg' }] }],
      [8, { catalog_id: 8, active_ingredients: [{ name: 'Zinc (aspartate)', amount_per_dose: 30, unit: 'mg' }] }],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    const zinc = rows.find((r: any) => r.nutrient_key === 'zinc')
    expect(zinc.total).toBe(45)
    expect(zinc.unit).toBe('mg')
    expect(zinc.ul).toBe(40)
    expect(zinc.over_ul).toBe(true)
    expect(zinc.multi_source).toBe(true)
    expect(zinc.sources).toHaveLength(2)
  })

  it('a unit mismatch on the same nutrient_key sets unit_conflict:true instead of silently summing', () => {
    const activeItems = [
      { id: 1, name: 'A', servings_per_day: 1 },
      { id: 2, name: 'B', servings_per_day: 1 },
    ]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [{ name: 'Vitamin D3', amount_per_dose: 2000, unit: 'IU' }] }],
      [2, { catalog_id: 2, active_ingredients: [{ name: 'Vitamin D3', amount_per_dose: 25, unit: 'mcg' }] }],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    const vitD = rows.find((r: any) => r.nutrient_key === 'vitamin_d')
    expect(vitD.unit_conflict).toBe(true)
    expect(vitD.total).toBeNull()
    expect(vitD.over_ul).toBe(false)
  })

  it('an unmapped ingredient with no UL row gets ul:null, no warning/error', () => {
    const activeItems = [{ id: 1, name: 'X', servings_per_day: 1 }]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [{ name: 'CoQ10', amount_per_dose: 20, unit: 'mg' }] }],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    const coq10 = rows.find((r: any) => r.nutrient_key === 'coq10')
    expect(coq10).toBeDefined()
    expect(coq10.ul).toBeNull()
    expect(coq10.over_ul).toBe(false)
  })

  it('scales by servings_per_day', () => {
    const activeItems = [{ id: 1, name: 'A', servings_per_day: 3 }]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [{ name: 'Vitamin C', amount_per_dose: 500, unit: 'mg' }] }],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    const vitC = rows.find((r: any) => r.nutrient_key === 'vitamin_c')
    expect(vitC.total).toBe(1500)
  })

  it('ingredient with amount_per_dose:null (RDA-only placeholder) is skipped, not NaN', () => {
    const activeItems = [{ id: 1, name: 'A', servings_per_day: 1 }]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [{ name: 'Vitamin B1', amount_per_dose: null, unit: 'mg', note: 'RDA' }] }],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    expect(rows).toHaveLength(0)
  })

  it('an item with no matching knowledge doc contributes nothing (no throw)', () => {
    const activeItems = [{ id: 9, name: 'No knowledge yet', servings_per_day: 1 }]
    const rows = sumStack(activeItems, new Map())
    expect(rows).toHaveLength(0)
  })

  it('respects a pre-set ing.nutrient_key over name-based normalization (stage F contract)', () => {
    const activeItems = [{ id: 1, name: 'A', servings_per_day: 1 }]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [{ name: 'Some Weird Label', nutrient_key: 'zinc', amount_per_dose: 5, unit: 'mg' }] }],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    expect(rows.find((r: any) => r.nutrient_key === 'zinc')).toBeDefined()
  })

  it('rows are sorted by nutrient_key', () => {
    const activeItems = [{ id: 1, name: 'A', servings_per_day: 1 }]
    const knowledgeById = new Map([
      [
        1,
        {
          catalog_id: 1,
          active_ingredients: [
            { name: 'Zinc', amount_per_dose: 10, unit: 'mg' },
            { name: 'Vitamin C', amount_per_dose: 100, unit: 'mg' },
          ],
        },
      ],
    ])
    const rows = sumStack(activeItems, knowledgeById)
    expect(rows.map((r: any) => r.nutrient_key)).toEqual(['vitamin_c', 'zinc'])
  })
})

export {}
