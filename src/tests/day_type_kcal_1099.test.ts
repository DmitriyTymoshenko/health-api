/**
 * Unit tests for lib/day-type-kcal.js (#1099) — the weekday-recurring-pattern
 * analog that makes `resolveDayTargets`'s kcal basis day-type-aware.
 *
 * See lib/day-type-kcal.js's own doc comment for why the analog cohort is
 * "same ISO weekday" rather than "same sport set" (measured 2026-09-21:
 * `activity_plans` is empty, `training_programs` only covers 3 gym days, and
 * exact sport-combo groups mostly have <5 analogs in 90 days, while every
 * weekday clears 5+).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  MIN_ANALOG_DAYS,
  MIN_FULL_DAY_KCAL,
  isoWeekdayFromDateString,
  resolveWeekdayAnalogFullDayKcal,
  resolveDayTypeAwareKcalBasis,
} = require('../../lib/day-type-kcal')

type Doc = Record<string, any>

function makeDb(whoopCycles: Doc[]) {
  return {
    collection(name: string) {
      if (name !== 'whoop_cycles') throw new Error(`unexpected collection in #1099 day-type test: ${name}`)
      return {
        find(filter: Doc) {
          let list = whoopCycles.slice()
          const { $gte, $lt } = filter.date || {}
          if ($gte) list = list.filter((c) => c.date >= $gte)
          if ($lt) list = list.filter((c) => c.date < $lt)
          return { toArray: async () => list }
        },
      }
    },
  }
}

/** Build a run of same-weekday closed cycles, one every 7 days back from `fromDate` (exclusive). */
function sameWeekdayCycles(fromDate: string, count: number, caloriesBurned: number): Doc[] {
  const out: Doc[] = []
  for (let i = 1; i <= count; i++) {
    // 7*i days back = same ISO weekday as fromDate
    const [y, m, d] = fromDate.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
    date.setUTCDate(date.getUTCDate() - 7 * i)
    out.push({ date: date.toISOString().slice(0, 10), calories_burned: caloriesBurned, end: new Date() })
  }
  return out
}

describe('isoWeekdayFromDateString (#1099)', () => {
  it('matches known ISO weekdays regardless of local process timezone', () => {
    expect(isoWeekdayFromDateString('2026-09-21')).toBe(1) // Monday
    expect(isoWeekdayFromDateString('2026-09-23')).toBe(3) // Wednesday
    expect(isoWeekdayFromDateString('2026-09-27')).toBe(7) // Sunday
  })
})

describe('resolveWeekdayAnalogFullDayKcal (#1099)', () => {
  const TARGET_DATE = '2026-09-23' // Wednesday

  it('returns null when fewer than MIN_ANALOG_DAYS same-weekday closed cycles exist', async () => {
    const cycles = sameWeekdayCycles(TARGET_DATE, MIN_ANALOG_DAYS - 1, 2800)
    const db = makeDb(cycles)
    const result = await resolveWeekdayAnalogFullDayKcal(db, TARGET_DATE)
    expect(result).toBeNull()
  })

  it('averages exactly the same-weekday closed cycles once the floor is met', async () => {
    const cycles = sameWeekdayCycles(TARGET_DATE, MIN_ANALOG_DAYS, 2800)
    const db = makeDb(cycles)
    const result = await resolveWeekdayAnalogFullDayKcal(db, TARGET_DATE)
    expect(result).toBe(2800)
  })

  it('excludes a still-open cycle (no `end`) even if it matches the weekday', async () => {
    const cycles = sameWeekdayCycles(TARGET_DATE, MIN_ANALOG_DAYS, 2800)
    // Add one MORE same-weekday analog that is still open — must not count.
    cycles.push({ date: '2026-08-05', calories_burned: 9999, end: null })
    const db = makeDb(cycles)
    const result = await resolveWeekdayAnalogFullDayKcal(db, TARGET_DATE)
    expect(result).toBe(2800) // unaffected by the 9999 open-cycle outlier
  })

  it('never reads the target date itself, even if (hypothetically) present in the window', async () => {
    const cycles = sameWeekdayCycles(TARGET_DATE, MIN_ANALOG_DAYS, 2800)
    // A record dated exactly TARGET_DATE with an absurd value — if this leaked in,
    // the average would move far off 2800.
    cycles.push({ date: TARGET_DATE, calories_burned: 50, end: new Date() })
    const db = makeDb(cycles)
    const result = await resolveWeekdayAnalogFullDayKcal(db, TARGET_DATE)
    expect(result).toBe(2800)
  })

  it('ignores a different weekday even with plenty of closed analogs', async () => {
    // Tuesday cycles only, target is Wednesday.
    const cycles: Doc[] = []
    for (let i = 1; i <= 10; i++) {
      const [y, m, d] = TARGET_DATE.split('-').map(Number)
      const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
      date.setUTCDate(date.getUTCDate() - 7 * i - 1) // one day off = Tuesday, not Wednesday
      cycles.push({ date: date.toISOString().slice(0, 10), calories_burned: 5000, end: new Date() })
    }
    const db = makeDb(cycles)
    const result = await resolveWeekdayAnalogFullDayKcal(db, TARGET_DATE)
    expect(result).toBeNull()
  })
})

describe('resolveDayTypeAwareKcalBasis (#1099)', () => {
  const WEDNESDAY = '2026-09-23'
  const MONDAY = '2026-09-21'
  // tdee 2701, deficit 500 -> derived basis 2201 (same fixture as #1295's unified test)
  const PROFILE: Doc = { tdee_kcal: 2701, deficit_kcal: 500, primary_goal: 'weight_loss', daily_kcal_goal: null }

  it('an explicit daily_kcal_goal wins outright — the DB is never even queried', async () => {
    const db = {
      collection() {
        throw new Error('must not query the DB when daily_kcal_goal is an explicit override')
      },
    }
    const result = await resolveDayTypeAwareKcalBasis(db, { daily_kcal_goal: 1800 }, WEDNESDAY)
    expect(result).toBe(1800)
  })

  it('falls back to the plain derived basis when there are not enough analogs', async () => {
    const db = makeDb(sameWeekdayCycles(WEDNESDAY, MIN_ANALOG_DAYS - 1, 2800))
    const result = await resolveDayTypeAwareKcalBasis(db, PROFILE, WEDNESDAY)
    expect(result).toBe(2201) // stableDayKcalBasis(PROFILE), unchanged
  })

  it('bumps the basis on a high-burn weekday (analog 2800 - 500 deficit = 2300 > 2201)', async () => {
    const db = makeDb(sameWeekdayCycles(WEDNESDAY, MIN_ANALOG_DAYS + 2, 2800))
    const result = await resolveDayTypeAwareKcalBasis(db, PROFILE, WEDNESDAY)
    expect(result).toBe(2300)
    expect(result).toBeGreaterThan(2201) // the #1099 "day-type increment" itself
  })

  it('never DROPS the basis below the plain derived value on a low-burn weekday (increment >= 0)', async () => {
    // Monday analogs average well BELOW derived basis (2201) once the deficit is applied.
    const db = makeDb(sameWeekdayCycles(MONDAY, MIN_ANALOG_DAYS + 2, 2000))
    const result = await resolveDayTypeAwareKcalBasis(db, PROFILE, MONDAY)
    expect(result).toBe(2201) // max(2201, 2000-500=1500) -> floor wins, no reduction
  })

  it('is immune to a partial (still-open) cycle for the SAME date being requested (#1295 compatibility)', async () => {
    // The target date's own cycle is present but open (no `end`) — must be excluded
    // from the analog pool regardless (it also fails the "< date" filter).
    const cycles = sameWeekdayCycles(WEDNESDAY, MIN_ANALOG_DAYS, 2800)
    cycles.push({ date: WEDNESDAY, calories_burned: 1123, end: null }) // live partial burn, mid-day
    const db = makeDb(cycles)
    const result = await resolveDayTypeAwareKcalBasis(db, PROFILE, WEDNESDAY)
    expect(result).toBe(2300) // identical to the no-partial-cycle case above
  })

  it('applies the MIN_FULL_DAY_KCAL floor to the day-type basis itself', async () => {
    // Analog average is extremely low (would compute a day-type basis far below any
    // recorded full day) — the floor must still hold even before the max-with-derived step.
    const lowProfile: Doc = { tdee_kcal: 1200, deficit_kcal: 0, primary_goal: 'maintenance', daily_kcal_goal: null }
    const db = makeDb(sameWeekdayCycles(WEDNESDAY, MIN_ANALOG_DAYS + 2, 500))
    const result = await resolveDayTypeAwareKcalBasis(db, lowProfile, WEDNESDAY)
    expect(result).toBeGreaterThanOrEqual(MIN_FULL_DAY_KCAL)
  })
})

export {}
