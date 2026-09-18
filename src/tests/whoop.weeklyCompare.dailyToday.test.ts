/**
 * #1411 R3 (audit #1409 §2.5/§4): `/api/whoop/weekly-compare`'s `splitWeek` used to include
 * today's still-running cycle in the DAILY metrics (strain, calories_burned, nutrition,
 * workouts), dragging the "current week" average down by a partial day — measured 18.09
 * as e.g. protein 153g/day instead of the real ≈180g/day (↓20.7% instead of the real ↓6.8%).
 * Night metrics (recovery/sleep) are correct as-is — tonight's sleep record is already
 * complete by the time this endpoint runs.
 *
 * Logic replicated inline — same established pattern as the sibling file
 * whoop.weeklyCompare.test.ts ("the route computes periods inside an Express closure, not
 * exported as a standalone function"). `daysBetweenDateStrings` is the ONE real import (not
 * reimplemented) per the #966/#988 "a stub of the same typo only proves the typo" lesson.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { daysBetweenDateStrings } = require('../../lib/training-program')

// --- Replicate routes/whoop.js /weekly-compare's period + splitWeek computation exactly ---
function computePeriodsAndSplit(now: Date) {
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
  const todayDate = new Date(today + 'T00:00:00')
  const dayOfWeek = todayDate.getDay()
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisMonday = new Date(todayDate)
  thisMonday.setDate(todayDate.getDate() - mondayOffset)
  const fmt = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
  const thisMondayStr = fmt(thisMonday)
  const todayStr = today

  const yesterdayDate = new Date(todayDate)
  yesterdayDate.setDate(todayDate.getDate() - 1)
  const yesterdayStr = fmt(yesterdayDate)
  const currentDailyDays = Math.max(0, daysBetweenDateStrings(thisMondayStr, yesterdayStr) + 1)

  function splitWeekCurr(arr: { date: string }[], excludeToday: boolean) {
    const currEnd = excludeToday ? yesterdayStr : todayStr
    return arr.filter((d) => d.date >= thisMondayStr && d.date <= currEnd)
  }

  return { thisMondayStr, todayStr, yesterdayStr, currentDailyDays, splitWeekCurr }
}

describe('#1411 R3: weekly-compare daily-metric window excludes today', () => {
  it('a known Friday (2026-09-18): daily curr = Mon..Thu (4 days), night curr = Mon..Fri (5 days)', () => {
    const now = new Date('2026-09-18T09:00:00.000Z') // ~12:00 Kyiv, mid-day, no boundary ambiguity
    const { thisMondayStr, currentDailyDays, splitWeekCurr } = computePeriodsAndSplit(now)
    expect(thisMondayStr).toBe('2026-09-14')
    expect(currentDailyDays).toBe(4) // Mon 14, Tue 15, Wed 16, Thu 17 — Fri 18 (today) excluded

    const cycles = [
      { date: '2026-09-14', strain: 10 },
      { date: '2026-09-15', strain: 11 },
      { date: '2026-09-16', strain: 12 },
      { date: '2026-09-17', strain: 13 },
      { date: '2026-09-18', strain: 0.18 }, // today — partial cycle, must NOT enter curr
    ]
    const dailyCurr = splitWeekCurr(cycles, true)
    expect(dailyCurr.map((c) => c.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'])
    expect(dailyCurr.find((c) => c.date === '2026-09-18')).toBeUndefined()

    const recovery = [
      { date: '2026-09-14', recovery_score: 70 },
      { date: '2026-09-18', recovery_score: 68 }, // today's night data — already complete, must stay
    ]
    const nightCurr = splitWeekCurr(recovery, false)
    expect(nightCurr.map((r) => r.date)).toEqual(['2026-09-14', '2026-09-18'])
  })

  it('Monday itself (2026-09-14, before the first night lands): daily curr is EMPTY, currentDailyDays=0, no crash', () => {
    const now = new Date('2026-09-14T05:00:00.000Z') // ~08:00 Kyiv Monday morning
    const { thisMondayStr, currentDailyDays, splitWeekCurr } = computePeriodsAndSplit(now)
    expect(thisMondayStr).toBe('2026-09-14')
    expect(currentDailyDays).toBe(0) // yesterday (09-13) is before thisMonday — empty window, clamped not negative

    const cycles = [{ date: '2026-09-14', strain: 0.02 }] // today's partial cycle only
    const dailyCurr = splitWeekCurr(cycles, true)
    expect(dailyCurr).toEqual([]) // empty, not a crash, not a negative-range false match

    // Night metrics still see today normally (Monday's own recovery, once it lands)
    const recovery = [{ date: '2026-09-14', recovery_score: 55 }]
    const nightCurr = splitWeekCurr(recovery, false)
    expect(nightCurr).toEqual([{ date: '2026-09-14', recovery_score: 55 }])
  })

  it('Tuesday (2 days into the week): currentDailyDays=1 (Mon only), matches days_count semantics', () => {
    const now = new Date('2026-09-15T09:00:00.000Z') // Tuesday, mid-day Kyiv
    const { currentDailyDays } = computePeriodsAndSplit(now)
    expect(currentDailyDays).toBe(1)
  })
})

export {}
