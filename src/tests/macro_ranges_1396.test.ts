/**
 * Unit tests for #1396 — carbsResidualG / deriveMacroRangesG
 * (lib/targets-resolver.js), the rounding contract that turns protein/fat
 * ranges + a resolved kcal target into a residual carbs figure.
 *
 * REFERENCE POINT (from the #1396 ticket + Apex triage #7975, live-measured
 * 16.09 17:11 Kyiv): weight_kg 92.9, kcal 2201 ->
 *   protein: min 149 · max 223 · point 186
 *   fat:     min 74  · max 93  · point 84
 *   carbs:   min 118 · max 235 · point 175
 *
 * ROUNDING CONTRACT (F11, Apex triage): protein/fat min/max/point grams are
 * rounded FIRST; carbs residual is computed from those ALREADY-ROUNDED grams.
 * Computing from the RAW (unrounded) g/kg coefficients instead gives
 * carbs_max = 234, not 235 — this file pins the ROUNDED-first order explicitly
 * so a future refactor cannot silently swap it back (that swap is invisible
 * unless you check this exact boundary case).
 *
 * The helper is plain CommonJS (routes/*.js are CommonJS and are NOT migrated
 * to TS, see CLAUDE.md) — hence require(), not import.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { carbsResidualG, deriveMacroRangesG } = require('../../lib/targets-resolver')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { proteinGoalRangeG, fatGoalRangeG } = require('../../lib/nutrition-targets')

const REF_WEIGHT_KG = 92.9
const REF_KCAL = 2201

describe('#1396 — reference point: 92.9 kg / 2201 kcal (ticket acceptance numbers)', () => {
  it('protein range/point: min 149, max 223, point 186', () => {
    const macros = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, { daily_protein_goal_g: null })
    expect(macros.protein_min_g).toBe(149)
    expect(macros.protein_max_g).toBe(223)
    expect(macros.protein_point_g).toBe(186)
  })

  it('fat range/point: min 74, max 93, point 84', () => {
    const macros = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, { daily_protein_goal_g: null })
    expect(macros.fat_min_g).toBe(74)
    expect(macros.fat_max_g).toBe(93)
    expect(macros.fat_point_g).toBe(84)
  })

  it('carbs residual: min 118, max 235, point 175 — the exact ticket acceptance criterion', () => {
    const macros = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, { daily_protein_goal_g: null })
    expect(macros.carbs_point_g).toBe(175)
    expect(macros.carbs_max_g).toBe(235)
    expect(macros.carbs_min_g).toBe(118)
  })
})

describe('#1396 — rounding contract: residual MUST use already-rounded protein/fat grams', () => {
  it('carbsResidualG on the ROUNDED min combination (149, 74) gives 235, not 234', () => {
    // 235 = round((2201 - 149*4 - 74*9) / 4) = round(939/4) = round(234.75)
    expect(carbsResidualG(REF_KCAL, 149, 74)).toBe(235)
  })

  it('the RAW (unrounded) g/kg coefficients would give 234 — the exact off-by-one this contract prevents', () => {
    // 92.9 * 1.6 = 148.64, 92.9 * 0.8 = 74.32 (unrounded)
    // round((2201 - 148.64*4 - 74.32*9) / 4) = round(937.56/4) = round(234.39) = 234
    const rawMin = carbsResidualG(REF_KCAL, 92.9 * 1.6, 92.9 * 0.8)
    expect(rawMin).toBe(234)
    expect(rawMin).not.toBe(deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, {}).carbs_max_g)
  })

  it('carbsResidualG on the ROUNDED max combination (223, 93) gives 118', () => {
    // round((2201 - 223*4 - 93*9) / 4) = round(472/4) = 118
    expect(carbsResidualG(REF_KCAL, 223, 93)).toBe(118)
  })

  it('carbsResidualG on the ROUNDED point combination (186, 84) gives 175', () => {
    // round((2201 - 186*4 - 84*9) / 4) = round(701/4) = round(175.25) = 175
    expect(carbsResidualG(REF_KCAL, 186, 84)).toBe(175)
  })

  it('floors at 0 instead of going negative on an extreme low-kcal / high-protein+fat combination', () => {
    expect(carbsResidualG(500, 223, 93)).toBe(0)
  })
})

describe('#1396 — carbs_max pairs with the LOWEST protein+fat combination, carbs_min with the HIGHEST', () => {
  it('carbs_max_g uses protein_min_g/fat_min_g (least protein+fat -> most carbs left over)', () => {
    const macros = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, {})
    const range = proteinGoalRangeG(REF_WEIGHT_KG)
    const fatRange = fatGoalRangeG(REF_WEIGHT_KG)
    expect(macros.carbs_max_g).toBe(carbsResidualG(REF_KCAL, range.min, fatRange.min))
  })

  it('carbs_min_g uses protein_max_g/fat_max_g (most protein+fat -> least carbs left over)', () => {
    const macros = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, {})
    const range = proteinGoalRangeG(REF_WEIGHT_KG)
    const fatRange = fatGoalRangeG(REF_WEIGHT_KG)
    expect(macros.carbs_min_g).toBe(carbsResidualG(REF_KCAL, range.max, fatRange.max))
  })

  it('carbs_max is always >= carbs_min (a non-degenerate carbs range)', () => {
    const macros = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, {})
    expect(macros.carbs_max_g).toBeGreaterThanOrEqual(macros.carbs_min_g)
  })
})

describe('#1396 — protein override affects the POINT only, never min/max/carbs range shape', () => {
  it('an explicit daily_protein_goal_g moves protein_point_g but NOT protein_min_g/max_g', () => {
    const noOverride = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, { daily_protein_goal_g: null })
    const withOverride = deriveMacroRangesG(REF_KCAL, REF_WEIGHT_KG, { daily_protein_goal_g: 220 })
    expect(withOverride.protein_point_g).toBe(220)
    expect(withOverride.protein_min_g).toBe(noOverride.protein_min_g)
    expect(withOverride.protein_max_g).toBe(noOverride.protein_max_g)
    // The override DOES change the point-based carbs residual, as expected.
    expect(withOverride.carbs_point_g).not.toBe(noOverride.carbs_point_g)
    // ...but never the range-based carbs_min_g/carbs_max_g (those never read the point).
    expect(withOverride.carbs_min_g).toBe(noOverride.carbs_min_g)
    expect(withOverride.carbs_max_g).toBe(noOverride.carbs_max_g)
  })
})

describe('#1396 — last-resort guard: no weight data anywhere degrades to a fixed point, not 0', () => {
  it('weightKg=0 still produces a usable (non-zero) protein/fat point via the fallback', () => {
    const macros = deriveMacroRangesG(2000, 0, { daily_protein_goal_g: null })
    expect(macros.protein_min_g).toBe(0)
    expect(macros.protein_max_g).toBe(0)
    expect(macros.protein_point_g).toBeGreaterThan(0) // fallback, not 0
    expect(macros.fat_point_g).toBeGreaterThan(0) // fallback, not 0
    expect(Number.isFinite(macros.carbs_point_g)).toBe(true)
  })
})

export {};
