/**
 * Unit tests for lib/whoop-forecast-kcal.js (#1504) — the WHOOP-live-cycle forecast
 * layer that sits ABOVE #1099's day-type-average, which sits above #1295's stable
 * TDEE-deficit basis.
 *
 * See lib/whoop-forecast-kcal.js's own doc comment for the full design rationale
 * (why 1200 kcal reuses the pre-#1295 threshold, why TDEE/24 instead of an
 * average-so-far rate, why `cycle.start` is deliberately never used for day-boundary
 * math). This file proves: (a) each guard fires on the right input, (b) the planned-
 * workout addition matches the #1492 walking-exclusion convention, (c) the function
 * is CONTINUOUS across the "cycle just closed" transition — the exact property whose
 * ABSENCE was #1295's bug (a discrete 1444->2400 jump the instant a cycle closed).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  MIN_TRUSTED_PARTIAL_BURN_KCAL,
  kyivHoursSinceMidnight,
  resolvePlannedWorkoutAdditionKcal,
  resolveKcalBasisWithForecast,
} = require('../../lib/whoop-forecast-kcal')

type Doc = Record<string, any>

/** TODAY, in the SAME Kyiv-day convention lib/training-program.js::formatDateKyiv uses. */
const TODAY = '2026-09-25'
const YESTERDAY = '2026-09-24'

/** now = TODAY at the given Kyiv HH:MM, assuming the live +03:00 Kyiv offset (EEST,
 * confirmed against the real whoop_cycles doc's own `timezone_offset` field for this
 * date — see task #1504 closing comment). */
function kyivNow(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const utcHour = h - 3
  if (utcHour >= 0) return new Date(`${TODAY}T${String(utcHour).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`)
  // Kyiv time crosses back into the previous UTC day.
  return new Date(`${YESTERDAY}T${String(24 + utcHour).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`)
}

const PROFILE: Doc = {
  _type: 'profile',
  tdee_kcal: 2400, // -> hourly rate 100 exactly, easy hand-arithmetic
  deficit_kcal: 500,
  primary_goal: 'weight_loss',
}

function makeDb(opts: { whoopCycles?: Doc[]; activityPlans?: Doc[]; whoopWorkouts?: Doc[] } = {}) {
  const whoopCycles = opts.whoopCycles ?? []
  const activityPlans = opts.activityPlans ?? []
  const whoopWorkouts = opts.whoopWorkouts ?? []
  return {
    collection(name: string) {
      if (name === 'whoop_cycles') {
        return {
          findOne: async (filter: Doc) => whoopCycles.find((c) => c.date === filter.date) ?? null,
          find: (filter: Doc = {}) => ({
            toArray: async () => {
              const { $gte, $lt } = filter.date || {}
              return whoopCycles.filter((c) => (!$gte || c.date >= $gte) && (!$lt || c.date < $lt))
            },
          }),
        }
      }
      if (name === 'activity_plans') {
        return {
          find: (filter: Doc = {}) => ({
            toArray: async () =>
              activityPlans.filter(
                (p) => p.date === filter.date && (filter.done === undefined || p.done === filter.done)
              ),
          }),
        }
      }
      if (name === 'whoop_workouts') {
        return {
          find: (filter: Doc = {}) => ({
            toArray: async () => whoopWorkouts.filter((w) => w.date === filter.date),
          }),
        }
      }
      throw new Error(`unexpected collection in #1504 whoop-forecast test: ${name}`)
    },
  }
}

describe('kyivHoursSinceMidnight (#1504) — wall-clock only, never a WHOOP timestamp', () => {
  it('19:23:00 Kyiv -> ~19.383h', () => {
    expect(kyivHoursSinceMidnight(kyivNow('19:23'))).toBeCloseTo(19 + 23 / 60, 3)
  })
  it('00:00:00 Kyiv (the exact UTC instant that crosses local midnight) -> 0h', () => {
    // 21:00 UTC on 24.09 = 00:00 Kyiv on 25.09 (+03:00) — same instant computed by hand
    // rather than via kyivNow(), which anchors dates to TODAY-25.09 already.
    expect(kyivHoursSinceMidnight(new Date('2026-09-24T21:00:00.000Z'))).toBeCloseTo(0, 3)
  })
})

describe('resolvePlannedWorkoutAdditionKcal (#1504, Apex triage acceptance point 5)', () => {
  it('returns 0 when there is no undone plan for the date (the live-production case — activity_plans is empty)', async () => {
    const db = makeDb({ activityPlans: [] })
    expect(await resolvePlannedWorkoutAdditionKcal(db, TODAY)).toBe(0)
  })

  it('adds the planned calories when no real workout has happened yet today', async () => {
    const db = makeDb({
      activityPlans: [{ date: TODAY, done: false, calories_est: 300 }],
      whoopWorkouts: [],
    })
    expect(await resolvePlannedWorkoutAdditionKcal(db, TODAY)).toBe(300)
  })

  it('adds nothing once a REAL (non-walking) workout is already in the cycle — already counted, no double-add', async () => {
    const db = makeDb({
      activityPlans: [{ date: TODAY, done: false, calories_est: 300 }],
      whoopWorkouts: [{ date: TODAY, sport_name: 'boxing' }],
    })
    expect(await resolvePlannedWorkoutAdditionKcal(db, TODAY)).toBe(0)
  })

  it('a WALK does not count as "already done" (#1492 convention) — the planned addition still applies', async () => {
    const db = makeDb({
      activityPlans: [{ date: TODAY, done: false, calories_est: 300 }],
      whoopWorkouts: [{ date: TODAY, sport_name: 'walking' }],
    })
    expect(await resolvePlannedWorkoutAdditionKcal(db, TODAY)).toBe(300)
  })

  it('sums multiple undone plans for the same date', async () => {
    const db = makeDb({
      activityPlans: [
        { date: TODAY, done: false, calories_est: 200 },
        { date: TODAY, done: false, calories_est: 150 },
      ],
      whoopWorkouts: [],
    })
    expect(await resolvePlannedWorkoutAdditionKcal(db, TODAY)).toBe(350)
  })
})

describe('resolveKcalBasisWithForecast (#1504) — guard order', () => {
  it('an explicit daily_kcal_goal override wins outright — does not touch the DB at all', async () => {
    const throwingDb = { collection() { throw new Error('must not query the DB when daily_kcal_goal is set') } }
    const profile = { ...PROFILE, daily_kcal_goal: 1900 }
    const result = await resolveKcalBasisWithForecast(throwingDb as any, profile, TODAY)
    expect(result).toEqual({ kcal: 1900, basis: 'day_type_avg' })
  })

  it('no whoop_cycles doc for the date -> falls back to day_type_avg (delegates to the real #1099 resolver)', async () => {
    // 5 same-weekday closed analogs strictly before TODAY (7*n days back, so each one
    // shares TODAY's ISO weekday by construction), at 2900 kcal each, so the fallback
    // is provably NOT a hardcoded number — it is #1099's real weekday average.
    const analogs = [1, 2, 3, 4, 5].map((n) => {
      const d = new Date(Date.UTC(2026, 8, 25, 12, 0, 0)) // 2026-09-25 noon UTC, avoids DST edge issues
      d.setUTCDate(d.getUTCDate() - 7 * n)
      return { date: d.toISOString().slice(0, 10), calories_burned: 2900, end: new Date() }
    })
    const db = makeDb({ whoopCycles: analogs })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, TODAY)
    expect(result.basis).toBe('day_type_avg')
    // weekdayAnalog(2900) + goalKcalDelta(-500) = 2400, floored at MIN_FULL_DAY_KCAL
    // (2099) and at derivedBasis (stableDayKcalBasis: 2400-500=1900) -> max(1900,2400)=2400.
    expect(result.kcal).toBe(2400)
  })

  it(`a partial burn AT the ${MIN_TRUSTED_PARTIAL_BURN_KCAL} threshold (not above it) is NOT trusted -> day_type_avg`, async () => {
    const db = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: MIN_TRUSTED_PARTIAL_BURN_KCAL, end: null }] })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, TODAY, { now: kyivNow('13:23') })
    expect(result.basis).toBe('day_type_avg')
  })

  it(`${MIN_TRUSTED_PARTIAL_BURN_KCAL + 1} kcal (just above the threshold) IS trusted -> whoop_forecast`, async () => {
    const db = makeDb({
      whoopCycles: [{ date: TODAY, calories_burned: MIN_TRUSTED_PARTIAL_BURN_KCAL + 1, end: null }],
    })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, TODAY, { now: kyivNow('13:23') })
    expect(result.basis).toBe('whoop_forecast')
  })
})

describe('resolveKcalBasisWithForecast (#1504) — the forecast formula, hand-verified', () => {
  it('today, OPEN cycle: kcal = partial_burn + (tdee/24)*hoursRemaining + planned - deficit', async () => {
    // tdee 2400 -> hourly rate 100. now=19:23 Kyiv -> hoursRemaining = 24-19.3833 = 4.6167.
    // 2000 + 100*4.6167 = 2461.67 - 500 = 1961.67 -> round 1962.
    const db = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: 2000, end: null }] })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, TODAY, { now: kyivNow('19:23') })
    expect(result).toEqual({ kcal: 1962, basis: 'whoop_forecast' })
  })

  it('adds a planned-but-not-yet-happened workout on top of the same formula', async () => {
    // Same as above + 300 planned, no real workout logged yet: 1962 + 300 = 2262.
    const db = makeDb({
      whoopCycles: [{ date: TODAY, calories_burned: 2000, end: null }],
      activityPlans: [{ date: TODAY, done: false, calories_est: 300 }],
    })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, TODAY, { now: kyivNow('19:23') })
    expect(result).toEqual({ kcal: 2262, basis: 'whoop_forecast' })
  })

  it('today, CLOSED cycle (cycle.end set): the actual total IS the target basis, no rate/planned term', async () => {
    // 2500 - 500 = 2000, regardless of what time "now" is.
    const db = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: 2500, end: new Date() }] })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, TODAY, { now: kyivNow('13:23') })
    expect(result).toEqual({ kcal: 2000, basis: 'whoop_forecast' })
  })

  it('a PAST date (not today) uses the same actual-only formula even if its cycle doc still reads `end: null` — Apex triage "past days" default, no separate branch', async () => {
    // `end: null` deliberately (not a realistic value — a past day's cycle is always
    // closed in practice) to isolate exactly what the code checks: `date === today`,
    // not `cycle.end`. `now` is TODAY 13:23 -> formatDateKyiv(now) !== YESTERDAY ->
    // isOpenToday false regardless of `end`.
    const db = makeDb({ whoopCycles: [{ date: YESTERDAY, calories_burned: 2500, end: null }] })
    const result = await resolveKcalBasisWithForecast(db, PROFILE, YESTERDAY, { now: kyivNow('13:23') })
    expect(result).toEqual({ kcal: 2000, basis: 'whoop_forecast' })
  })

  it('#1504 REGRESSION (the point of this ticket): no discontinuity at the moment a cycle closes — the #1295 bug was exactly this kind of jump', async () => {
    // Same calories_burned, `now` fixed 1 minute before Kyiv midnight (hoursRemaining
    // ~0.0167h): the OPEN-cycle formula's rate/planned term is now near-zero, so it
    // must land within a couple of kcal of the CLOSED-cycle formula's plain actual
    // value — never a four-digit jump the way 1444->2400 was.
    const now = kyivNow('23:59')
    const openDb = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: 2500, end: null }] })
    const closedDb = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: 2500, end: new Date() }] })
    const open = await resolveKcalBasisWithForecast(openDb, PROFILE, TODAY, { now })
    const closed = await resolveKcalBasisWithForecast(closedDb, PROFILE, TODAY, { now })
    expect(open.basis).toBe('whoop_forecast')
    expect(closed.basis).toBe('whoop_forecast')
    expect(Math.abs(open.kcal - closed.kcal)).toBeLessThan(5)
  })

  it('#1504 REGRESSION: moving `now` forward with NO new sync data moves the target by exactly the forecast-term difference, nothing else', async () => {
    // Frozen calories_burned (no new sync between these two reads) — the only thing
    // that changes is the clock. The whole point: the delta must be EXACTLY the
    // hourlyRate*(hoursRemaining delta), never an unrelated jump.
    const db1 = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: 2038, end: null }] })
    const db2 = makeDb({ whoopCycles: [{ date: TODAY, calories_burned: 2038, end: null }] })
    const earlier = await resolveKcalBasisWithForecast(db1, PROFILE, TODAY, { now: kyivNow('13:30') })
    const later = await resolveKcalBasisWithForecast(db2, PROFILE, TODAY, { now: kyivNow('19:24') })
    const hoursApart = kyivHoursSinceMidnight(kyivNow('19:24')) - kyivHoursSinceMidnight(kyivNow('13:30'))
    const expectedDelta = Math.round((PROFILE.tdee_kcal / 24) * hoursApart)
    expect(earlier.kcal - later.kcal).toBeCloseTo(expectedDelta, 0)
    // Sanity bound named directly from the ticket's own acceptance text: a same-day,
    // no-new-data move must never approach the old bug's ~1000 kcal jump.
    expect(Math.abs(earlier.kcal - later.kcal)).toBeLessThan(700)
  })
})

export {}
