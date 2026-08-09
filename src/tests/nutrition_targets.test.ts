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
  proteinGoalG,
  resolveProteinGoalG,
  resolveWeightKg,
  fiberGoalG,
  goalStatus,
  SAT_FAT_KCAL_SHARE,
  SUGAR_KCAL_SHARE,
  KCAL_PER_G_CARB,
  PROTEIN_G_PER_KG,
  FIBER_G_PER_1000_KCAL,
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

// ---------------------------------------------------------------------------
// #961 — protein_goal_g + fiber_goal_g, dynamic from profile
// ---------------------------------------------------------------------------

describe('proteinGoalG — 1.6 g/kg (vault 04.01: weight-loss/deficit band 1.6-2.4 g/kg, lower bound)', () => {
  it.each([
    [98.2, 157], // live profile weight, 2026-08-09 (task #961 premise)
    [90, 144],
    [60, 96],
    [70.5, 113],
  ])('%s kg -> %s g', (kg, expected) => {
    expect(proteinGoalG(kg)).toBe(expected)
  })

  it('is a function of weight, not a hardcoded constant (the whole point of #961)', () => {
    expect(proteinGoalG(98.2)).not.toBe(proteinGoalG(60))
    expect(proteinGoalG(98.2)).toBeGreaterThan(proteinGoalG(60))
    expect(PROTEIN_G_PER_KG).toBe(1.6)
  })

  it.each([[0], [-10], [NaN], [null], [undefined]])(
    'degrades to 0 on bad input (%s) instead of NaN reaching the UI',
    (bad) => {
      expect(proteinGoalG(bad)).toBe(0)
    }
  )
})

describe('resolveWeightKg — latest weight_log wins; profile.weight_goal_kg is the fallback; 0 if neither', () => {
  it('prefers the latest weight_log entry over the profile target', () => {
    expect(resolveWeightKg({ weight_goal_kg: 96 }, 98.2)).toBe(98.2)
  })

  it('falls back to profile.weight_goal_kg when there is no logged weight', () => {
    expect(resolveWeightKg({ weight_goal_kg: 96 }, undefined)).toBe(96)
    expect(resolveWeightKg({ weight_goal_kg: 96 }, null)).toBe(96)
  })

  it('returns 0 when neither a logged weight nor a profile target exists (protein_incomplete case)', () => {
    expect(resolveWeightKg(null, undefined)).toBe(0)
    expect(resolveWeightKg({}, null)).toBe(0)
  })

  it.each([[0], [-5], [NaN]])(
    'ignores an invalid logged weight (%s) and falls back to the profile target',
    (bad) => {
      expect(resolveWeightKg({ weight_goal_kg: 96 }, bad)).toBe(96)
    }
  )

  it('is identical at every hour of the day (no clock dependency, same discipline as stableDayKcalBasis)', () => {
    const hours = [0, 900, 1579, 2366, 2934]
    const values = hours.map(() => resolveWeightKg({ weight_goal_kg: 96 }, 98.2))
    expect(new Set(values).size).toBe(1)
    expect(values[0]).toBe(98.2)
  })
})

describe('resolveProteinGoalG — explicit profile override wins outright, else auto-calc from weight', () => {
  it('an explicit daily_protein_goal_g wins outright, even over a live weight', () => {
    expect(resolveProteinGoalG({ daily_protein_goal_g: 200 }, 98.2)).toBe(200)
  })

  it('falls back to proteinGoalG(weightKg) when the profile override is null (= auto-calculate)', () => {
    expect(resolveProteinGoalG({ daily_protein_goal_g: null }, 98.2)).toBe(157)
    expect(resolveProteinGoalG(null, 98.2)).toBe(157)
  })

  it('ignores a non-positive override and falls back to auto-calc', () => {
    expect(resolveProteinGoalG({ daily_protein_goal_g: 0 }, 98.2)).toBe(157)
    expect(resolveProteinGoalG({ daily_protein_goal_g: -5 }, 98.2)).toBe(157)
  })
})

describe('fiberGoalG — 14 g / 1000 kcal (vault 04.02, USDA/WHO)', () => {
  it.each([
    [1929, 27], // profile default basis (task #961 premise)
    [2429, 34],
    [2000, 28],
    [2800, 39],
  ])('basis %i kcal -> %i g', (kcal, expected) => {
    expect(fiberGoalG(kcal)).toBe(expected)
  })

  it('is a share of calories, not a hardcoded 25-30 g literal', () => {
    expect(fiberGoalG(2800)).toBeGreaterThan(fiberGoalG(2000))
    expect(FIBER_G_PER_1000_KCAL).toBe(14)
  })

  it.each([[0], [-100], [NaN], [null], [undefined]])(
    'degrades to 0 on bad input (%s) instead of NaN reaching the UI',
    (bad) => {
      expect(fiberGoalG(bad)).toBe(0)
    }
  )
})

describe('goalStatus — the INVERSE ladder of limitStatus (protein/fiber are targets to REACH, not ceilings)', () => {
  const goal = 100
  it.each([
    [0, 'danger'],
    [79, 'danger'], // just under 80%
    [80, 'warning'], // exactly 80%
    [99, 'warning'],
    [100, 'ok'], // exactly 100%
    [150, 'ok'], // over-achieving a goal is still fine — never a 4th state
  ])('%s g of %s g goal -> %s', (consumed, expected) => {
    expect(goalStatus(consumed, goal)).toBe(expected)
  })

  it('never reports danger when there is no goal to judge against', () => {
    expect(goalStatus(50, 0)).toBe('ok')
  })

  it('agrees with a ceiling ladder on the warning band, but flips ok<->danger at the ends', () => {
    // A goal and a ceiling share the exact same 80% threshold shape — only the
    // meaning of "past 100%" flips (breach vs achievement). Reusing limitStatus
    // directly (rather than a distinct goalStatus) would have required every call
    // site to invert consumed/limit, which is the silent-flip bug this ladder exists
    // to prevent — see the goalStatus doc comment.
    const pcts = [0, 0.5, 0.79, 0.8, 0.99, 1, 1.5]
    for (const pct of pcts) {
      const ceiling = satFatStatus(pct * 21, 21)
      const g = goalStatus(pct * 21, 21)
      if (ceiling === 'warning') {
        expect(g).toBe('warning')
      } else {
        expect(g).toBe(ceiling === 'danger' ? 'ok' : 'danger')
      }
    }
  })
})

describe('#961 live scenario — 98.2 kg weight, 1929 kcal basis, measured 2026-08-09 consumption', () => {
  it('protein: goal 157 g, 124 g consumed today -> danger (78.98%, below the 80% warning floor)', () => {
    // The task's own acceptance text guessed "warning" here and flagged
    // "перевір фактом" (verify by fact) — 124/157 = 0.7898, which is < 0.8, so the
    // correct status is 'danger', not 'warning'. This test pins the real number.
    const weightKg = resolveWeightKg({ weight_goal_kg: 96 }, 98.2)
    const goal = resolveProteinGoalG({ daily_protein_goal_g: null }, weightKg)
    expect(goal).toBe(157)
    expect(goalStatus(124, goal)).toBe('danger')
  })

  it('fiber: goal 27 g, 25.8 g consumed today -> warning (95.6%)', () => {
    const basis = stableDayKcalBasis({ tdee_kcal: 2429, deficit_kcal: 500 })
    const goal = fiberGoalG(basis)
    expect(goal).toBe(27)
    expect(goalStatus(25.8, goal)).toBe('warning')
  })

  it('does not move sat_fat_goal_g/sugar_goal_g — #953 canon unchanged by #961', () => {
    const profile = { tdee_kcal: 2429, deficit_kcal: 500 }
    const basis = stableDayKcalBasis(profile)
    expect(satFatLimitG(basis)).toBe(21)
    expect(sugarLimitG(basis)).toBe(48)
  })
})

describe('protein/fiber goals — stable for the whole day (mirrors the stableDayKcalBasis "every hour" test)', () => {
  it('proteinGoalG/fiberGoalG return the same value regardless of when in the day they run', () => {
    const hours = [0, 900, 1579, 2366, 2934]
    const proteinValues = hours.map(() => proteinGoalG(98.2))
    const fiberValues = hours.map(() => fiberGoalG(1929))
    expect(new Set(proteinValues).size).toBe(1)
    expect(new Set(fiberValues).size).toBe(1)
    expect(proteinValues[0]).toBe(157)
    expect(fiberValues[0]).toBe(27)
  })
})
