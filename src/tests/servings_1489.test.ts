/**
 * #1489 (stage E of #1485, design E1): lib/servings.js — parseServingsPerDay
 * + resolveServingsPerDay. Fixture is the ACTUAL 11 live supplement_catalog
 * docs (queried directly from Mongo `health_tracker` on 2026-09-22, ids 1,
 * 2, 3, 6, 7, 8, 9, 10, 12, 13, 19 — the 11 currently in the catalog; ids 4,
 * 5, 14 exist only in supplement_knowledge, no matching catalog item today).
 * Every one of them has a SINGLE schedule slot, so the heuristic (count
 * schedule slots, never parse the dose range) derives 1 for all 11 —
 * including the dose ranges ("2-3 капс", "3-5 капс", "3-6 табл") that a
 * naive dose-text parser would have wrongly multiplied.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseServingsPerDay, resolveServingsPerDay } = require('../../lib/servings')

const LIVE_CATALOG_FIXTURE = [
  { id: 1, dose: '2000 IU (1 капс)', schedule: 'morning' },
  { id: 2, dose: '2 капс (2000мг / 600мг EPA+DHA)', schedule: 'morning' },
  { id: 3, dose: '2-3 капс (~3г)', schedule: 'morning' },
  { id: 6, dose: '3-5 капс (500мг/капс)', schedule: 'pre_meal' },
  { id: 7, dose: '1 мірна ложка (~10-14г)', schedule: 'pre_workout' },
  { id: 8, dose: '3 капс (Zinc 30мг + Mg 450мг + B6 10.5мг)', schedule: 'evening' },
  { id: 9, dose: '2 капсули (1120мг)', schedule: 'morning' },
  { id: 10, dose: '1 капсула (500мг)', schedule: 'morning' },
  { id: 12, dose: '2-3г (1 мірна ложка)', schedule: 'pre_workout' },
  { id: 13, dose: '1 капсула (500 мг екстракту кореня)', schedule: 'evening' },
  { id: 19, dose: '', schedule: 'morning' },
]

describe('parseServingsPerDay — live 11-item fixture (2026-09-22)', () => {
  for (const item of LIVE_CATALOG_FIXTURE) {
    it(`id ${item.id}: dose=${JSON.stringify(item.dose)} schedule=${item.schedule} -> 1`, () => {
      expect(parseServingsPerDay(item.dose, item.schedule)).toBe(1)
    })
  }

  it('a capsule-range dose ("2-3 капс") is NOT multiplied into 2 or 3 servings — порція ≠ капсула', () => {
    expect(parseServingsPerDay('2-3 капс (~3г)', 'morning')).toBe(1)
  })

  it('empty dose still derives 1 from a single schedule slot', () => {
    expect(parseServingsPerDay('', 'morning')).toBe(1)
  })

  it('missing schedule (not a string) defaults to 1', () => {
    expect(parseServingsPerDay('2 капс', undefined)).toBe(1)
    expect(parseServingsPerDay('2 капс', null)).toBe(1)
  })

  it('a forward-compatible multi-slot schedule ("morning,evening") derives 2 — no live item uses this shape yet', () => {
    expect(parseServingsPerDay('1 капс', 'morning,evening')).toBe(2)
  })

  it('a 3-slot schedule derives 3', () => {
    expect(parseServingsPerDay('1 капс', 'morning, pre_meal, evening')).toBe(3)
  })
})

describe('resolveServingsPerDay — explicit value wins, else derives', () => {
  it('an explicit positive servings_per_day is used as-is (PUT-editable contract)', () => {
    expect(resolveServingsPerDay({ servings_per_day: 3, dose: '1 капс', schedule: 'morning' })).toBe(3)
  })

  it('servings_per_day: 0 or negative is NOT trusted — falls back to derivation', () => {
    expect(resolveServingsPerDay({ servings_per_day: 0, dose: '1 капс', schedule: 'morning' })).toBe(1)
    expect(resolveServingsPerDay({ servings_per_day: -1, dose: '1 капс', schedule: 'morning' })).toBe(1)
  })

  it('no stored servings_per_day derives from schedule', () => {
    expect(resolveServingsPerDay({ dose: '2-3 капс', schedule: 'morning' })).toBe(1)
  })

  it('live id 8 (VPLab ZMA) resolves to 1 with no stored servings_per_day (matches 0/11 live measurement)', () => {
    expect(
      resolveServingsPerDay({ id: 8, dose: '3 капс (Zinc 30мг + Mg 450мг + B6 10.5мг)', schedule: 'evening' })
    ).toBe(1)
  })
})

export {}
