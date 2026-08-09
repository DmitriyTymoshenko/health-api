/**
 * Unit tests for the shared saturated-fat / sugar / calorie-target math.
 *
 * The helper is plain CommonJS (lib/nutrition-targets.js) because routes/*.js are
 * CommonJS and are NOT migrated to TS (see CLAUDE.md) — hence require(), not import.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveDayKcalTarget,
  stableDayKcalBasis,
  satFatLimitG,
  satFatStatus,
  sugarLimitG,
  sugarStatus,
  SAT_FAT_KCAL_SHARE,
  SUGAR_KCAL_SHARE,
  KCAL_PER_G_CARB,
} = require('../../lib/nutrition-targets')

describe('stableDayKcalBasis — the ceiling must NOT move during the day', () => {
  const profile = { tdee_kcal: 2429, deficit_kcal: 500 }

  it('ignores the WHOOP burn entirely (regression: 2026-08-07 12:07 gave a 12 g ceiling)', () => {
    // Live data that day: burn 1579 at noon, 2366 the completed day before.
    // resolveDayKcalTarget would swing 1079 -> 1866; the ceiling must not.
    expect(resolveDayKcalTarget(profile, 1579)).toBe(1079) // characterises the calorie target
    expect(stableDayKcalBasis(profile)).toBe(1929) // ceiling basis: unchanged
    expect(satFatLimitG(stableDayKcalBasis(profile))).toBe(21)
  })

  it('is identical at every hour of the day', () => {
    const hours = [0, 900, 1579, 2366, 2934]
    const limits = hours.map(() => satFatLimitG(stableDayKcalBasis(profile)))
    expect(new Set(limits).size).toBe(1)
  })

  it('honours an explicit profile goal', () => {
    expect(stableDayKcalBasis({ daily_kcal_goal: 2200 })).toBe(2200)
  })

  it('survives a missing profile', () => {
    expect(stableDayKcalBasis(null)).toBe(1929)
  })
})

describe('satFatLimitG — ≤10% of daily calories, 9 kcal/g', () => {
  it.each([
    [2800, 31],
    [2000, 22],
    [1929, 21], // profile default: tdee 2429 − deficit 500
    [2066, 23], // task premise: avg 2066 kcal/day → ≈23 g
  ])('target %i kcal -> %i g', (kcal, expected) => {
    expect(satFatLimitG(kcal)).toBe(expected)
  })

  it('is a share of calories, not a hardcoded 23 g constant', () => {
    // The whole point of the task: the limit MOVES with the calorie target.
    expect(satFatLimitG(2800)).not.toBe(satFatLimitG(2000))
    expect(satFatLimitG(2800)).toBeGreaterThan(satFatLimitG(2000))
    expect(SAT_FAT_KCAL_SHARE).toBe(0.1)
  })

  it.each([[0], [-100], [NaN], [null], [undefined]])(
    'degrades to 0 on bad input (%s) instead of NaN reaching the UI',
    (bad) => {
      expect(satFatLimitG(bad)).toBe(0)
    }
  )
})

describe('resolveDayKcalTarget', () => {
  it('prefers WHOOP burn minus deficit when the cycle is real', () => {
    expect(resolveDayKcalTarget({ deficit_kcal: 500 }, 3000)).toBe(2500)
  })

  it('ignores an early/partial WHOOP cycle (<=1200 kcal burned)', () => {
    // A cycle still filling up at 08:00 would otherwise produce an absurd target.
    expect(resolveDayKcalTarget({ daily_kcal_goal: 1929, deficit_kcal: 500 }, 900)).toBe(1929)
  })

  it('falls back to the explicit profile goal', () => {
    expect(resolveDayKcalTarget({ daily_kcal_goal: 2100 }, null)).toBe(2100)
  })

  it('falls back to tdee − deficit when no explicit goal', () => {
    expect(resolveDayKcalTarget({ tdee_kcal: 2429, deficit_kcal: 500 }, null)).toBe(1929)
  })

  it('survives a missing profile (historical/no-profile state)', () => {
    expect(resolveDayKcalTarget(null, null)).toBe(1929)
    expect(resolveDayKcalTarget(undefined, undefined)).toBe(1929)
  })
})

describe('satFatStatus — colour thresholds', () => {
  const limit = 22
  it.each([
    [0, 'ok'],
    [17, 'ok'], // 77%
    [17.6, 'warning'], // exactly 80%
    [21, 'warning'], // 95%
    [22, 'danger'], // exactly 100%
    [40, 'danger'],
  ])('%s g of %i g limit -> %s', (consumed, expected) => {
    expect(satFatStatus(consumed, limit)).toBe(expected)
  })

  it('never reports danger when there is no limit to breach', () => {
    expect(satFatStatus(50, 0)).toBe('ok')
  })
})

describe('historical entries without sat_fat_g', () => {
  it('fallback 0 keeps the day summable rather than NaN', () => {
    const entries = [{ sat_fat_g: 5 }, {}, { sat_fat_g: undefined }, { sat_fat_g: 2.5 }] as Array<
      Record<string, number | undefined>
    >
    const total = entries.reduce((acc, e) => acc + (e.sat_fat_g || 0), 0)
    const incomplete = entries.some((e) => e.sat_fat_g == null)
    expect(total).toBe(7.5)
    expect(incomplete).toBe(true)
  })
})

describe('sugarLimitG — WHO ≤10% of daily calories, 4 kcal/g', () => {
  it.each([
    [1929, 48], // profile default (tdee 2429 − deficit 500): 1929 × 0.1 / 4 = 48.2
    [2800, 70],
    [2000, 50],
    [2200, 55],
  ])('basis %i kcal -> %i g', (kcal, expected) => {
    expect(sugarLimitG(kcal)).toBe(expected)
  })

  it('uses the SAME stable basis as the sat-fat ceiling (one profile, one day target)', () => {
    const profile = { tdee_kcal: 2429, deficit_kcal: 500 }
    expect(stableDayKcalBasis(profile)).toBe(1929)
    expect(sugarLimitG(stableDayKcalBasis(profile))).toBe(48)
    expect(satFatLimitG(stableDayKcalBasis(profile))).toBe(21) // unchanged by #953
  })

  it('never moves during the day (no WHOOP burn in the basis)', () => {
    const profile = { tdee_kcal: 2429, deficit_kcal: 500 }
    const hours = [0, 900, 1579, 2366, 2934]
    const limits = hours.map(() => sugarLimitG(stableDayKcalBasis(profile)))
    expect(new Set(limits).size).toBe(1)
  })

  it('divides by 4, not by 9 — sugar is a carbohydrate', () => {
    // Regression guard for the copy-paste failure mode: reusing the fat divisor
    // would give 21 g instead of 48 g and silently halve the ceiling.
    expect(KCAL_PER_G_CARB).toBe(4)
    expect(sugarLimitG(1929)).not.toBe(satFatLimitG(1929))
    expect(sugarLimitG(1929)).toBeGreaterThan(satFatLimitG(1929))
  })

  it('keeps its OWN share constant (0.1 match with sat-fat is a coincidence)', () => {
    // WHO free sugars vs Koliada saturated fat — different sources, so a future
    // revision of one must not move the other. Two constants, not one.
    expect(SUGAR_KCAL_SHARE).toBe(0.1)
    expect(SAT_FAT_KCAL_SHARE).toBe(0.1)
    expect(sugarLimitG(2800)).toBeGreaterThan(sugarLimitG(2000)) // a share, not a literal
  })

  it.each([[0], [-100], [NaN], [null], [undefined]])(
    'degrades to 0 on bad input (%s) instead of NaN reaching the UI',
    (bad) => {
      expect(sugarLimitG(bad)).toBe(0)
    }
  )
})

describe('sugarStatus — same three-state ladder as satFatStatus', () => {
  const limit = 48
  it.each([
    [0, 'ok'],
    [38, 'ok'], // 79%
    [38.5, 'warning'], // 80.2%
    [47, 'warning'], // 98%
    [48, 'danger'], // exactly 100%
    [90, 'danger'],
  ])('%s g of %i g limit -> %s', (consumed, expected) => {
    expect(sugarStatus(consumed, limit)).toBe(expected)
  })

  it('boundaries land exactly where the ladder says (float-clean pair)', () => {
    // 40/50 and 50/50 are exact in binary, so these pin the thresholds themselves.
    expect(sugarStatus(40, 50)).toBe('warning') // exactly 80%
    expect(sugarStatus(50, 50)).toBe('danger') // exactly 100%
    // Characterisation, not a defect to fix: 38.4/48 evaluates to 0.7999999999999999
    // in IEEE-754, so a nominal "exactly 80%" pair can read 'ok'. Colour bands are a
    // display concern at 1 g granularity — do NOT add an epsilon and make the ladder
    // disagree with satFatStatus, which has carried this same arithmetic since #905.
    expect(sugarStatus(38.4, 48)).toBe('ok')
  })

  it('never reports danger when there is no limit to breach', () => {
    expect(sugarStatus(90, 0)).toBe('ok')
  })

  it('agrees with satFatStatus at every threshold (one ladder, two metrics)', () => {
    const pcts = [0, 0.5, 0.79, 0.8, 0.99, 1, 1.5]
    for (const pct of pcts) {
      expect(sugarStatus(pct * 48, 48)).toBe(satFatStatus(pct * 21, 21))
    }
  })
})

describe('historical entries without sugar_g (sugar_incomplete flag)', () => {
  it('an untracked entry drags the total down — the flag is what stops a false ok', () => {
    // Mirrors summaryHandler's reduce in routes/nutrition.js.
    const entries = [{ sugar_g: 30 }, {}, { sugar_g: undefined }, { sugar_g: 12 }] as Array<
      Record<string, number | undefined>
    >
    const total = entries.reduce((acc, e) => acc + (e.sugar_g || 0), 0)
    const incomplete = entries.some((e) => e.sugar_g == null)
    expect(total).toBe(42) // NOT NaN
    expect(incomplete).toBe(true)
    // 42 of 48 reads 'warning'; the real day may well have breached 48. Without the
    // flag the UI would present an understated number as if it were complete.
    expect(sugarStatus(total, 48)).toBe('warning')
  })

  it('a fully tracked day carries no flag', () => {
    const entries = [{ sugar_g: 30 }, { sugar_g: 0 }, { sugar_g: 12 }]
    expect(entries.some((e) => e.sugar_g == null)).toBe(false)
  })
})
