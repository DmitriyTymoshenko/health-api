/**
 * Unit tests for #1396 — protein/fat as weight-derived RANGES with a midpoint POINT.
 *
 * REPLACES #966's per-goal-mode protein matrix test file (same filename kept —
 * Apex triage #1396, design decision 1: "protein_goal_matrix.test.ts is rewritten
 * to test the range/midpoint contract, not deleted"). #966's `PROTEIN_G_PER_KG_BY_GOAL`
 * is CANCELLED as the point source by the owner's 2026-09-16 decision: the point
 * (goal) is now the MIDPOINT of a single evidence-band range, for EVERY goal mode —
 * no more five different per-mode coefficients.
 *
 * SOURCE OF THE NUMBERS — owner decision, task #1396, relayed 2026-09-16 (Дмитро → Ліза
 * → Філ → Apex triage comment #7975): protein 1.6-2.4 g/kg, fat 0.8-1.0 g/kg, point =
 * midpoint of each range (protein 2.0, fat 0.9) for ALL `primary_goal` values.
 *
 * The helper is plain CommonJS (routes/*.js are CommonJS and are NOT migrated to TS,
 * see CLAUDE.md) — hence require(), not import.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  proteinGoalG,
  fatGoalG,
  proteinGoalRangeG,
  fatGoalRangeG,
  resolveProteinGoalG,
  resolveWeightKg,
  stableDayKcalBasis,
  satFatLimitG,
  sugarLimitG,
  fiberGoalG,
  PROTEIN_G_PER_KG_RANGE,
  FAT_G_PER_KG_RANGE,
  PROTEIN_POINT_G_PER_KG,
  FAT_POINT_G_PER_KG,
  GOAL_MODES,
} = require('../../lib/nutrition-targets')

/** Reference weight from the #1396 ticket (live weight_log value, 16.09). */
const TICKET_KG = 92.9

// ---------------------------------------------------------------------------
// The range constants themselves — owner decision, pinned so a future session
// cannot silently drift them back toward #966's per-mode numbers.
// ---------------------------------------------------------------------------

describe('#1396 — protein/fat range constants (owner decision 2026-09-16)', () => {
  it('protein range is 1.6-2.4 g/kg; fat range is 0.8-1.0 g/kg', () => {
    expect(PROTEIN_G_PER_KG_RANGE).toEqual({ min: 1.6, max: 2.4 })
    expect(FAT_G_PER_KG_RANGE).toEqual({ min: 0.8, max: 1.0 })
  })

  it('the point coefficient is the DERIVED midpoint, not a third hand-typed literal', () => {
    expect(PROTEIN_POINT_G_PER_KG).toBe((PROTEIN_G_PER_KG_RANGE.min + PROTEIN_G_PER_KG_RANGE.max) / 2)
    expect(PROTEIN_POINT_G_PER_KG).toBe(2.0)
    expect(FAT_POINT_G_PER_KG).toBe((FAT_G_PER_KG_RANGE.min + FAT_G_PER_KG_RANGE.max) / 2)
    expect(FAT_POINT_G_PER_KG).toBe(0.9)
  })
})

// ---------------------------------------------------------------------------
// Range functions — the reference numbers from the #1396 ticket acceptance text
// ---------------------------------------------------------------------------

describe('proteinGoalRangeG / fatGoalRangeG — reference point: 92.9 kg (#1396 acceptance)', () => {
  it('protein: min 149, max 223 (round(92.9*1.6), round(92.9*2.4))', () => {
    expect(proteinGoalRangeG(TICKET_KG)).toEqual({ min: 149, max: 223 })
  })

  it('fat: min 74, max 93 (round(92.9*0.8), round(92.9*1.0))', () => {
    expect(fatGoalRangeG(TICKET_KG)).toEqual({ min: 74, max: 93 })
  })

  it('point: protein 186 (round(92.9*2.0)), fat 84 (round(92.9*0.9))', () => {
    expect(proteinGoalG(TICKET_KG)).toBe(186)
    expect(fatGoalG(TICKET_KG)).toBe(84)
  })

  it('degrades to a zero range/point on bad weight instead of NaN reaching the UI', () => {
    for (const bad of [0, -10, NaN, null, undefined]) {
      expect(proteinGoalRangeG(bad)).toEqual({ min: 0, max: 0 })
      expect(fatGoalRangeG(bad)).toEqual({ min: 0, max: 0 })
      expect(proteinGoalG(bad)).toBe(0)
      expect(fatGoalG(bad)).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// #1396 REPLACES #966 — the point is now MODE-INDEPENDENT (the owner's whole
// decision: cancel the per-mode matrix, use one range + midpoint for everyone)
// ---------------------------------------------------------------------------

describe('#1396 — the point no longer depends on goal mode (supersedes #966\'s per-mode matrix)', () => {
  it('every goal mode resolves to the SAME protein point at the same weight', () => {
    // #966 used to give weight_loss 2.0, muscle_gain 1.8, maintenance 1.6, recomp 2.2,
    // endurance 1.3 — five DIFFERENT numbers. #1396 collapses all five to one midpoint.
    const points = GOAL_MODES.map((mode: string) =>
      resolveProteinGoalG({ daily_protein_goal_g: null, primary_goal: mode }, TICKET_KG)
    )
    expect(new Set(points).size).toBe(1)
    expect(points[0]).toBe(186)
  })

  it('weight_loss is unchanged by #1396 (2.0 g/kg midpoint == its old #966 coefficient) — no regression on the live default mode', () => {
    expect(resolveProteinGoalG({ daily_protein_goal_g: null, primary_goal: 'weight_loss' }, TICKET_KG)).toBe(186)
  })

  it('muscle_gain/maintenance/recomp/endurance now match weight_loss instead of their old #966 numbers (177/157/216/128)', () => {
    const modes = ['muscle_gain', 'maintenance', 'recomp', 'endurance']
    for (const mode of modes) {
      const got = resolveProteinGoalG({ daily_protein_goal_g: null, primary_goal: mode }, TICKET_KG)
      expect(got).toBe(186)
      expect(got).not.toBe({ muscle_gain: 177, maintenance: 157, recomp: 216, endurance: 128 }[mode])
    }
  })
})

// ---------------------------------------------------------------------------
// Structural guards — the class of bug this range math could still have
// ---------------------------------------------------------------------------

describe('#1396 — structural guards', () => {
  it('max is always strictly greater than min for both macros, at any positive weight', () => {
    for (const kg of [40, 60, 92.9, 120]) {
      const p = proteinGoalRangeG(kg)
      const f = fatGoalRangeG(kg)
      expect(p.max).toBeGreaterThan(p.min)
      expect(f.max).toBeGreaterThan(f.min)
    }
  })

  it('the point sits strictly between min and max (it is a real midpoint, not clamped to an edge)', () => {
    const p = proteinGoalRangeG(TICKET_KG)
    const pt = proteinGoalG(TICKET_KG)
    expect(pt).toBeGreaterThan(p.min)
    expect(pt).toBeLessThan(p.max)
  })

  it('is stable through the day (same discipline as stableDayKcalBasis)', () => {
    const hours = [0, 900, 1579, 2366, 2934]
    const values = hours.map(() => proteinGoalG(TICKET_KG))
    expect(new Set(values).size).toBe(1)
  })

  it('is a function of weight, not a hardcoded constant', () => {
    expect(proteinGoalG(92.9)).not.toBe(proteinGoalG(60))
    expect(proteinGoalG(92.9)).toBeGreaterThan(proteinGoalG(60))
  })
})

// ---------------------------------------------------------------------------
// Regression — #1396 must move protein/fat and NOTHING else
// ---------------------------------------------------------------------------

describe('#1396 REGRESSION — sat_fat/sugar/fiber are untouched', () => {
  it('sat_fat 21 / sugar 48 / fiber 27 are unchanged on the live weight_loss profile', () => {
    const basis = stableDayKcalBasis({ tdee_kcal: 2429, deficit_kcal: 500, primary_goal: 'weight_loss' })
    expect(basis).toBe(1929)
    expect(satFatLimitG(basis)).toBe(21)
    expect(sugarLimitG(basis)).toBe(48)
    expect(fiberGoalG(basis)).toBe(27)
  })

  it('fiber stays mode-INDEPENDENT per kcal basis (unaffected by the protein/fat range change)', () => {
    const cut = { tdee_kcal: 2429, deficit_kcal: 500, primary_goal: 'weight_loss' }
    const rec = { tdee_kcal: 2429, deficit_kcal: 500, primary_goal: 'recomp' }
    expect(stableDayKcalBasis(cut)).toBe(stableDayKcalBasis(rec))
    expect(fiberGoalG(stableDayKcalBasis(cut))).toBe(fiberGoalG(stableDayKcalBasis(rec)))
  })

  it('an explicit daily_protein_goal_g override still wins outright over the range/point (unchanged #961 behaviour)', () => {
    expect(resolveProteinGoalG({ daily_protein_goal_g: 200 }, TICKET_KG)).toBe(200)
  })
})

export {};
