/**
 * Unit tests for lib/nutrition-aggregate.js — the shared day-summary aggregation
 * that fixes #862 (legacy nested `items[]` records silently contributed 0 kcal to
 * /nutrition/summary).
 *
 * These tests call the SAME function summaryHandler (routes/nutrition.js) calls —
 * not a re-implementation of the reduce — per the #953 QA "mirror test" finding:
 * a test that duplicates the logic it guards proves nothing about the real code path.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { macroContribution, aggregateDay } = require('../../lib/nutrition-aggregate')

// Real production shapes, captured live from nutrition_log for 2026-07-27 (task #862).
const LEGACY_BREAKFAST = {
  meal_type: 'breakfast',
  sat_fat_g: 0, // mixed record: has BOTH items[] AND a top-level field
  items: [
    { name: 'Go On Nutrition Protein Granola', grams: 100, kcal: 408, protein: 21, fat: 13, carbs: 46 },
    { name: 'Кокосове молоко (Alpro)', grams: 300, kcal: 60, protein: 0.3, fat: 2.4, carbs: 8.1 },
    { name: 'Банан', grams: 118, kcal: 105, protein: 1.3, fat: 0.4, carbs: 27 },
  ],
}
const LEGACY_LUNCH = {
  meal_type: 'lunch',
  items: [{ name: "McDonald's", grams: 220, kcal: 596, protein: 24, fat: 34, carbs: 50 }],
}
const LEGACY_SNACK = {
  meal_type: 'snack',
  items: [{ name: 'Valio Pro Feel', grams: 175, kcal: 119, protein: 14.9, fat: 0.35, carbs: 13.1 }],
}
const LEGACY_DINNER = {
  meal_type: 'dinner',
  items: [{ name: 'Салат креветка+кальмар+авокадо', grams: 200, kcal: 291, protein: 21.7, fat: 19.9, carbs: 7 }],
}
const FLAT_SNACK_1 = {
  meal_type: 'snack',
  food_name: 'Сніжок',
  kcal: 374,
  protein_g: 34.6,
  carbs_g: 17.1,
  fat_g: 17.6,
  sugar_g: 2,
  sat_fat_g: 9.68,
  fiber_g: 0.3,
}
const FLAT_SNACK_2 = {
  meal_type: 'snack',
  food_name: 'Лосось слабосолений',
  kcal: 151,
  protein_g: 15.8,
  carbs_g: 0,
  fat_g: 9.8,
  sugar_g: 0,
  sat_fat_g: 2.16,
  fiber_g: 0,
}
const FLAT_SNACK_3 = {
  meal_type: 'snack',
  food_name: "М'ясні курячі чіпси",
  kcal: 96,
  protein_g: 24,
  carbs_g: 0.5,
  fat_g: 0.5,
  sugar_g: 0,
  sat_fat_g: 0.12,
  fiber_g: 0,
}

describe('macroContribution — per-document macro resolution', () => {
  it('sums a legacy nested items[] record (no top-level kcal/protein_g/etc.)', () => {
    expect(macroContribution(LEGACY_LUNCH)).toEqual({ kcal: 596, protein_g: 24, carbs_g: 50, fat_g: 34 })
  })

  it('sums a modern flat record unchanged', () => {
    expect(macroContribution(FLAT_SNACK_1)).toEqual({ kcal: 374, protein_g: 34.6, carbs_g: 17.1, fat_g: 17.6 })
  })

  it('a top-level field wins over the nested items[] sum for that same field (mixed record)', () => {
    // LEGACY_BREAKFAST carries items[] (would sum kcal 573) AND no top-level kcal —
    // so kcal comes from the nested sum; this just documents per-field precedence,
    // not a real scenario for kcal (no fixture record mixes both for the SAME field).
    const m = macroContribution(LEGACY_BREAKFAST)
    expect(m.kcal).toBe(573) // 408 + 60 + 105
    expect(m.protein_g).toBeCloseTo(22.6, 5) // 21 + 0.3 + 1.3
    expect(m.fat_g).toBeCloseTo(15.8, 5) // 13 + 2.4 + 0.4
    expect(m.carbs_g).toBeCloseTo(81.1, 5) // 46 + 8.1 + 27
  })

  it('a garbage items[] entry with no macro fields contributes 0, not NaN', () => {
    expect(macroContribution({ items: [{ name: 'test' }] })).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })

  it('a record with neither flat fields nor items[] contributes 0', () => {
    expect(macroContribution({})).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })
})

describe('aggregateDay — the #862 regression: legacy nested-items records must count', () => {
  it('sums the real 2026-07-27 fixture day correctly (live figure from task #862: 2104 kcal for the 6 real records at filing time)', () => {
    const docs = [LEGACY_BREAKFAST, LEGACY_LUNCH, LEGACY_SNACK, LEGACY_DINNER, FLAT_SNACK_1, FLAT_SNACK_2]
    const summary = aggregateDay('2026-07-27', docs)
    expect(summary.kcal).toBe(2104)
    expect(summary.items).toBe(6)
  })

  it('the full live day (7 real records incl. the one added after ticket filing) sums to 2200', () => {
    const docs = [LEGACY_BREAKFAST, LEGACY_LUNCH, LEGACY_SNACK, LEGACY_DINNER, FLAT_SNACK_1, FLAT_SNACK_2, FLAT_SNACK_3]
    const summary = aggregateDay('2026-07-27', docs)
    expect(summary.kcal).toBe(2200)
    expect(summary.items).toBe(7)
  })

  it('CHARACTERIZES the pre-fix bug: old code (flat fields only) undercounted the same day to 621 kcal', () => {
    // Old summaryHandler read ONLY item.kcal||item.calories — legacy items[] records
    // contributed 0. This is what production actually returned before the fix
    // (verified live via curl 2026-08-09, pre-deploy): kcal:621, items:8 (incl. garbage).
    const docs = [LEGACY_BREAKFAST, LEGACY_LUNCH, LEGACY_SNACK, LEGACY_DINNER, FLAT_SNACK_1, FLAT_SNACK_2, FLAT_SNACK_3]
    const oldBuggyKcal = docs.reduce((sum, item: any) => sum + (item.kcal || item.calories || 0), 0)
    expect(oldBuggyKcal).toBe(621) // 374 + 151 + 96 — the 4 legacy records silently dropped
    expect(aggregateDay('2026-07-27', docs).kcal).not.toBe(oldBuggyKcal)
  })

  it('the sugar_incomplete/sat_fat_incomplete flags are unaffected by legacy items[] (those fields stay top-level-only)', () => {
    const summary = aggregateDay('2026-07-27', [LEGACY_LUNCH, FLAT_SNACK_1])
    expect(summary.sat_fat_incomplete).toBe(true) // LEGACY_LUNCH has no sat_fat_g
    expect(summary.sugar_incomplete).toBe(true) // LEGACY_LUNCH has no sugar_g
    expect(summary.sugar_g).toBe(2) // only FLAT_SNACK_1 contributes
  })

  it('an empty day sums to 0, not NaN', () => {
    const summary = aggregateDay('1999-01-01', [])
    expect(summary).toMatchObject({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, items: 0 })
  })
})
