/**
 * Unit tests for lib/readiness.js — task #1292 (Ф3, readiness badge). Truth table:
 * 3 recovery zones × streak × exercise-trend signal, plus the two guards the
 * owner explicitly called out (2-consecutive-yellow/red-day override to
 * base_only; no-recovery-today -> data_fresh:false, never a defaulted verdict).
 * Pure-logic tests, no DB — same pattern as exercise_trends.test.ts (#1417).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  YELLOW_RED_STREAK_FOR_BASE_ONLY,
  computeYellowRedStreak,
  stalledExercisesForToday,
  combineLevel,
  buildReadiness,
} = require('../../lib/readiness')

function trendExercise(name: string, status: string, extra: Record<string, unknown> = {}) {
  return { name, status, sessions_count: 3, delta_1rm_pct: -10, prev: { date: '2026-09-01' }, last: { date: '2026-09-15' }, ...extra }
}

describe('YELLOW_RED_STREAK_FOR_BASE_ONLY constant', () => {
  it('is 2 — owner rule, 09.09', () => {
    expect(YELLOW_RED_STREAK_FOR_BASE_ONLY).toBe(2)
  })
})

describe('computeYellowRedStreak', () => {
  it('today green -> streak 0, even with a yellow/red history before it', () => {
    const history = [
      { date: '2026-09-17', recovery_score: 40 },
      { date: '2026-09-18', recovery_score: 40 },
      { date: '2026-09-19', recovery_score: 80 },
    ]
    expect(computeYellowRedStreak(history, '2026-09-19')).toBe(0)
  })

  it('today yellow, yesterday green -> streak 1 (not enough for override)', () => {
    const history = [
      { date: '2026-09-18', recovery_score: 80 },
      { date: '2026-09-19', recovery_score: 50 },
    ]
    expect(computeYellowRedStreak(history, '2026-09-19')).toBe(1)
  })

  it('today yellow, yesterday yellow -> streak 2', () => {
    const history = [
      { date: '2026-09-18', recovery_score: 40 },
      { date: '2026-09-19', recovery_score: 50 },
    ]
    expect(computeYellowRedStreak(history, '2026-09-19')).toBe(2)
  })

  it('today red, yesterday yellow -> streak 2 (mixed yellow/red still counts)', () => {
    const history = [
      { date: '2026-09-18', recovery_score: 50 },
      { date: '2026-09-19', recovery_score: 20 },
    ]
    expect(computeYellowRedStreak(history, '2026-09-19')).toBe(2)
  })

  it('a missing day (data gap) breaks the streak — not silently treated as yellow/red', () => {
    const history = [
      { date: '2026-09-17', recovery_score: 40 },
      // 2026-09-18 missing
      { date: '2026-09-19', recovery_score: 50 },
    ]
    expect(computeYellowRedStreak(history, '2026-09-19')).toBe(1)
  })

  it('no doc for todayStr -> streak 0', () => {
    expect(computeYellowRedStreak([{ date: '2026-09-18', recovery_score: 40 }], '2026-09-19')).toBe(0)
  })
})

describe('stalledExercisesForToday', () => {
  const trends = {
    exercises: [
      trendExercise('Жим гантелей лежачи', 'down'),
      trendExercise('Тяга гантелі', 'flat'),
      trendExercise('Жим ногами', 'up'),
      trendExercise('Планка', 'insufficient'),
    ],
  }

  it('down/flat count as stalled; up does not; insufficient does not', () => {
    const todayExercises = [{ name: 'Жим гантелей лежачи' }, { name: 'Тяга гантелі' }, { name: 'Жим ногами' }]
    const { stalled, trend_coverage } = stalledExercisesForToday(trends, todayExercises)
    expect(stalled.map((s: any) => s.name).sort()).toEqual(['Жим гантелей лежачи', 'Тяга гантелі'].sort())
    expect(trend_coverage.evaluated).toBe(3)
    expect(trend_coverage.insufficient).toBe(0)
  })

  it('insufficient status -> NOT stalled, counted separately in trend_coverage', () => {
    const { stalled, trend_coverage } = stalledExercisesForToday(trends, [{ name: 'Планка' }])
    expect(stalled).toEqual([])
    expect(trend_coverage.insufficient).toBe(1)
    expect(trend_coverage.evaluated).toBe(0)
  })

  it('exercise never logged at all (absent from trends) -> treated as insufficient, not stalled', () => {
    const { stalled, trend_coverage } = stalledExercisesForToday(trends, [{ name: 'Нова вправа' }])
    expect(stalled).toEqual([])
    expect(trend_coverage.insufficient).toBe(1)
  })

  it('no program-day exercises (rest day) -> empty stalled, zero coverage', () => {
    const { stalled, trend_coverage } = stalledExercisesForToday(trends, [])
    expect(stalled).toEqual([])
    expect(trend_coverage).toEqual({ evaluated: 0, insufficient: 0 })
  })
})

describe('combineLevel — LOWER of the two signals wins (owner rule)', () => {
  it('as_planned + no stalled -> as_planned', () => {
    expect(combineLevel('as_planned', 0)).toBe('as_planned')
  })
  it('as_planned + stalled present -> hold (signal B pulls it down)', () => {
    expect(combineLevel('as_planned', 1)).toBe('hold')
  })
  it('hold + no stalled -> hold (signal A already lower)', () => {
    expect(combineLevel('hold', 0)).toBe('hold')
  })
  it('base_only + no stalled -> base_only (signal A already lowest)', () => {
    expect(combineLevel('base_only', 0)).toBe('base_only')
  })
})

describe('buildReadiness — truth table (zone x streak x trend)', () => {
  const noTrends = { exercises: [] }

  it('🟢 hard + no stalled -> as_planned', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 78 },
      recoveryHistory: [{ date: '2026-09-19', recovery_score: 78 }],
      exerciseTrends: noTrends,
      todayExercises: [],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('as_planned')
    expect(r.recovery_zone).toBe('hard')
    expect(r.data_fresh).toBe(true)
    expect(r.reason_text).toContain('план як є')
  })

  it('🟢 hard + stalled exercise -> hold (owner requirement: "якщо результати падають навіть при хорошому recovery")', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 78 },
      recoveryHistory: [{ date: '2026-09-19', recovery_score: 78 }],
      exerciseTrends: { exercises: [trendExercise('Жим гантелей лежачи', 'down', { sessions_count: 3 })] },
      todayExercises: [{ name: 'Жим гантелей лежачи' }],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('hold')
    expect(r.reason_text).toContain('тримай обсяг')
    expect(r.reason_text).toContain('recovery 78 🟢')
    expect(r.reason_text).toContain('Жим гантелей лежачи стоїть 3 сесії')
  })

  it('🟡 moderate, streak 1, progress -> hold (moderate itself caps at hold)', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 50 },
      recoveryHistory: [
        { date: '2026-09-18', recovery_score: 80 },
        { date: '2026-09-19', recovery_score: 50 },
      ],
      exerciseTrends: { exercises: [trendExercise('Жим гантелей лежачи', 'up')] },
      todayExercises: [{ name: 'Жим гантелей лежачи' }],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('hold')
    expect(r.yellow_red_streak_days).toBe(1)
  })

  it('🟡 moderate, 2 days poспіль -> base_only, even with progress on signal B', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 50 },
      recoveryHistory: [
        { date: '2026-09-18', recovery_score: 40 },
        { date: '2026-09-19', recovery_score: 50 },
      ],
      exerciseTrends: { exercises: [trendExercise('Жим гантелей лежачи', 'up')] },
      todayExercises: [{ name: 'Жим гантелей лежачи' }],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('base_only')
    expect(r.yellow_red_streak_days).toBe(2)
    expect(r.reason_text).toContain('2-й день поспіль')
  })

  it('🔴 light (<34) -> base_only on a SINGLE day, no streak needed', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 20 },
      recoveryHistory: [{ date: '2026-09-19', recovery_score: 20 }],
      exerciseTrends: noTrends,
      todayExercises: [],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('base_only')
    expect(r.yellow_red_streak_days).toBe(1)
  })

  it('no recovery today -> data_fresh:false, level:null, NEVER a defaulted (?? 65) verdict', () => {
    const r = buildReadiness({
      recoveryToday: null,
      recoveryHistory: [{ date: '2026-09-18', recovery_score: 78 }],
      exerciseTrends: noTrends,
      todayExercises: [],
      todayStr: '2026-09-19',
    })
    expect(r.data_fresh).toBe(false)
    expect(r.level).toBeNull()
    expect(r.recovery_score).toBeNull()
    expect(r.recovery_zone).toBeNull()
    expect(r.reason_text).toContain('немає свіжих даних WHOOP')
  })

  it('rest day (no program-day exercises) -> signal B contributes nothing, level driven by recovery alone', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 78 },
      recoveryHistory: [{ date: '2026-09-19', recovery_score: 78 }],
      exerciseTrends: { exercises: [trendExercise('Жим гантелей лежачи', 'down')] }, // exists but not today's program day
      todayExercises: [],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('as_planned')
    expect(r.stalled_exercises).toEqual([])
  })

  it('insufficient-only program day (new exercises, no history) -> as_planned, not falsely flagged stalled', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 78 },
      recoveryHistory: [{ date: '2026-09-19', recovery_score: 78 }],
      exerciseTrends: { exercises: [trendExercise('Нова вправа', 'insufficient')] },
      todayExercises: [{ name: 'Нова вправа' }],
      todayStr: '2026-09-19',
    })
    expect(r.level).toBe('as_planned')
    expect(r.trend_coverage.insufficient).toBe(1)
    expect(r.stalled_exercises).toEqual([])
  })

  it('sleep_window passes through unchanged when provided', () => {
    const r = buildReadiness({
      recoveryToday: { date: '2026-09-19', recovery_score: 78 },
      recoveryHistory: [{ date: '2026-09-19', recovery_score: 78 }],
      exerciseTrends: noTrends,
      todayExercises: [],
      todayStr: '2026-09-19',
      sleepWindow: { start: '2026-09-18T21:08:41.440Z', end: '2026-09-19T04:54:31.740Z' },
    })
    expect(r.sleep_window).toEqual({ start: '2026-09-18T21:08:41.440Z', end: '2026-09-19T04:54:31.740Z' })
  })
})

export {}
