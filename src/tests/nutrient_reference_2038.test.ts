const { createHash } = require('node:crypto')
const { UPPER_LIMITS } = require('../../data/upper-limits')
const { sumStack } = require('../../lib/nutrient-sum')

function row(key: string, amount = 1, unit: any = 'mg', extra: any[] = []) {
  return sumStack([{ id: 1, name: 'Fixture', servings_per_day: 1 }], new Map([[1, {
    active_ingredients: [{ name: key, nutrient_key: key, amount_per_dose: amount, unit }, ...extra],
  }]]))[0]
}
const originalKeys = Object.keys(UPPER_LIMITS)
afterEach(() => { delete UPPER_LIMITS.fixture_reference })

describe('#2038 reference metadata and comparison, not personal safety', () => {
  it('preserves ALL 21 historical numbers/nulls, units, notes and URLs byte-for-byte', () => {
    expect(originalKeys).toHaveLength(21)
    const projection = Object.fromEntries(originalKeys.sort().map(k => {
      const { ul, unit, source_url, note } = UPPER_LIMITS[k]
      return [k, { ul, unit, source_url, note }]
    }))
    expect(createHash('sha256').update(JSON.stringify(projection)).digest('hex'))
      .toBe('65db1cd3d5e546762eaa5a02253964fb0cf83d134875a90fbc32a73f2466bb85')
  })

  it.each(originalKeys)('propagates %s provenance without discarding source/note/reference unit', (key: string) => {
    const input = UPPER_LIMITS[key]
    const out = row(key, 1, input.unit || 'mg')
    expect(out.reference).toEqual({ value: input.ul, unit: input.unit,
      source_url: input.source_url, note: input.note, ...input.reference })
    expect(out.reference.provenance.checked_at).toBe('2026-10-05')
    expect(out.reference.provenance.ledger).toBe('task:2038/comment:13546')
    expect(out.comparison.applicability).toBe('not_assessed')
    expect(out.comparison.basis).toBe('recorded_supplement_stack')
  })

  it.each([
    ['magnesium_supplemental', 'supplements_and_medications', 'adults_19_plus'],
    ['folate_supplemental', 'synthetic_folate_supplements_and_fortified_food', 'adults_19_plus'],
    ['calcium', 'all_sources', 'adults_19_to_50'],
    ['vitamin_a', 'preformed_vitamin_a_all_sources', 'adults_19_plus'],
    ['vitamin_e', 'supplemental_alpha_tocopherol', 'adults_19_plus'],
    ['iron', 'all_sources', 'ages_14_plus'],
  ])('preserves bounded scope for %s without personalized applicability', (key, scope, population) => {
    const out = row(key)
    expect(out.reference).toMatchObject({ kind: 'formal_ul', scope, population, jurisdiction: 'US_FNB' })
    expect(out.comparison.applicability).toBe('not_assessed')
  })

  it.each(['vitamin_b6', 'selenium'])('keeps %s US reference and EU caveat without switching numeric threshold', key => {
    expect(row(key).reference.jurisdiction).toBe('US_FNB')
    expect(row(key).reference.note).toContain('EFSA 2023')
  })

  it('labels omega3 as other_reference and compares numbers without calling it a formal UL', () => {
    const out = row('omega3_epa_dha', 5001)
    expect(out.reference).toMatchObject({ value: 5000, kind: 'other_reference', scope: 'supplemental_epa_dha_combined', jurisdiction: 'EFSA' })
    expect(out.comparison).toMatchObject({ status: 'above', applicability: 'not_assessed' })
  })

  it.each([['creatine'], ['beta_alanine'], ['eaa'], ['psyllium'], ['ashwagandha'], ['lions_mane'], ['ginseng'], ['unmapped']])('%s unknown boundary is explicitly not_comparable', key => {
    const out = row(key)
    expect(out.ul).toBeNull()
    expect(out.reference.kind).toBe('unknown')
    expect(out.comparison.status).toBe('not_comparable')
    expect(out.comparison.reasons.length).toBeGreaterThan(0)
    expect(out.comparison.applicability).toBe('not_assessed')
  })

  it.each(['eaa', 'psyllium', 'lions_mane'])('does not promote unverified historical note for %s', key => {
    expect(row(key).reference.provenance.status).toBe('unverified')
    expect(row(key).comparison.status).toBe('not_comparable')
  })

  it('missing metadata does not manufacture formal UL/scope or a valid comparison', () => {
    UPPER_LIMITS.fixture_reference = { ul: 40, unit: 'mg', note: 'existing note', source_url: 'https://ods.od.nih.gov/' }
    const out = row('fixture_reference', 45)
    expect(out.reference).toMatchObject({ value: 40, kind: 'unknown', scope: 'unknown', population: 'unknown', jurisdiction: 'unknown' })
    expect(out.reference.provenance.status).toBe('unverified')
    expect(out.comparison.status).toBe('not_comparable')
  })

  it('a single-source reference-unit mismatch is not_comparable with both units retained', () => {
    const out = row('vitamin_d', 20, 'mg')
    expect(out.unit).toBe('mg')
    expect(out.reference.unit).toBe('IU')
    expect(out.comparison).toMatchObject({ status: 'not_comparable', reasons: expect.arrayContaining(['unit_mismatch']) })
  })

  it('mixed source units retain reference metadata, null total and no comparison', () => {
    const out = row('vitamin_d', 2000, 'IU', [{name:'D',nutrient_key:'vitamin_d',amount_per_dose:25,unit:'mcg'}])
    expect(out.total).toBeNull()
    expect(out.unit_conflict).toBe(true)
    expect(out.reference.unit).toBe('IU')
    expect(out.comparison).toMatchObject({ status:'not_comparable', reasons:expect.arrayContaining(['unit_conflict']) })
  })

  it.each([[39, 'not_above'], [40, 'not_above'], [41, 'above']])('zinc %s remains arithmetic only', (amount, status) => {
    const out = row('zinc', Number(amount))
    expect(out.total).toBe(amount)
    expect(out.ul).toBe(40)
    expect(out.comparison).toEqual({ status, reasons:[], basis:'recorded_supplement_stack', applicability:'not_assessed' })
  })

  it('does not turn null ingredient amounts or absent knowledge into a zero/safe row', () => {
    expect(sumStack([{id:1}], new Map([[1,{active_ingredients:[{name:'Zinc',amount_per_dose:null,unit:'mg'}]}]]))).toEqual([])
    expect(sumStack([{id:1}], new Map())).toEqual([])
  })
})
export {}
