/**
 * Unit tests for lib/training-program.js — the shared logic routes/training_program.js
 * calls (task #1290, Ф1 MVP). No mirror-reimplementation here (#953/#966/#988 lesson):
 * every assertion below calls the SAME functions/constants the route imports.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  formatDateKyiv,
  getKyivIsoWeekday,
  daysBetweenDateStrings,
  computeCurrentWeek,
  phaseForWeek,
  resolveScheduledDayKey,
  countBarbellExercises,
  EXERCISE_EQUIPMENT_MAP,
  NEW_EXERCISES_TO_SEED,
  SEED_TRAINING_PROGRAM,
} = require('../../lib/training-program')

import { KYIV_MIDNIGHT_BOUNDARY_CASE } from './utils/kyivDayBounds'

describe('formatDateKyiv / getKyivIsoWeekday — Kyiv-day boundary (real fixture, not invented)', () => {
  it('rolls the UTC instant just before Kyiv midnight into the NEXT Kyiv day', () => {
    const date = new Date(KYIV_MIDNIGHT_BOUNDARY_CASE.utcInstant)
    expect(formatDateKyiv(date)).toBe(KYIV_MIDNIGHT_BOUNDARY_CASE.kyivDay)
  })

  it('half past the boundary is still the new Kyiv day', () => {
    const date = new Date(KYIV_MIDNIGHT_BOUNDARY_CASE.utcInstantHalfPastMidnight)
    expect(formatDateKyiv(date)).toBe(KYIV_MIDNIGHT_BOUNDARY_CASE.kyivDay)
  })

  it('2026-09-09 (a real Wednesday) resolves to ISO weekday 3', () => {
    // Kyiv noon, safely inside the day regardless of UTC offset.
    const date = new Date('2026-09-09T12:00:00.000Z')
    expect(getKyivIsoWeekday(date)).toBe(3)
  })

  it('2026-09-11 (Friday) resolves to ISO weekday 5', () => {
    const date = new Date('2026-09-11T12:00:00.000Z')
    expect(getKyivIsoWeekday(date)).toBe(5)
  })
})

describe('daysBetweenDateStrings', () => {
  it('same day = 0', () => expect(daysBetweenDateStrings('2026-09-09', '2026-09-09')).toBe(0))
  it('one week forward = 7', () => expect(daysBetweenDateStrings('2026-09-09', '2026-09-16')).toBe(7))
  it('negative when to < from', () => expect(daysBetweenDateStrings('2026-09-09', '2026-09-02')).toBe(-7))
})

describe('computeCurrentWeek — wave rollover from start_date (acceptance criterion, task #1290)', () => {
  const START = '2026-09-09' // wave day 0

  it('week 1 on the start date itself', () => {
    expect(computeCurrentWeek(START, 4, '2026-09-09')).toBe(1)
  })

  it('still week 1 through day 6', () => {
    expect(computeCurrentWeek(START, 4, '2026-09-15')).toBe(1)
  })

  it('rolls to week 2 on day 7', () => {
    expect(computeCurrentWeek(START, 4, '2026-09-16')).toBe(2)
  })

  it('rolls to week 4 (Deload) on day 21', () => {
    expect(computeCurrentWeek(START, 4, '2026-09-30')).toBe(4)
  })

  it('wraps back to week 1 after the full 4-week wave (day 28)', () => {
    expect(computeCurrentWeek(START, 4, '2026-10-07')).toBe(1)
  })

  it('wraps to week 2 of the SECOND wave (day 35)', () => {
    expect(computeCurrentWeek(START, 4, '2026-10-14')).toBe(2)
  })

  it('defensive default: missing start_date returns week 1, does not throw', () => {
    expect(computeCurrentWeek(undefined as any, 4, '2026-09-09')).toBe(1)
  })

  it('defensive default: a future start_date returns week 1 (program not started yet)', () => {
    expect(computeCurrentWeek('2099-01-01', 4, '2026-09-09')).toBe(1)
  })
})

describe('phaseForWeek', () => {
  const PHASES = ['База', 'Білд', 'Пік', 'Deload']
  it('maps week 1 → База, week 4 → Deload', () => {
    expect(phaseForWeek(PHASES, 1)).toBe('База')
    expect(phaseForWeek(PHASES, 4)).toBe('Deload')
  })
  it('wraps week 5 (2nd wave, week 1) → База', () => {
    expect(phaseForWeek(PHASES, 5)).toBe('База')
  })
  it('empty/missing phases → null, never throws', () => {
    expect(phaseForWeek([], 1)).toBeNull()
    expect(phaseForWeek(undefined as any, 1)).toBeNull()
  })
})

describe('resolveScheduledDayKey — Mon/Wed/Fri 3x split (seed schedule)', () => {
  const SCHEDULE = SEED_TRAINING_PROGRAM.schedule // { A:[1], B:[3], home:[5] }

  it('Monday (1) → A', () => expect(resolveScheduledDayKey(SCHEDULE, 1)).toBe('A'))
  it('Wednesday (3) → B', () => expect(resolveScheduledDayKey(SCHEDULE, 3)).toBe('B'))
  it('Friday (5) → home', () => expect(resolveScheduledDayKey(SCHEDULE, 5)).toBe('home'))
  it('Tuesday (2), Thursday (4), weekend (6,7) → null (rest day)', () => {
    for (const wd of [2, 4, 6, 7]) {
      expect(resolveScheduledDayKey(SCHEDULE, wd)).toBeNull()
    }
  })
  it('missing schedule → null, does not throw', () => {
    expect(resolveScheduledDayKey(undefined as any, 1)).toBeNull()
  })
})

describe('SEED_TRAINING_PROGRAM — owner wrist constraint (acceptance criterion, task #1290)', () => {
  it('has zero barbell exercises anywhere in the seeded plan', () => {
    expect(countBarbellExercises(SEED_TRAINING_PROGRAM)).toBe(0)
  })

  it('every exercise name used in the plan has a KNOWN equipment entry (no silent typo)', () => {
    // Guards the guard: an unmapped name would read `undefined !== 'barbell'` as a false
    // pass in the test above, exactly the class of bug flagged by the RED-FIRST rule.
    const unmapped: string[] = []
    for (const day of SEED_TRAINING_PROGRAM.days) {
      for (const ex of day.exercises) {
        if (!(ex.name in EXERCISE_EQUIPMENT_MAP)) unmapped.push(`${day.key}/${ex.name}`)
      }
    }
    expect(unmapped).toEqual([])
  })

  it('every day has at least one exercise, and A/B/home keys are all present', () => {
    const keys = SEED_TRAINING_PROGRAM.days.map((d: any) => d.key)
    expect(keys.sort()).toEqual(['A', 'B', 'home'])
    for (const day of SEED_TRAINING_PROGRAM.days) {
      expect(day.exercises.length).toBeGreaterThan(0)
    }
  })

  it('pull-up target_reps is the max-effort protocol, not a numeric range (owner requirement)', () => {
    const home = SEED_TRAINING_PROGRAM.days.find((d: any) => d.key === 'home')
    const pullups = home.exercises.find((e: any) => e.name === 'Підтягування')
    expect(pullups.target_reps).toBe('макс')
  })
})

describe('NEW_EXERCISES_TO_SEED — the 5 missing library entries', () => {
  it('has exactly 5 entries (KB #2542 list minus "розводки", already in the library)', () => {
    expect(NEW_EXERCISES_TO_SEED.length).toBe(5)
  })

  it('none of them are barbell equipment', () => {
    for (const e of NEW_EXERCISES_TO_SEED) {
      expect(e.equipment).not.toBe('barbell')
    }
  })

  it('every seeded exercise name is actually referenced somewhere in the plan (no orphan seed)', () => {
    const usedNames = new Set<string>()
    for (const day of SEED_TRAINING_PROGRAM.days) {
      for (const ex of day.exercises) usedNames.add(ex.name)
    }
    for (const e of NEW_EXERCISES_TO_SEED) {
      expect(usedNames.has(e.name)).toBe(true)
    }
  })
})
