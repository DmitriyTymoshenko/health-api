/**
 * Unit tests for lib/exercise-progression.js — task #1291 (Ф2, double progression by
 * weight). Pure-logic tests on synthetic sessions, per the owner-approved acceptance
 * path (Phil, 09.09 18:16): the live `workouts` collection has 0 exercises with >=2
 * sessions carrying weight_kg, so the truth table is proven here, not against prod data.
 *
 * The 4 canonical fixtures below are the owner's OWN logged workout (Telegram, 09.09),
 * not invented round numbers like `3x10` — chosen specifically because every invented
 * fixture the earlier body draft used made the old top-of-range rule look correct,
 * while these real numbers falsify it (see file header of exercise-progression.js).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  TOP_OF_RANGE_RULE,
  parseTargetReps,
  selectWorkingSets,
  evaluateProgression,
} = require('../../lib/exercise-progression')

type Set_ = { weight_kg?: number; reps?: number }
type Session = { date: string; sets: Set_[] }

function session(date: string, sets: Set_[]): Session {
  return { date, sets }
}

describe('parseTargetReps — 3 recognized forms + explicit 4th-form rejection', () => {
  it('parses a numeric range "8-12"', () => {
    expect(parseTargetReps('8-12')).toEqual({ kind: 'range', low: 8, high: 12 })
  })
  it('parses the open form "макс"', () => {
    expect(parseTargetReps('макс')).toEqual({ kind: 'open' })
  })
  it('parses a time value "45с" WITHOUT silently returning 45 reps (parseInt trap)', () => {
    expect(parseTargetReps('45с')).toEqual({ kind: 'time', seconds: 45 })
  })
  it('missing/empty target_reps is its own kind, not a crash', () => {
    expect(parseTargetReps(undefined)).toEqual({ kind: 'missing' })
    expect(parseTargetReps('')).toEqual({ kind: 'missing' })
  })
  it('explicitly rejects a 4th, unrecognized form instead of guessing', () => {
    expect(parseTargetReps('до відмови')).toEqual({ kind: 'unrecognized', raw: 'до відмови' })
  })
})

describe('selectWorkingSets — working_sets = sets at session max weight_kg (no ramp/straight classifier)', () => {
  it('reference: тяга (52x12 · 66x10 · 73x8 · 73x8) — warm-up drops out, working = the two 73kg sets', () => {
    const r = selectWorkingSets([
      { weight_kg: 52, reps: 12 },
      { weight_kg: 66, reps: 10 },
      { weight_kg: 73, reps: 8 },
      { weight_kg: 73, reps: 8 },
    ])
    expect(r.working_weight_kg).toBe(73)
    expect(r.working_sets).toHaveLength(2)
    expect(r.working_sets.map((s: Set_) => s.reps)).toEqual([8, 8])
    expect(r.set_scheme).toBe('ramp_up')
  })

  it('reference: жим 8x80 · 7x80 · 6x80 — fixed weight, ALL sets are working sets, descending reps is normal', () => {
    const r = selectWorkingSets([
      { weight_kg: 80, reps: 8 },
      { weight_kg: 80, reps: 7 },
      { weight_kg: 80, reps: 6 },
    ])
    expect(r.working_weight_kg).toBe(80)
    expect(r.working_sets).toHaveLength(3)
    expect(r.set_scheme).toBe('straight')
  })

  it('reference: розводка 10x235 x3 — single repeated weight, straight', () => {
    const r = selectWorkingSets([
      { weight_kg: 235, reps: 10 },
      { weight_kg: 235, reps: 10 },
      { weight_kg: 235, reps: 10 },
    ])
    expect(r.working_weight_kg).toBe(235)
    expect(r.working_sets).toHaveLength(3)
    expect(r.set_scheme).toBe('straight')
  })

  it('reference: скотта 6x160 · 6x160 · 6x145 — trailing fatigue drop is structurally excluded, never a regression', () => {
    const r = selectWorkingSets([
      { weight_kg: 160, reps: 6 },
      { weight_kg: 160, reps: 6 },
      { weight_kg: 145, reps: 6 },
    ])
    expect(r.working_weight_kg).toBe(160)
    expect(r.working_sets).toHaveLength(2)
    expect(r.set_scheme).toBe('straight_with_drop')
  })

  it('documented boundary: reverse pyramid 100/90/80 -> exactly 1 working set (top set only)', () => {
    const r = selectWorkingSets([
      { weight_kg: 100, reps: 6 },
      { weight_kg: 90, reps: 8 },
      { weight_kg: 80, reps: 10 },
    ])
    expect(r.working_weight_kg).toBe(100)
    expect(r.working_sets).toHaveLength(1)
    expect(r.set_scheme).toBe('straight_with_drop')
  })

  it('bodyweight session (no positive weight_kg on any set) is flagged, never via equipment', () => {
    const r = selectWorkingSets([{ reps: 10 }, { reps: 10 }])
    expect(r.is_bodyweight).toBe(true)
    expect(r.working_weight_kg).toBe(0)
  })
})

describe('evaluateProgression — asymmetric-pair field contract (повтори x вага, never swapped)', () => {
  it('{reps:8, weight_kg:80} must NOT be read as {reps:80, weight_kg:8} — a partial numeric guard would miss this', () => {
    const a = evaluateProgression({
      exerciseName: 'Test',
      weightUnit: 'kg',
      targetRepsRaw: '6-10',
      sessions: [session('2026-09-01', [{ reps: 8, weight_kg: 80 }])],
    })
    expect(a.working_weight_kg).toBe(80)
    expect(a.reps_by_working_set).toEqual([8])

    // Reversed fixture must produce a genuinely DIFFERENT result — proves the fields
    // are actually read distinctly, not coincidentally ignored.
    const b = evaluateProgression({
      exerciseName: 'Test',
      weightUnit: 'kg',
      targetRepsRaw: '6-10',
      sessions: [session('2026-09-01', [{ reps: 80, weight_kg: 8 }])],
    })
    expect(b.working_weight_kg).toBe(8)
    expect(b.reps_by_working_set).toEqual([80])
    expect(b.working_weight_kg).not.toBe(a.working_weight_kg)
  })
})

describe('evaluateProgression — all 8 truth-table outputs, each with >=1 test', () => {
  it('#0 insufficient_data/no_session — no session at all', () => {
    const r = evaluateProgression({ exerciseName: 'Нова вправа', weightUnit: 'kg', targetRepsRaw: '8-12', sessions: [] })
    expect(r.next_action).toBe('insufficient_data')
    expect(r.reason_code).toBe('no_session')
  })

  it('#0b insufficient_data/no_session — session exists but its sets[] for THIS exercise is empty (no exercise-level fallback)', () => {
    const r = evaluateProgression({
      exerciseName: 'Планка', weightUnit: null, targetRepsRaw: '45с',
      sessions: [session('2026-09-01', [])],
    })
    expect(r.next_action).toBe('insufficient_data')
    expect(r.reason_code).toBe('no_session')
  })

  it('#1 not_applicable/time_based — Планка "45с" (parseInt trap: must NOT read 45 as reps)', () => {
    const r = evaluateProgression({
      exerciseName: 'Планка', weightUnit: null, targetRepsRaw: '45с',
      sessions: [session('2026-09-01', [{ reps: 45 }])],
    })
    expect(r.next_action).toBe('not_applicable')
    expect(r.reason_code).toBe('time_based')
  })

  it('#2 add_reps/range_open — Підтягування "макс" never reaches add_weight, even at high reps', () => {
    const r = evaluateProgression({
      exerciseName: 'Підтягування', weightUnit: null, targetRepsRaw: 'макс',
      sessions: [session('2026-09-01', [{ reps: 20 }])],
    })
    expect(r.next_action).toBe('add_reps')
    expect(r.reason_code).toBe('range_open')
  })

  it('#3 range_not_set/not_in_program — exercise outside the active program (target_reps undefined)', () => {
    const r = evaluateProgression({
      exerciseName: 'Вправа поза програмою', weightUnit: 'kg', targetRepsRaw: undefined,
      sessions: [session('2026-09-01', [{ weight_kg: 20, reps: 10 }])],
    })
    expect(r.next_action).toBe('range_not_set')
    expect(r.reason_code).toBe('not_in_program')
  })

  it('#4a add_reps/bodyweight — bodyweight exercise below the top of its rep range', () => {
    const r = evaluateProgression({
      exerciseName: 'Підйом ніг', weightUnit: null, targetRepsRaw: '10-15',
      sessions: [session('2026-09-01', [{ reps: 10 }, { reps: 9 }])],
    })
    expect(r.next_action).toBe('add_reps')
    expect(r.reason_code).toBe('bodyweight')
  })

  it('#4b hold/bodyweight_top — bodyweight exercise AT the top of its rep range (no weight to add)', () => {
    const r = evaluateProgression({
      exerciseName: 'Підйом ніг', weightUnit: null, targetRepsRaw: '10-15',
      sessions: [session('2026-09-01', [{ reps: 15 }, { reps: 15 }])],
    })
    expect(r.next_action).toBe('hold')
    expect(r.reason_code).toBe('bodyweight_top')
  })

  it('#5 unit_not_set/unit_required — weighted exercise, valid range, but weight_unit not set on the exercise', () => {
    const r = evaluateProgression({
      exerciseName: 'Жим в нахилі', weightUnit: null, targetRepsRaw: '8-12',
      sessions: [session('2026-09-09', [{ weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 7 }, { weight_kg: 80, reps: 6 }])],
    })
    expect(r.next_action).toBe('unit_not_set')
    expect(r.reason_code).toBe('unit_required')
  })

  it('#6 reduce_weight/weight_too_high — reference: скотта 6x160·6x160·6x145 at isolation range 10-15', () => {
    const r = evaluateProgression({
      exerciseName: 'Молоткові згинання на лаві Скотта', weightUnit: 'lb', targetRepsRaw: '10-15',
      sessions: [session('2026-09-09', [{ weight_kg: 160, reps: 6 }, { weight_kg: 160, reps: 6 }, { weight_kg: 145, reps: 6 }])],
    })
    expect(r.working_weight_kg).toBe(160)
    expect(r.next_action).toBe('reduce_weight')
    expect(r.reason_code).toBe('weight_too_high')
  })

  it('#7 add_weight/range_top_reached — reference: тяга 8x52·8x66·8x73·8x73, working reps(8) hits top of 6-8', () => {
    const r = evaluateProgression({
      exerciseName: 'Тяга верхнього блоку', weightUnit: 'kg', targetRepsRaw: '6-8',
      sessions: [session('2026-09-09', [
        { weight_kg: 52, reps: 12 }, { weight_kg: 66, reps: 10 }, { weight_kg: 73, reps: 8 }, { weight_kg: 73, reps: 8 },
      ])],
    })
    expect(r.working_weight_kg).toBe(73)
    expect(r.next_action).toBe('add_weight')
    expect(r.reason_code).toBe('range_top_reached')
  })

  it('#8 reduce_weight/weight_too_high (default variant, now mean per #1291 owner decision) — reference: жим 8x80·7x80·6x80 at 8-12. This fixture is still the owner\'s falsifying case for the OLD "reach top on ALL sets" rule (max rep 8 never nears high=12 under any variant); with the default now mean(8,7,6)=7 < low(8), it additionally goes below the range bottom — updated from the earlier expectation of add_reps/below_range_top, which held only before the owner picked mean as the default', () => {
    const r = evaluateProgression({
      exerciseName: 'Жим в нахилі', weightUnit: 'kg', targetRepsRaw: '8-12',
      sessions: [session('2026-09-09', [{ weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 7 }, { weight_kg: 80, reps: 6 }])],
    })
    expect(r.working_weight_kg).toBe(80)
    expect(r.next_action).toBe('reduce_weight')
    expect(r.reason_code).toBe('weight_too_high')
  })
})

describe('evaluateProgression — priority order on a conflicting input (#10.2 acceptance)', () => {
  it('no range AND no unit -> range_not_set wins over unit_not_set (row 3 before row 5)', () => {
    const r = evaluateProgression({
      exerciseName: 'Вправа-конфлікт', weightUnit: null, targetRepsRaw: undefined,
      sessions: [session('2026-09-01', [{ weight_kg: 40, reps: 10 }])],
    })
    expect(r.next_action).toBe('range_not_set')
    expect(r.reason_code).toBe('not_in_program')
  })
})

describe('TOP_OF_RANGE_RULE — parameterized across all 4 candidate variants (owner decision 2026-09-09 = mean, #1291)', () => {
  // жим-shaped fixture, fixed weight so ALL 3 sets are "working sets": reps [8,7,6].
  const fixture = () => [session('2026-09-09', [
    { weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 7 }, { weight_kg: 80, reps: 6 },
  ])]

  it('documents that TOP_OF_RANGE_RULE is the owner-approved value, one of the 4 known variants', () => {
    expect(['all', 'first', 'mean', 'best']).toContain(TOP_OF_RANGE_RULE)
  })

  it.each([
    ['all', 'add_reps'],   // not every rep >= 8 (7 and 6 fail) -> falls through
    ['first', 'add_weight'], // first working rep (8) >= high(8)
    ['best', 'add_weight'],  // best working rep (8) >= high(8)
    ['mean', 'add_reps'],    // mean (7) < high(8), and 7 is not < low(7) either
  ])('range 7-8, variant=%s -> %s', (variant, expected) => {
    const r = evaluateProgression({
      exerciseName: 'Жим в нахилі', weightUnit: 'kg', targetRepsRaw: '7-8',
      sessions: fixture(),
      variant: variant as 'all' | 'first' | 'mean' | 'best',
    })
    expect(r.next_action).toBe(expected)
  })

  it('range 8-9, variant=mean -> reduce_weight (mean of 8/7/6 = 7, below low=8) while first/best do not', () => {
    const mean = evaluateProgression({
      exerciseName: 'Жим в нахилі', weightUnit: 'kg', targetRepsRaw: '8-9', sessions: fixture(), variant: 'mean',
    })
    expect(mean.next_action).toBe('reduce_weight')

    const first = evaluateProgression({
      exerciseName: 'Жим в нахилі', weightUnit: 'kg', targetRepsRaw: '8-9', sessions: fixture(), variant: 'first',
    })
    expect(first.next_action).not.toBe('reduce_weight')
  })

  it('range 7-8, variant=mean, reps 8/8/7 -> RAW fraction 7.67 stays below top (add_reps); rounding to 8 would wrongly flip it to add_weight — rounding is forbidden', () => {
    // raw mean = (8+8+7)/3 = 7.6666... — meetsTop() must compare this UNROUNDED against
    // high=8. If someone "improved" repsStatValue()/meetsTop() to round the fraction
    // (Math.round(7.666...) === 8), 8 >= high(8) would be true and the verdict would
    // flip to add_weight/range_top_reached. This test locks the raw-fraction contract.
    const r = evaluateProgression({
      exerciseName: 'Жим в нахилі', weightUnit: 'kg', targetRepsRaw: '7-8',
      sessions: [session('2026-09-09', [{ weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 8 }, { weight_kg: 80, reps: 7 }])],
      variant: 'mean',
    })
    expect(r.next_action).toBe('add_reps')
    expect(r.reason_code).toBe('below_range_top')
  })
})

describe('increment step + suggested weight — derived from THIS exercise\'s own history, never a constant', () => {
  it('< 2 distinct historical working weights -> step_source unknown, suggested_weight_kg null', () => {
    const r = evaluateProgression({
      exerciseName: 'Розведення в сторони', weightUnit: 'lb', targetRepsRaw: '8-10',
      sessions: [session('2026-09-09', [{ weight_kg: 235, reps: 10 }, { weight_kg: 235, reps: 10 }, { weight_kg: 235, reps: 10 }])],
    })
    expect(r.next_action).toBe('add_weight')
    expect(r.step_source).toBe('unknown')
    expect(r.increment_step_kg).toBeNull()
    expect(r.suggested_weight_kg).toBeNull()
  })

  it('>= 2 distinct historical working weights -> step = minimal positive gap, suggested_weight in the exercise\'s own unit', () => {
    const r = evaluateProgression({
      exerciseName: 'Розведення в сторони', weightUnit: 'lb', targetRepsRaw: '8-10',
      sessions: [
        session('2026-08-01', [{ weight_kg: 100, reps: 10 }]),
        session('2026-09-09', [{ weight_kg: 107, reps: 10 }]),
      ],
    })
    expect(r.next_action).toBe('add_weight')
    expect(r.step_source).toBe('history')
    expect(r.increment_step_kg).toBeCloseTo(7, 5)
    expect(r.suggested_weight_kg).toBeCloseTo(114, 5)
    expect(r.suggested_weight_display.unit).toBe('lb')
    expect(r.suggested_weight_display.value).toBeCloseTo(114 / 0.45359237, 2)
  })

  it('weight_unit=kg displays the canonical kg value unchanged', () => {
    const r = evaluateProgression({
      exerciseName: 'Жим гантелей лежачи', weightUnit: 'kg', targetRepsRaw: '8-10',
      sessions: [
        session('2026-08-01', [{ weight_kg: 40, reps: 10 }]),
        session('2026-09-09', [{ weight_kg: 42.5, reps: 10 }]),
      ],
    })
    expect(r.next_action).toBe('add_weight')
    expect(r.suggested_weight_display).toEqual({ value: 45, unit: 'kg' })
  })
})

export {}
