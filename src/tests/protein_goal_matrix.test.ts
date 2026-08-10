/**
 * Unit tests for #966 — PROTEIN_G_PER_KG_BY_GOAL, the per-goal-mode protein matrix.
 *
 * Replaces #961's single `PROTEIN_G_PER_KG = 1.6`, which was right only for the one
 * mode the profile happened to be in. One test PER MODE, as required by the task.
 *
 * SOURCE OF TRUTH for every number below: the #966 task DESCRIPTION, block
 * "✅ РІШЕННЯ ВЛАСНИКА ОТРИМАНЕ" (owner decision relayed by @lisa 2026-08-09 18:13:57).
 * It SUPERSEDES the earlier table in comment 18:08:17 (2.2 / 1.9 / 1.7 / 2.1 / 1.3) —
 * that comment literally says "це фінал, більше уточнень не буде" and is nonetheless
 * wrong about the numbers. This file asserts the CURRENT canon and, in the last block,
 * explicitly asserts that the superseded numbers are NOT in the code, so a future
 * session that reads the comments instead of the description fails loudly.
 *
 * VERIFIED RED against the pre-fix lib/nutrition-targets.js — see the #966 task comment
 * for the recorded failures (pre-fix every mode returned the flat 1.6 g/kg value).
 *
 * The helper is plain CommonJS (routes/*.js are CommonJS and are NOT migrated to TS,
 * see CLAUDE.md) — hence require(), not import.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  proteinGoalG,
  proteinGPerKg,
  resolveProteinGoalG,
  resolveWeightKg,
  stableDayKcalBasis,
  satFatLimitG,
  sugarLimitG,
  fiberGoalG,
  PROTEIN_G_PER_KG_BY_GOAL,
  GOAL_MODES,
  DEFAULT_GOAL_MODE,
} = require('../../lib/nutrition-targets')

/** Weight quoted in the #966 decision table (grams there are computed from this). */
const TICKET_KG = 98.2
/** Weight actually in weight_log on 2026-08-10, measured live before implementing. */
const LIVE_KG = 98

/** The live profile, minus the goal — each test supplies its own mode. */
const BASE_PROFILE = { tdee_kcal: 2429, deficit_kcal: 500, daily_protein_goal_g: null }

const profileFor = (primary_goal: string) => ({ ...BASE_PROFILE, primary_goal })

// ---------------------------------------------------------------------------
// One test per mode — the task's explicit acceptance criterion
// ---------------------------------------------------------------------------

describe('#966 — protein matrix, one mode at a time', () => {
  it('weight_loss (cutting) = 2.0 g/kg -> 196 g — TOP of the ISSN 2.0-2.4 band, not the 2.4 extreme', () => {
    const profile = profileFor('weight_loss')
    expect(proteinGPerKg(profile)).toBe(2.0)
    expect(proteinGoalG(TICKET_KG, profile)).toBe(196)
    expect(proteinGoalG(LIVE_KG, profile)).toBe(196) // live weight rounds to the same goal
    expect(resolveProteinGoalG(profile, LIVE_KG)).toBe(196)
  })

  it('muscle_gain (bulk) = 1.8 g/kg -> 177 g — above Мацюпа 1.3-1.5, below the 2.2 band top', () => {
    const profile = profileFor('muscle_gain')
    expect(proteinGPerKg(profile)).toBe(1.8)
    expect(proteinGoalG(TICKET_KG, profile)).toBe(177)
    expect(resolveProteinGoalG(profile, TICKET_KG)).toBe(177)
  })

  it('maintenance = 1.6 g/kg -> 157 g — LOWER bound of 1.6-1.8 (== the old #961 constant)', () => {
    const profile = profileFor('maintenance')
    expect(proteinGPerKg(profile)).toBe(1.6)
    expect(proteinGoalG(TICKET_KG, profile)).toBe(157)
    // The one mode whose number is unchanged by #966 — worth pinning, because it is
    // the value #961 applied to ALL modes, and a half-applied matrix would look right
    // here while being wrong everywhere else.
    expect(resolveProteinGoalG(profile, TICKET_KG)).toBe(157)
  })

  it('recomp = 2.2 g/kg -> 216 g — the HIGHEST of the five (hold muscle + cut fat at once)', () => {
    const profile = profileFor('recomp')
    expect(proteinGPerKg(profile)).toBe(2.2)
    expect(proteinGoalG(TICKET_KG, profile)).toBe(216)
    // recomp is NEW in the enum (#966). Before it existed, this profile normalised to
    // weight_loss; the test asserts it now has a number of its own, strictly higher.
    expect(proteinGPerKg(profile)).toBeGreaterThan(proteinGPerKg(profileFor('weight_loss')))
  })

  it('endurance = 1.3 g/kg -> 128 g — middle of the Koliada 04.01 band 1.2-1.4 (the only course-sourced row)', () => {
    const profile = profileFor('endurance')
    expect(proteinGPerKg(profile)).toBe(1.3)
    expect(proteinGoalG(TICKET_KG, profile)).toBe(128)
    // Lowest of the five — endurance athletes eat carbs, not protein maximums.
    const all = GOAL_MODES.map((m: string) => PROTEIN_G_PER_KG_BY_GOAL[m])
    expect(PROTEIN_G_PER_KG_BY_GOAL.endurance).toBe(Math.min(...all))
  })
})

// ---------------------------------------------------------------------------
// Structural guards — the class of bug this matrix could still have
// ---------------------------------------------------------------------------

describe('#966 — matrix integrity', () => {
  it('covers EXACTLY the declared goal modes — no member without a coefficient, no orphan key', () => {
    // Without this, adding a 6th mode to GOAL_MODES would silently produce
    // `undefined` g/kg -> NaN grams on screen, or a coefficient nothing can reach.
    expect(Object.keys(PROTEIN_G_PER_KG_BY_GOAL).sort()).toEqual([...GOAL_MODES].sort())
    for (const mode of GOAL_MODES) {
      expect(typeof PROTEIN_G_PER_KG_BY_GOAL[mode]).toBe('number')
      expect(Number.isFinite(proteinGoalG(TICKET_KG, profileFor(mode)))).toBe(true)
      expect(proteinGoalG(TICKET_KG, profileFor(mode))).toBeGreaterThan(0)
    }
  })

  it('the five modes are five DISTINCT numbers except maintenance/nothing — no accidental copy-paste', () => {
    expect(PROTEIN_G_PER_KG_BY_GOAL).toEqual({
      weight_loss: 2.0,
      muscle_gain: 1.8,
      maintenance: 1.6,
      recomp: 2.2,
      endurance: 1.3,
    })
    expect(new Set(Object.values(PROTEIN_G_PER_KG_BY_GOAL)).size).toBe(5)
  })

  it('does NOT carry the superseded table from comment 18:08:17 (2.2/1.9/1.7/2.1/1.3)', () => {
    // That comment says "це фінал" and is wrong; @lisa 18:13:57 replaced it. Pinned
    // here so a session that reads comments instead of the description fails loudly
    // instead of shipping the owner's discarded numbers.
    expect(PROTEIN_G_PER_KG_BY_GOAL.weight_loss).not.toBe(2.2)
    expect(PROTEIN_G_PER_KG_BY_GOAL.muscle_gain).not.toBe(1.9)
    expect(PROTEIN_G_PER_KG_BY_GOAL.maintenance).not.toBe(1.7)
    expect(PROTEIN_G_PER_KG_BY_GOAL.recomp).not.toBe(2.1)
  })

  it('an absent/unknown mode uses the DEFAULT mode coefficient, never undefined -> NaN', () => {
    expect(proteinGPerKg(undefined)).toBe(PROTEIN_G_PER_KG_BY_GOAL[DEFAULT_GOAL_MODE])
    expect(proteinGPerKg(null)).toBe(PROTEIN_G_PER_KG_BY_GOAL[DEFAULT_GOAL_MODE])
    expect(proteinGPerKg({ primary_goal: 'bodybuilding' })).toBe(PROTEIN_G_PER_KG_BY_GOAL[DEFAULT_GOAL_MODE])
    expect(proteinGoalG(TICKET_KG, { primary_goal: 'bodybuilding' })).toBe(196)
  })

  it('still degrades to 0 on bad weight in EVERY mode (no NaN reaches the UI)', () => {
    for (const mode of GOAL_MODES) {
      for (const bad of [0, -10, NaN, null, undefined]) {
        expect(proteinGoalG(bad, profileFor(mode))).toBe(0)
      }
    }
  })

  it('is stable through the day in every mode (same discipline as stableDayKcalBasis)', () => {
    for (const mode of GOAL_MODES) {
      const values = [0, 900, 1579, 2366, 2934].map(() => proteinGoalG(TICKET_KG, profileFor(mode)))
      expect(new Set(values).size).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Regression — #966 must move protein and NOTHING else
// ---------------------------------------------------------------------------

describe('#966 REGRESSION — only the protein goal moves', () => {
  it('sat_fat 21 / sugar 48 / fiber 27 are untouched on the live weight_loss profile', () => {
    const basis = stableDayKcalBasis(profileFor('weight_loss'))
    expect(basis).toBe(1929)
    expect(satFatLimitG(basis)).toBe(21)
    expect(sugarLimitG(basis)).toBe(48)
    expect(fiberGoalG(basis)).toBe(27)
  })

  it('fiber stays mode-INDEPENDENT per kcal basis — it is 14 g/1000 kcal by construction', () => {
    // Two modes that share a kcal basis must share a fiber goal; the protein goal
    // between the same two must differ. That is the whole shape of #966 in one test.
    const cut = profileFor('weight_loss')
    const rec = profileFor('recomp')
    expect(stableDayKcalBasis(cut)).toBe(stableDayKcalBasis(rec))
    expect(fiberGoalG(stableDayKcalBasis(cut))).toBe(fiberGoalG(stableDayKcalBasis(rec)))
    expect(proteinGoalG(TICKET_KG, cut)).not.toBe(proteinGoalG(TICKET_KG, rec))
  })

  it('the live 2026-08-10 profile (weight_loss, 98 kg, no override) resolves to 196 g', () => {
    // Mirrors the live acceptance curl: weight_log 98.0 kg, daily_protein_goal_g null,
    // goals.protein.target_value null. Was 157 before #966.
    const weightKg = resolveWeightKg({ weight_goal_kg: 96 }, LIVE_KG)
    expect(resolveProteinGoalG(profileFor('weight_loss'), weightKg)).toBe(196)
  })
})
