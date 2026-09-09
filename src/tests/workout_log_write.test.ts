/**
 * Unit tests — lib/workout-log-write.js (#1314): weight_kg conversion + idempotent merge.
 * Weight-unit model per #1291 §5 (owner "затверджую" 09.09): unit lives on the exercise,
 * unknown unit -> weight_kg=null (never a silent kg default).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toWeightKg, buildExerciseFromParsed, mergeExercisesIntoDoc } = require('../../lib/workout-log-write')

describe('toWeightKg', () => {
  it('kg unit -> passthrough', () => {
    expect(toWeightKg(80, 'kg')).toBe(80)
  })

  it('lb unit -> converted via KG_PER_LB, rounded to 2dp', () => {
    // 235 lb (owner's stack reading in the reference example) -> ~106.59 kg
    expect(toWeightKg(235, 'lb')).toBe(106.59)
  })

  it('unknown/missing unit -> null, NEVER defaults to kg (#1291 §5 pt.4)', () => {
    expect(toWeightKg(160, null)).toBeNull()
    expect(toWeightKg(160, undefined)).toBeNull()
    expect(toWeightKg(160, 'lbs')).toBeNull() // not the canonical 'lb' token -> unrecognized, not guessed
  })

  it('non-finite weight_input -> null', () => {
    expect(toWeightKg(NaN, 'kg')).toBeNull()
  })
})

describe('buildExerciseFromParsed', () => {
  it('kg exercise: weight_input preserved AND weight_kg equals it', () => {
    const entry = { name: 'Жим під нахилом', sets: [{ reps: 8, weight_input: 80 }, { reps: 7, weight_input: 80 }] }
    const built = buildExerciseFromParsed(entry, 'kg')
    expect(built.name).toBe('Жим під нахилом')
    expect(built.sets).toEqual([
      { reps: 8, weight_input: 80, weight_unit: 'kg', weight_kg: 80 },
      { reps: 7, weight_input: 80, weight_unit: 'kg', weight_kg: 80 },
    ])
  })

  it('unit not set: weight_input preserved (same number the owner said), weight_kg null', () => {
    const entry = { name: 'Тяга блока', sets: [{ reps: 8, weight_input: 52 }] }
    const built = buildExerciseFromParsed(entry, null)
    expect(built.sets).toEqual([{ reps: 8, weight_input: 52, weight_unit: null, weight_kg: null }])
  })

  it('lb exercise: weight_kg converted, weight_input stays the plate number the owner saw', () => {
    const entry = { name: 'Біцепс скота', sets: [{ reps: 6, weight_input: 160 }, { reps: 6, weight_input: 145 }] }
    const built = buildExerciseFromParsed(entry, 'lb')
    expect(built.sets[0]).toEqual({ reps: 6, weight_input: 160, weight_unit: 'lb', weight_kg: 72.57 })
    expect(built.sets[1].weight_input).toBe(145) // trailing drop preserved, not "corrected"
  })
})

describe('mergeExercisesIntoDoc — idempotency by (date is the doc, exercise name is the key)', () => {
  it('appends a new exercise to an empty session', () => {
    const merged = mergeExercisesIntoDoc([], [{ name: 'A', sets: [{ reps: 1 }] }])
    expect(merged).toHaveLength(1)
  })

  it('re-merging the SAME exercise replaces it, does not duplicate', () => {
    const existing = [{ name: 'Тяга блока', sets: [{ reps: 8, weight_kg: 1 }] }]
    const merged = mergeExercisesIntoDoc(existing, [{ name: 'Тяга блока', sets: [{ reps: 8, weight_kg: 2 }] }])
    expect(merged).toHaveLength(1)
    expect(merged[0].sets[0].weight_kg).toBe(2)
  })

  it('a different exercise on the same date is appended alongside the existing one', () => {
    const existing = [{ name: 'A', sets: [] }]
    const merged = mergeExercisesIntoDoc(existing, [{ name: 'B', sets: [] }])
    expect(merged.map((e: any) => e.name)).toEqual(['A', 'B'])
  })

  it('full-session re-POST (all 4 reference exercises twice) converges, does not grow', () => {
    const session1 = [
      { name: 'Жим під нахилом', sets: [{ reps: 8, weight_kg: null }] },
      { name: 'Тяга блока', sets: [{ reps: 8, weight_kg: null }] },
    ]
    const merged = mergeExercisesIntoDoc(session1, session1)
    expect(merged).toHaveLength(2)
    expect(merged).toEqual(session1)
  })
})

export {}
