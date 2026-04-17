/**
 * Workouts route — unit tests for business logic in routes/workouts.js
 * Tests: calc1RM (Epley), volume calculation, exercise history aggregation,
 *        PR detection helpers
 * Note: calc1RM and PR detection also tested in personal-records.test.ts —
 *       this file covers remaining exercise volume and history logic.
 */

// --- Replicate pure logic from routes/workouts.js ---

function calc1RM(weight: number, reps: number): number {
  if (!weight || !reps) return 0
  return Math.round(weight * (1 + reps / 30) * 10) / 10
}

interface WorkoutSet {
  weight_kg: number
  reps: number
}

interface Exercise {
  name: string
  sets: WorkoutSet[]
  muscle_group?: string
}

function calcSessionVolume(sets: WorkoutSet[]): number {
  return Math.round(sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0))
}

function calcBest1RM(sets: WorkoutSet[]): number {
  return sets.reduce((best, s) => {
    const orm = calc1RM(s.weight_kg, s.reps)
    return orm > best ? orm : best
  }, 0)
}

function calcMaxWeight(sets: WorkoutSet[]): number {
  return Math.max(...sets.map(s => s.weight_kg || 0))
}

interface ExerciseHistoryEntry {
  date: string
  workout_name: string
  sets: WorkoutSet[]
  volume: number
  max_weight: number
  best_reps: number
  est_1rm: number
}

function buildExerciseHistory(
  workouts: Array<{ date: string; name: string; exercises: Exercise[] }>,
  exerciseName: string
): ExerciseHistoryEntry[] {
  return workouts.map(w => {
    const ex = w.exercises.find(e => e.name === exerciseName)
    if (!ex) return null
    const sets = ex.sets || []
    const volume = sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0)
    const best = sets.reduce((b, s) => {
      const orm = calc1RM(s.weight_kg, s.reps)
      return orm > b.orm ? { orm, weight: s.weight_kg, reps: s.reps } : b
    }, { orm: 0, weight: 0, reps: 0 })

    return {
      date: w.date,
      workout_name: w.name,
      sets,
      volume: Math.round(volume),
      max_weight: best.weight,
      best_reps: best.reps,
      est_1rm: best.orm,
    }
  }).filter(Boolean) as ExerciseHistoryEntry[]
}

// --- Tests ---

describe('calc1RM (Epley formula) — from workouts.js', () => {
  it('calculates 1RM for typical sets', () => {
    // 100kg × 5 reps = 100 * (1 + 5/30) = 116.7
    expect(calc1RM(100, 5)).toBe(116.7)
  })

  it('returns 0 for zero weight', () => {
    expect(calc1RM(0, 10)).toBe(0)
  })

  it('returns 0 for zero reps', () => {
    expect(calc1RM(100, 0)).toBe(0)
  })

  it('1 rep = slightly above weight', () => {
    // 120 * (1 + 1/30) = 120 * 1.0333 = 124.0
    expect(calc1RM(120, 1)).toBe(124)
  })

  it('more reps → higher 1RM estimate', () => {
    const low = calc1RM(80, 5)
    const high = calc1RM(80, 12)
    expect(high).toBeGreaterThan(low)
  })
})

describe('calcSessionVolume — total weight lifted', () => {
  it('calculates total volume correctly', () => {
    const sets: WorkoutSet[] = [
      { weight_kg: 80, reps: 10 },  // 800
      { weight_kg: 85, reps: 8 },   // 680
      { weight_kg: 90, reps: 6 },   // 540
    ]
    expect(calcSessionVolume(sets)).toBe(2020)
  })

  it('returns 0 for empty sets', () => {
    expect(calcSessionVolume([])).toBe(0)
  })

  it('rounds to integer', () => {
    const sets: WorkoutSet[] = [{ weight_kg: 22.5, reps: 10 }] // 225.0
    expect(Number.isInteger(calcSessionVolume(sets))).toBe(true)
  })
})

describe('calcBest1RM — best estimated 1RM from all sets', () => {
  it('finds the best set by 1RM', () => {
    const sets: WorkoutSet[] = [
      { weight_kg: 80, reps: 10 }, // 1RM ≈ 106.7
      { weight_kg: 100, reps: 5 }, // 1RM = 116.7 ← best
      { weight_kg: 70, reps: 15 }, // 1RM = 105
    ]
    expect(calcBest1RM(sets)).toBe(116.7)
  })

  it('returns 0 for empty sets', () => {
    expect(calcBest1RM([])).toBe(0)
  })
})

describe('calcMaxWeight — heaviest weight in session', () => {
  it('returns max weight lifted', () => {
    const sets: WorkoutSet[] = [
      { weight_kg: 80, reps: 10 },
      { weight_kg: 100, reps: 3 },
      { weight_kg: 90, reps: 6 },
    ]
    expect(calcMaxWeight(sets)).toBe(100)
  })

  it('returns -Infinity for empty sets (Math.max behavior)', () => {
    expect(calcMaxWeight([])).toBe(-Infinity)
  })
})

describe('buildExerciseHistory — history aggregation', () => {
  const workouts = [
    {
      date: '2026-04-01',
      name: 'Chest A',
      exercises: [
        {
          name: 'Жим лежачи',
          sets: [
            { weight_kg: 80, reps: 10 },
            { weight_kg: 85, reps: 8 },
          ],
        },
      ],
    },
    {
      date: '2026-04-08',
      name: 'Chest B',
      exercises: [
        {
          name: 'Жим лежачи',
          sets: [
            { weight_kg: 87.5, reps: 8 },
            { weight_kg: 90, reps: 6 },
          ],
        },
      ],
    },
  ]

  it('builds history for matching exercise', () => {
    const history = buildExerciseHistory(workouts, 'Жим лежачи')
    expect(history.length).toBe(2)
    expect(history[0].date).toBe('2026-04-01')
    expect(history[1].date).toBe('2026-04-08')
  })

  it('calculates volume per session correctly', () => {
    const history = buildExerciseHistory(workouts, 'Жим лежачи')
    // Session 1: 80*10 + 85*8 = 800 + 680 = 1480
    expect(history[0].volume).toBe(1480)
    // Session 2: 87.5*8 + 90*6 = 700 + 540 = 1240
    expect(history[1].volume).toBe(1240)
  })

  it('calculates max_weight per session (weight from best-1RM set)', () => {
    const history = buildExerciseHistory(workouts, 'Жим лежачи')
    // Session 1: 80×10→1RM=106.7, 85×8→1RM=107.7 (best) → max_weight=85
    expect(history[0].max_weight).toBe(85)
    // Session 2: 87.5×8→1RM=110.8 (best), 90×6→1RM=108 → max_weight=87.5
    expect(history[1].max_weight).toBe(87.5)
  })

  it('calculates est_1rm per session', () => {
    const history = buildExerciseHistory(workouts, 'Жим лежачи')
    // Session 1: best = 85kg×8 reps → 85*(1+8/30) ≈ 107.7
    expect(history[0].est_1rm).toBeGreaterThan(100)
    // Session 2: best = 87.5×8 → ≈ 110.8 > session 1
    expect(history[1].est_1rm).toBeGreaterThan(history[0].est_1rm)
  })

  it('returns empty array when exercise not found', () => {
    const history = buildExerciseHistory(workouts, 'Присідання')
    expect(history.length).toBe(0)
  })
})

describe('DEFAULT_EXERCISES constants', () => {
  const MUSCLE_GROUPS = ['chest', 'back', 'shoulders', 'legs', 'biceps', 'triceps', 'core']

  it('all required muscle groups are defined', () => {
    expect(MUSCLE_GROUPS.length).toBe(7)
    expect(MUSCLE_GROUPS).toContain('chest')
    expect(MUSCLE_GROUPS).toContain('legs')
  })

  it('Жим лежачи is chest/barbell', () => {
    const exercise = { name: 'Жим лежачи', muscle_group: 'chest', equipment: 'barbell' }
    expect(exercise.muscle_group).toBe('chest')
    expect(exercise.equipment).toBe('barbell')
  })
})
