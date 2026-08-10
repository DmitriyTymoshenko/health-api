/**
 * Unit tests for #968 — goal-mode wiring and the SIGN of the day's calorie basis.
 *
 * Three defects this file pins down, each verified RED against the pre-fix
 * lib/nutrition-targets.js (see the task comment for the recorded failures):
 *   1. `deficit_kcal || 500` made `maintenance` (deficit 0) physically unreachable.
 *   2. stableDayKcalBasis could only SUBTRACT, so `muscle_gain` had no surplus at all.
 *   3. primary_goal was never read by any formula.
 *
 * The helper is plain CommonJS (routes/*.js are CommonJS and are NOT migrated to TS,
 * see CLAUDE.md) — hence require(), not import.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveDayKcalTarget,
  stableDayKcalBasis,
  satFatLimitG,
  sugarLimitG,
  fiberGoalG,
  resolveDeficitKcal,
  resolveTdeeKcal,
  resolveGoalMode,
  goalKcalDelta,
  GOAL_MODES,
  DEFAULT_GOAL_MODE,
  GOAL_KCAL_RULES,
  PROTEIN_G_PER_KG_BY_GOAL,
} = require('../../lib/nutrition-targets')

/** The live profile as measured on 2026-08-09 (GET /api/profile). */
const LIVE_PROFILE = { tdee_kcal: 2429, deficit_kcal: 500, primary_goal: 'weight_loss' }

describe('REGRESSION — today\'s numbers must not move (live profile, 2026-08-09)', () => {
  it('weight_loss + deficit 500 still gives exactly 1929', () => {
    expect(stableDayKcalBasis(LIVE_PROFILE)).toBe(1929)
    expect(resolveDayKcalTarget(LIVE_PROFILE, undefined)).toBe(1929)
  })

  it('every downstream ceiling/goal derived from that basis is unchanged', () => {
    const basis = stableDayKcalBasis(LIVE_PROFILE)
    expect(satFatLimitG(basis)).toBe(21)
    expect(sugarLimitG(basis)).toBe(48)
    expect(fiberGoalG(basis)).toBe(27)
  })

  it('a profile with no primary_goal at all behaves exactly like weight_loss', () => {
    const noGoal = { tdee_kcal: 2429, deficit_kcal: 500 }
    expect(stableDayKcalBasis(noGoal)).toBe(stableDayKcalBasis(LIVE_PROFILE))
    expect(resolveDayKcalTarget(noGoal, 2500)).toBe(resolveDayKcalTarget(LIVE_PROFILE, 2500))
  })

  it('a null profile still falls back to the historical 2429 - 500', () => {
    expect(stableDayKcalBasis(null)).toBe(1929)
    expect(resolveDayKcalTarget(null, undefined)).toBe(1929)
  })
})

describe('DEFECT 1 — deficit_kcal: 0 must mean zero, not 500 (`||` -> `??`)', () => {
  it('resolveDeficitKcal returns 0 for an explicit 0 (pre-fix: 500)', () => {
    expect(resolveDeficitKcal({ deficit_kcal: 0 })).toBe(0)
  })

  it('a maintenance-by-number profile lands on TDEE, not TDEE-500 (pre-fix: 1929)', () => {
    const profile = { tdee_kcal: 2429, deficit_kcal: 0, primary_goal: 'weight_loss' }
    expect(stableDayKcalBasis(profile)).toBe(2429)
    expect(resolveDayKcalTarget(profile, undefined)).toBe(2429)
  })

  it('still falls back to 500 when the field is genuinely absent or unusable', () => {
    expect(resolveDeficitKcal({})).toBe(500)
    expect(resolveDeficitKcal(null)).toBe(500)
    expect(resolveDeficitKcal({ deficit_kcal: null })).toBe(500)
    expect(resolveDeficitKcal({ deficit_kcal: -100 })).toBe(500) // negative deficit is not a surplus
    expect(resolveDeficitKcal({ deficit_kcal: 'abc' })).toBe(500)
  })

  it('resolveTdeeKcal keeps `||` semantics — a 0 TDEE is missing data, not a goal', () => {
    expect(resolveTdeeKcal({ tdee_kcal: 0 })).toBe(2429)
    expect(resolveTdeeKcal({ tdee_kcal: 3119 })).toBe(3119)
  })
})

describe('DEFECT 2 — the basis must be able to ADD (muscle_gain surplus)', () => {
  const bulk = { tdee_kcal: 2429, deficit_kcal: 500, primary_goal: 'muscle_gain' }

  it('muscle_gain is TDEE +10% = 2672 (pre-fix: 1929, i.e. a DEFICIT while bulking)', () => {
    expect(stableDayKcalBasis(bulk)).toBe(2672)
    expect(resolveDayKcalTarget(bulk, undefined)).toBe(2672)
  })

  it('the basis is strictly ABOVE TDEE — the sign, not just the number', () => {
    expect(stableDayKcalBasis(bulk)).toBeGreaterThan(resolveTdeeKcal(bulk))
    expect(goalKcalDelta(bulk)).toBeGreaterThan(0)
  })

  it('an explicit surplus_kcal wins over the 10% default', () => {
    expect(goalKcalDelta({ ...bulk, surplus_kcal: 300 })).toBe(300)
    expect(stableDayKcalBasis({ ...bulk, surplus_kcal: 300 })).toBe(2729)
  })

  it('the WHOOP-burn branch ADDS the surplus too (pre-fix: burn - 500)', () => {
    // Burn 2800 while bulking must budget MORE than the burn, never less.
    expect(resolveDayKcalTarget(bulk, 2800)).toBe(2800 + 243)
    expect(resolveDayKcalTarget(bulk, 2800)).toBeGreaterThan(2800)
  })

  it('every ceiling scales with the surplus basis, none is hardcoded to the cut basis', () => {
    const basis = stableDayKcalBasis(bulk)
    expect(satFatLimitG(basis)).toBe(30)
    expect(sugarLimitG(basis)).toBe(67)
    expect(fiberGoalG(basis)).toBe(37)
  })
})

describe('DEFECT 3 — primary_goal is actually read by the math', () => {
  const base = { tdee_kcal: 2429, deficit_kcal: 500 }

  it('maintenance sets the delta to exactly 0 even when a deficit number is stored', () => {
    // The mode wins over a stale magnitude: this is the whole point of a mode switch.
    expect(goalKcalDelta({ ...base, primary_goal: 'maintenance' })).toBe(0)
    expect(stableDayKcalBasis({ ...base, primary_goal: 'maintenance' })).toBe(2429)
  })

  it('each mode produces its own basis (pre-fix: all of them gave 1929)', () => {
    const byMode = GOAL_MODES.reduce((acc: Record<string, number>, goal: string) => {
      acc[goal] = stableDayKcalBasis({ ...base, primary_goal: goal })
      return acc
    }, {})
    expect(byMode).toEqual({
      weight_loss: 1929,
      endurance: 1929, // status quo preserved on purpose — magnitude is #966, not #968
      maintenance: 2429,
      muscle_gain: 2672,
      // #966 added `recomp` to GOAL_MODES (PROTEIN only). It has no GOAL_KCAL_RULES
      // entry, so it falls through to the weight_loss rule — byte-identical to what a
      // recomp profile produced before #966, when it normalised to weight_loss outright.
      recomp: 1929,
    })
    expect(new Set(Object.values(byMode)).size).toBe(3) // three distinct bases, not one
  })

  it('endurance is a KNOWN mode, not silently coerced (owner decision: it stays)', () => {
    expect(GOAL_MODES).toContain('endurance')
    expect(resolveGoalMode({ primary_goal: 'endurance' })).toBe('endurance')
  })

  it('an unknown/absent mode degrades to the default instead of throwing', () => {
    // Was `recomp` until 2026-08-10; #966 promoted recomp to a real mode, so this
    // assertion needed a genuinely unknown value to keep testing what it claims.
    expect(resolveGoalMode({ primary_goal: 'bodybuilding' })).toBe(DEFAULT_GOAL_MODE)
    expect(resolveGoalMode(null)).toBe(DEFAULT_GOAL_MODE)
    expect(stableDayKcalBasis({ ...base, primary_goal: 'bodybuilding' })).toBe(1929)
  })

  it('#966 — recomp is a KNOWN mode now: own protein coefficient, deliberately NO own kcal rule', () => {
    expect(GOAL_MODES).toContain('recomp')
    expect(resolveGoalMode({ primary_goal: 'recomp' })).toBe('recomp')
    // Protein: its own number, the highest of the five (owner decision, #966).
    expect(PROTEIN_G_PER_KG_BY_GOAL.recomp).toBe(2.2)
    // Calories: the owner's #966 decision covers PROTEIN only. recomp is absent from
    // GOAL_KCAL_RULES on purpose, so goalKcalDelta's `|| DEFAULT_GOAL_MODE` guard
    // applies and the basis is unchanged. Characterization test: it pins a deliberate
    // silent fallback as a visible fact, so a future kcal decision for recomp has to
    // break this line consciously instead of drifting in.
    expect(GOAL_KCAL_RULES.recomp).toBeUndefined()
    expect(goalKcalDelta({ ...base, primary_goal: 'recomp' })).toBe(-500)
    expect(stableDayKcalBasis({ ...base, primary_goal: 'recomp' })).toBe(1929)
  })

  it('an explicit daily_kcal_goal still overrides every mode (unchanged priority)', () => {
    expect(stableDayKcalBasis({ ...base, primary_goal: 'muscle_gain', daily_kcal_goal: 2000 })).toBe(2000)
    expect(stableDayKcalBasis({ ...base, primary_goal: 'maintenance', daily_kcal_goal: 2000 })).toBe(2000)
  })
})
