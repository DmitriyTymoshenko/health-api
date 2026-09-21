/**
 * #1474 — bodyweight-set weight autofill. Pure-logic tests for
 * lib/bodyweight-fill.js (fillBodyweightSets, resolveBodyweightForDate) and the
 * hasPositiveWeight() canon extension in lib/workout-sets.js, plus the two downstream
 * consumers that must NOT flip classification once weight_kg is filled from bodyweight
 * (lib/exercise-progression.js::selectWorkingSets, lib/workout-sets.js::pickBestSet).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fillBodyweightSets, resolveBodyweightForDate } = require('../../lib/bodyweight-fill')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hasPositiveWeight, pickBestSet } = require('../../lib/workout-sets')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { evaluateProgression } = require('../../lib/exercise-progression')

describe('fillBodyweightSets', () => {
  it('fills weight_kg + tags weight_source on a set with neither weight_kg nor weight_input', () => {
    const exercises = [{ name: 'Планка (сек)', sets: [{ reps: 60 }, { reps: 45 }] }]
    const { exercises: out, filledCount } = fillBodyweightSets(exercises, 92.9)
    expect(filledCount).toBe(2)
    expect(out[0].sets).toEqual([
      { reps: 60, weight_kg: 92.9, weight_source: 'bodyweight' },
      { reps: 45, weight_kg: 92.9, weight_source: 'bodyweight' },
    ])
  })

  it('leaves weight_kg null (no hardcode) when no bodyweight measurement exists yet', () => {
    const exercises = [{ name: 'Планка (сек)', sets: [{ reps: 60 }] }]
    const { exercises: out } = fillBodyweightSets(exercises, null)
    expect(out[0].sets[0]).toEqual({ reps: 60, weight_kg: null, weight_source: 'bodyweight' })
  })

  it('does NOT overwrite an explicit weight_kg', () => {
    const exercises = [{ name: 'Жим лежачи', sets: [{ reps: 8, weight_kg: 80 }] }]
    const { exercises: out, filledCount } = fillBodyweightSets(exercises, 92.9)
    expect(filledCount).toBe(0)
    expect(out[0].sets[0]).toEqual({ reps: 8, weight_kg: 80 })
  })

  it('does NOT overwrite an unresolved weight_input (weight_input set, weight_kg still null — #1314/#1318 unit_required state)', () => {
    const exercises = [{ name: 'Розводка', sets: [{ reps: 8, weight_input: 20, weight_unit: null, weight_kg: null }] }]
    const { exercises: out, filledCount } = fillBodyweightSets(exercises, 92.9)
    expect(filledCount).toBe(0)
    expect(out[0].sets[0]).toEqual({ reps: 8, weight_input: 20, weight_unit: null, weight_kg: null })
  })

  it('weight_kg === 0 counts as explicit (not autofilled) — 0 is a real logged value, not "unset"', () => {
    const exercises = [{ name: 'X', sets: [{ reps: 5, weight_kg: 0 }] }]
    const { filledCount } = fillBodyweightSets(exercises, 92.9)
    expect(filledCount).toBe(0)
  })

  it('mixed session: only the reps-only sets get filled, weighted sets untouched', () => {
    const exercises = [
      { name: 'Планка (сек)', sets: [{ reps: 60 }] },
      { name: 'Жим лежачи', sets: [{ reps: 8, weight_kg: 80 }] },
    ]
    const { exercises: out, filledCount } = fillBodyweightSets(exercises, 92.9)
    expect(filledCount).toBe(1)
    expect(out[0].sets[0]).toMatchObject({ weight_kg: 92.9, weight_source: 'bodyweight' })
    expect(out[1].sets[0]).toEqual({ reps: 8, weight_kg: 80 })
  })
})

describe('resolveBodyweightForDate', () => {
  function fakeWeightCol(docs: Array<{ date: string; weight_kg: number }>) {
    return {
      find: (filter: any) => {
        const maxDate = filter?.date?.$lte
        const matched = docs.filter(d => !maxDate || d.date <= maxDate)
        return {
          sort: () => ({
            limit: () => ({
              toArray: async () => [...matched].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 1),
            }),
          }),
        }
      },
    }
  }

  it('returns the latest weight_kg on/before the session date', async () => {
    const col = fakeWeightCol([
      { date: '2026-09-16', weight_kg: 92.9 },
      { date: '2026-09-10', weight_kg: 94.0 },
      { date: '2026-09-20', weight_kg: 91.5 }, // AFTER the session date — must be ignored
    ])
    const result = await resolveBodyweightForDate(col, '2026-09-17')
    expect(result).toBe(92.9)
  })

  it('returns null when no entry exists on/before the date', async () => {
    const col = fakeWeightCol([{ date: '2026-09-20', weight_kg: 91.5 }])
    const result = await resolveBodyweightForDate(col, '2026-09-17')
    expect(result).toBeNull()
  })

  it('returns null for a missing session date (never queries blind)', async () => {
    const col = fakeWeightCol([{ date: '2026-09-16', weight_kg: 92.9 }])
    const result = await resolveBodyweightForDate(col, undefined)
    expect(result).toBeNull()
  })
})

describe('hasPositiveWeight() — #1474 canon extension (weight_source excludes bodyweight-filled sets)', () => {
  it('a bodyweight-autofilled positive weight_kg does NOT count as "weighted"', () => {
    const sets = [{ reps: 60, weight_kg: 92.9, weight_source: 'bodyweight' }]
    expect(hasPositiveWeight(sets)).toBe(false)
  })

  it('a real (non-bodyweight) positive weight_kg still counts as weighted', () => {
    const sets = [{ reps: 8, weight_kg: 80 }]
    expect(hasPositiveWeight(sets)).toBe(true)
  })

  it('a mixed session with one real-weighted set still counts as weighted', () => {
    const sets = [
      { reps: 60, weight_kg: 92.9, weight_source: 'bodyweight' },
      { reps: 8, weight_kg: 80 },
    ]
    expect(hasPositiveWeight(sets)).toBe(true)
  })

  it('unfilled bodyweight sets (weight_kg null) still count as NOT weighted (unchanged behavior)', () => {
    const sets = [{ reps: 60, weight_kg: null, weight_source: 'bodyweight' }]
    expect(hasPositiveWeight(sets)).toBe(false)
  })
})

describe('pickBestSet() ranks a bodyweight-autofilled session by reps, not 1RM (#1130 canon preserved)', () => {
  it('ranks by reps even though weight_kg is a real positive number', () => {
    const sets = [
      { reps: 45, weight_kg: 92.9, weight_source: 'bodyweight' },
      { reps: 60, weight_kg: 92.9, weight_source: 'bodyweight' },
    ]
    const best = pickBestSet(sets)
    expect(best).toEqual({ orm: 0, weight: 0, reps: 60 })
  })
})

describe('evaluateProgression() reason_code stays bodyweight|bodyweight_top after autofill (#1291 canon preserved)', () => {
  it('reason_code=bodyweight when reps are below the target range top', () => {
    const result = evaluateProgression({
      exerciseName: 'Планка (сек)',
      sessions: [{ date: '2026-09-17', sets: [{ reps: 45, weight_kg: 92.9, weight_source: 'bodyweight' }] }],
      targetRepsRaw: '30-90',
    })
    expect(result.reason_code).toBe('bodyweight')
    expect(result.next_action).toBe('add_reps')
  })

  it('reason_code=bodyweight_top when reps meet/exceed the target range top', () => {
    const result = evaluateProgression({
      exerciseName: 'Планка (сек)',
      sessions: [{ date: '2026-09-17', sets: [{ reps: 90, weight_kg: 92.9, weight_source: 'bodyweight' }] }],
      targetRepsRaw: '30-90',
    })
    expect(result.reason_code).toBe('bodyweight_top')
    expect(result.next_action).toBe('hold')
  })
})

export {}
