/**
 * Unit tests for the shared saturated-fat / calorie-target math.
 *
 * The helper is plain CommonJS (lib/nutrition-targets.js) because routes/*.js are
 * CommonJS and are NOT migrated to TS (see CLAUDE.md) — hence require(), not import.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveDayKcalTarget,
  satFatLimitBasisKcal,
  satFatLimitG,
  satFatStatus,
  SAT_FAT_KCAL_SHARE,
} = require('../../lib/nutrition-targets')

describe('satFatLimitBasisKcal — the ceiling must NOT move during the day', () => {
  const profile = { tdee_kcal: 2429, deficit_kcal: 500 }

  it('ignores the WHOOP burn entirely (regression: 2026-08-07 12:07 gave a 12 g ceiling)', () => {
    // Live data that day: burn 1579 at noon, 2366 the completed day before.
    // resolveDayKcalTarget would swing 1079 -> 1866; the ceiling must not.
    expect(resolveDayKcalTarget(profile, 1579)).toBe(1079) // characterises the calorie target
    expect(satFatLimitBasisKcal(profile)).toBe(1929) // ceiling basis: unchanged
    expect(satFatLimitG(satFatLimitBasisKcal(profile))).toBe(21)
  })

  it('is identical at every hour of the day', () => {
    const hours = [0, 900, 1579, 2366, 2934]
    const limits = hours.map(() => satFatLimitG(satFatLimitBasisKcal(profile)))
    expect(new Set(limits).size).toBe(1)
  })

  it('honours an explicit profile goal', () => {
    expect(satFatLimitBasisKcal({ daily_kcal_goal: 2200 })).toBe(2200)
  })

  it('survives a missing profile', () => {
    expect(satFatLimitBasisKcal(null)).toBe(1929)
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
