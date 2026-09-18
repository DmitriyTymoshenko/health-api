/**
 * Unit tests for lib/exercise-trends.js — task #1417 (per-exercise progression
 * overview, up/flat/down). Pure-logic tests on synthetic workouts, no DB — same
 * pattern as exercise_progression.test.ts (#1291).
 *
 * A1 fixture below is the LIVE data Apex measured in triage (#1417 comment, 18.09
 * 12:16): "Жим гантелей лежачи", 3 sessions, est_1rm 54 -> 50 -> 38, expected
 * delta_1rm_pct=-24.0, status='down', streak_up:0, sessions_count:3.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DELTA_THRESHOLD_PCT,
  classifyDelta,
  computeStreakUp,
  buildExerciseTrends,
} = require('../../lib/exercise-trends')

type Set_ = { weight_kg?: number; reps?: number }
type Workout = { date: string; exercises: Array<{ name: string; sets: Set_[] }> }

function workout(date: string, exercises: Array<{ name: string; sets: Set_[] }>): Workout {
  return { date, exercises }
}

describe('classifyDelta — threshold and divide-by-zero guard', () => {
  it('threshold is 2.5%', () => {
    expect(DELTA_THRESHOLD_PCT).toBe(2.5)
  })
  it('> +2.5% -> up', () => {
    expect(classifyDelta(100, 103).status).toBe('up')
  })
  it('< -2.5% -> down', () => {
    expect(classifyDelta(100, 96).status).toBe('down')
  })
  it('within +-2.5% -> flat', () => {
    expect(classifyDelta(100, 101).status).toBe('flat')
    expect(classifyDelta(100, 99).status).toBe('flat')
  })
  it('prev===0 -> flat, delta_pct null, never NaN/Infinity', () => {
    const result = classifyDelta(0, 50)
    expect(result.status).toBe('flat')
    expect(result.delta_pct).toBeNull()
    expect(Number.isNaN(result.delta_pct)).toBe(false)
  })
})

describe('buildExerciseTrends — A1 live fixture ("Жим гантелей лежачи")', () => {
  const workouts = [
    workout('2026-03-26', [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 45, reps: 6 }] }]),
    workout('2026-03-31', [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 37.5, reps: 10 }] }]),
    workout('2026-09-17', [{ name: 'Жим гантелей лежачи', sets: [{ weight_kg: 30, reps: 8 }] }]),
  ]

  it('last=2026-09-17 (est_1rm 38), prev=2026-03-31 (est_1rm 50), delta -24.0%, status down, streak_up 0', () => {
    const result = buildExerciseTrends({ workouts, todayStr: '2026-09-18' })
    const ex = result.exercises.find((e: any) => e.name === 'Жим гантелей лежачи')
    expect(ex).toBeDefined()
    expect(ex.sessions_count).toBe(3)
    expect(ex.last.date).toBe('2026-09-17')
    expect(ex.last.est_1rm).toBe(38)
    expect(ex.prev.date).toBe('2026-03-31')
    expect(ex.prev.est_1rm).toBe(50)
    expect(ex.delta_1rm_pct).toBe(-24.0)
    expect(ex.status).toBe('down')
    expect(ex.streak_up).toBe(0)
    expect(ex.days_since_last).toBe(1) // 2026-09-17 -> 2026-09-18
  })

  it('generated_for echoes the supplied Kyiv today string', () => {
    const result = buildExerciseTrends({ workouts, todayStr: '2026-09-18' })
    expect(result.generated_for).toBe('2026-09-18')
  })
})

describe('buildExerciseTrends — insufficient data (1 session)', () => {
  it('single-session exercise -> status insufficient, prev null, streak_up 0, does NOT show as flat', () => {
    const workouts = [workout('2026-09-01', [{ name: 'Планка', sets: [{ reps: 45 }] }])]
    const result = buildExerciseTrends({ workouts, todayStr: '2026-09-18' })
    const ex = result.exercises[0]
    expect(ex.status).toBe('insufficient')
    expect(ex.sessions_count).toBe(1)
    expect(ex.prev).toBeNull()
    expect(ex.delta_1rm_pct).toBeNull()
    expect(ex.streak_up).toBe(0)
  })

  it('empty workouts -> 200-shape {exercises:[]}, not a crash', () => {
    const result = buildExerciseTrends({ workouts: [], todayStr: '2026-09-18' })
    expect(result.exercises).toEqual([])
  })
})

describe('buildExerciseTrends — bodyweight exercises rank by best_reps_set, not est_1rm', () => {
  it('two bodyweight sessions: reps 10 -> 13 (+30%) -> up, uses reps not weight', () => {
    const workouts = [
      workout('2026-09-01', [{ name: 'Підтягування', sets: [{ reps: 10 }] }]),
      workout('2026-09-08', [{ name: 'Підтягування', sets: [{ reps: 13 }] }]),
    ]
    const result = buildExerciseTrends({ workouts, todayStr: '2026-09-18' })
    const ex = result.exercises[0]
    expect(ex.last.best_set.reps).toBe(13)
    expect(ex.last.est_1rm).toBe(0) // bodyweight — calc1RM never fires on weight=0
    expect(ex.status).toBe('up')
    expect(ex.delta_1rm_pct).toBe(30)
  })
})

describe('computeStreakUp — trailing consecutive ups only', () => {
  it('3 ups in a row -> streak 3', () => {
    const metrics = [
      { weighted: true, est_1rm: 100 },
      { weighted: true, est_1rm: 105 },
      { weighted: true, est_1rm: 110 },
      { weighted: true, est_1rm: 116 },
    ]
    expect(computeStreakUp(metrics)).toBe(3)
  })
  it('up then flat breaks the streak — only trailing run counts', () => {
    const metrics = [
      { weighted: true, est_1rm: 100 },
      { weighted: true, est_1rm: 110 }, // up
      { weighted: true, est_1rm: 111 }, // flat -> breaks
      { weighted: true, est_1rm: 120 }, // up (trailing)
    ]
    expect(computeStreakUp(metrics)).toBe(1)
  })
})

describe('buildExerciseTrends — sort order down -> flat -> up -> insufficient, then last.date desc', () => {
  it('sorts mixed-status exercises correctly', () => {
    const workouts = [
      // down: 100 -> 90
      workout('2026-09-01', [{ name: 'A-down', sets: [{ weight_kg: 100, reps: 5 }] }]),
      workout('2026-09-10', [{ name: 'A-down', sets: [{ weight_kg: 90, reps: 5 }] }]),
      // flat: 100 -> 101
      workout('2026-09-01', [{ name: 'B-flat', sets: [{ weight_kg: 100, reps: 5 }] }]),
      workout('2026-09-05', [{ name: 'B-flat', sets: [{ weight_kg: 101, reps: 5 }] }]),
      // up: 100 -> 110, most recent last.date
      workout('2026-09-01', [{ name: 'C-up', sets: [{ weight_kg: 100, reps: 5 }] }]),
      workout('2026-09-15', [{ name: 'C-up', sets: [{ weight_kg: 110, reps: 5 }] }]),
      // insufficient: 1 session
      workout('2026-09-12', [{ name: 'D-insufficient', sets: [{ weight_kg: 50, reps: 5 }] }]),
    ]
    const result = buildExerciseTrends({ workouts, todayStr: '2026-09-18' })
    const names = result.exercises.map((e: any) => e.name)
    expect(names).toEqual(['A-down', 'B-flat', 'C-up', 'D-insufficient'])
  })
})

describe('buildExerciseTrends — window limits sessions considered per exercise', () => {
  it('window=2 only looks at the last 2 of 3 sessions (matches A1 default behavior here since it is already 3->2)', () => {
    const workouts = [
      workout('2026-01-01', [{ name: 'X', sets: [{ weight_kg: 200, reps: 5 }] }]), // would be down if included
      workout('2026-09-01', [{ name: 'X', sets: [{ weight_kg: 100, reps: 5 }] }]),
      workout('2026-09-10', [{ name: 'X', sets: [{ weight_kg: 110, reps: 5 }] }]),
    ]
    const result = buildExerciseTrends({ workouts, window: 2, todayStr: '2026-09-18' })
    const ex = result.exercises[0]
    expect(ex.sessions_count).toBe(2)
    expect(ex.prev.date).toBe('2026-09-01')
    expect(ex.status).toBe('up')
  })
})

describe('buildExerciseTrends — muscle_group resolved from libraryByName, exerciseKey grouping', () => {
  it('groups case-insensitively by exerciseKey and attaches muscle_group', () => {
    const workouts = [
      workout('2026-09-01', [{ name: 'Присідання', sets: [{ weight_kg: 80, reps: 5 }] }]),
      workout('2026-09-08', [{ name: 'Присідання', sets: [{ weight_kg: 85, reps: 5 }] }]),
    ]
    const libraryByName = new Map([['присідання', { name: 'Присідання', muscle_group: 'legs' }]])
    const result = buildExerciseTrends({ workouts, libraryByName, todayStr: '2026-09-18' })
    expect(result.exercises[0].muscle_group).toBe('legs')
  })

  it('unknown exercise (not in library) -> muscle_group null, does not throw', () => {
    const workouts = [workout('2026-09-01', [{ name: 'Невідома вправа', sets: [{ weight_kg: 10, reps: 5 }] }])]
    const result = buildExerciseTrends({ workouts, todayStr: '2026-09-18' })
    expect(result.exercises[0].muscle_group).toBeNull()
  })
})

export {}
