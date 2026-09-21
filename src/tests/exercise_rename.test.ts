/**
 * Unit tests for lib/exercise-rename.js (#1472) — pure helpers behind
 * PATCH /api/workouts/exercises/:name/name, DB-free (same pattern as
 * workout_log_write.test.ts for lib/workout-log-write.js).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  mergeLibraryFields,
  consolidateSessionExercises,
  replaceNameDedup,
  renameInProgramDays,
} = require('../../lib/exercise-rename')

describe('mergeLibraryFields', () => {
  it('fills a field only when target is null/undefined AND source has a value', () => {
    const target = { equipment: null, video_url: undefined, description_ua: 'existing', weight_unit: 'kg' }
    const source = { equipment: 'machine', video_url: 'https://x', description_ua: 'from source', weight_unit: 'lb' }
    const fill = mergeLibraryFields(target, source)
    expect(fill).toEqual({ equipment: 'machine', video_url: 'https://x' })
    // description_ua and weight_unit NOT included — target already had a value
  })

  it('never includes muscle_group even if target is null and source has a value', () => {
    const fill = mergeLibraryFields({ muscle_group: null }, { muscle_group: 'chest' })
    expect(fill.muscle_group).toBeUndefined()
  })

  it("does not fill from a source field that is itself null/undefined", () => {
    const fill = mergeLibraryFields({ cues: null }, { cues: null })
    expect(fill.cues).toBeUndefined()
  })

  it('returns {} when target already has every fillable field set', () => {
    const target = { equipment: 'a', description_ua: 'b', video_url: 'c', image_url: 'd', cues: ['e'], weight_unit: 'kg' }
    const fill = mergeLibraryFields(target, { equipment: 'z' })
    expect(fill).toEqual({})
  })
})

describe('consolidateSessionExercises', () => {
  it('changed=false when the session has neither name (no-op, caller skips write)', () => {
    const result = consolidateSessionExercises([{ name: 'Other', sets: [] }], 'A', 'B')
    expect(result.changed).toBe(false)
    expect(result.consolidated).toBe(false)
  })

  it('plain rename when only source is present', () => {
    const result = consolidateSessionExercises([{ name: 'A', sets: [{ reps: 5 }] }], 'A', 'B')
    expect(result.changed).toBe(true)
    expect(result.consolidated).toBe(false)
    expect(result.exercises).toEqual([{ name: 'B', sets: [{ reps: 5 }] }])
  })

  it('consolidates when both are present: sets = target-then-source, single entry at target position, no leftover second entry', () => {
    const result = consolidateSessionExercises(
      [
        { name: 'B', sets: [{ reps: 8 }] },
        { name: 'A', sets: [{ reps: 6 }] },
      ],
      'A',
      'B'
    )
    expect(result.changed).toBe(true)
    expect(result.consolidated).toBe(true)
    expect(result.exercises).toEqual([{ name: 'B', sets: [{ reps: 8 }, { reps: 6 }] }])
  })

  it('consolidation preserves sibling exercises untouched', () => {
    const result = consolidateSessionExercises(
      [
        { name: 'A', sets: [{ reps: 1 }] },
        { name: 'Sibling', sets: [{ reps: 9 }] },
        { name: 'B', sets: [{ reps: 2 }] },
      ],
      'A',
      'B'
    )
    expect(result.exercises).toEqual([
      { name: 'Sibling', sets: [{ reps: 9 }] },
      { name: 'B', sets: [{ reps: 2 }, { reps: 1 }] },
    ])
  })
})

describe('replaceNameDedup', () => {
  it('returns the input unchanged when source is absent', () => {
    const list = ['X', 'Y']
    expect(replaceNameDedup(list, 'A', 'B')).toBe(list)
  })

  it('returns non-array input as-is', () => {
    expect(replaceNameDedup(undefined, 'A', 'B')).toBeUndefined()
  })

  it('replaces source with target, preserving order', () => {
    expect(replaceNameDedup(['X', 'A', 'Y'], 'A', 'B')).toEqual(['X', 'B', 'Y'])
  })

  it('dedupes when target was already present (both names collapse to one entry)', () => {
    expect(replaceNameDedup(['A', 'B', 'C'], 'A', 'B')).toEqual(['B', 'C'])
  })
})

describe('renameInProgramDays', () => {
  it('changed=false and days reference-equal-in-content when no day matches', () => {
    const days = [{ day: 1, exercises: [{ name: 'X' }] }]
    const result = renameInProgramDays(days, 'A', 'B')
    expect(result.changed).toBe(false)
    expect(result.days).toEqual(days)
  })

  it('renames only the matching day, leaves an untouched sibling day exactly as-is (no phantom "changed" bleed across days)', () => {
    const days = [
      { day: 1, exercises: [{ name: 'X' }] }, // no match — must stay untouched
      { day: 2, exercises: [{ name: 'A', target_reps: '8-10' }] }, // match
    ]
    const result = renameInProgramDays(days, 'A', 'B')
    expect(result.changed).toBe(true)
    expect(result.days[0]).toBe(days[0]) // untouched day returned by reference, not cloned
    expect(result.days[1].exercises[0]).toEqual({ name: 'B', target_reps: '8-10' })
  })

  it('renames a match that occurs in the FIRST day too (regression: a shared "changed" flag would wrongly clone every later day)', () => {
    const days = [
      { day: 1, exercises: [{ name: 'A' }] }, // match, first
      { day: 2, exercises: [{ name: 'X' }] }, // no match, later — must stay untouched
    ]
    const result = renameInProgramDays(days, 'A', 'B')
    expect(result.days[0].exercises[0].name).toBe('B')
    expect(result.days[1]).toBe(days[1]) // still untouched, not spuriously cloned
  })
})

export {}
