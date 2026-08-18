/**
 * WHOOP /weekly-compare — periods.current/previous Kyiv-day-bounds regression guard
 * (task #1073 BATCH-4 Ф1/Ф2: shared assertKyivDayBounds() coverage, "dashboard + health"
 * per #1045's acceptance criterion — this is the health-side endpoint).
 *
 * Unlike #825/#870/#971 (independently found bugs, see #1073 comments), routes/whoop.js's
 * `/weekly-compare` already computes its Monday/Sunday boundaries via
 * `toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })` — i.e. it was ALREADY Kyiv-day
 * correct. This test migrates it onto the shared guard so it stays that way (same convention
 * as dashboard/backend analytics.service.spec.ts's #998 migration) and adds the required
 * Kyiv 00:00-00:30 midnight boundary regression case.
 *
 * Logic replicated inline (established pattern in this file's sibling whoop.test.ts — the
 * route computes periods inside an Express closure, not exported as a standalone function).
 */
import { assertKyivDayBounds, formatDateKyiv, KYIV_MIDNIGHT_BOUNDARY_CASE } from './utils/kyivDayBounds'

// --- Replicate routes/whoop.js /weekly-compare period computation exactly ---
function computeWeeklyComparePeriods(now: Date) {
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
  const todayDate = new Date(today + 'T00:00:00')
  const dayOfWeek = todayDate.getDay()
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisMonday = new Date(todayDate)
  thisMonday.setDate(todayDate.getDate() - mondayOffset)
  const lastMonday = new Date(thisMonday)
  lastMonday.setDate(thisMonday.getDate() - 7)
  const lastSunday = new Date(thisMonday)
  lastSunday.setDate(thisMonday.getDate() - 1)
  const fmt = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
  return {
    current: { from: fmt(thisMonday), to: today },
    previous: { from: fmt(lastMonday), to: fmt(lastSunday) },
  }
}

describe('/api/whoop/weekly-compare — periods stay Kyiv-day bound (#1073 Ф1)', () => {
  it('current.from/to and previous.from/to are bare YYYY-MM-DD Kyiv calendar days for a known Tuesday', () => {
    // 2026-08-18 is a Tuesday (Kyiv) — Monday-of-this-week is 2026-08-17, last week is 08-10..08-16.
    const now = new Date('2026-08-18T12:00:00.000Z') // midday UTC, no boundary ambiguity
    const periods = computeWeeklyComparePeriods(now)
    assertKyivDayBounds({ period: periods.current }, { expectedFrom: '2026-08-17', expectedTo: '2026-08-18' })
    assertKyivDayBounds({ period: periods.previous }, { expectedFrom: '2026-08-10', expectedTo: '2026-08-16' })
  })

  it('#1073 Ф1 regression: Kyiv 00:00-00:30 midnight boundary — "today" is the NEW Kyiv day, not the stale UTC one', () => {
    // KYIV_MIDNIGHT_BOUNDARY_CASE.utcInstant = 2026-08-01 00:00 Kyiv == 2026-07-31 21:00 UTC —
    // a naive UTC read would still call this "07-31"; the Kyiv-aware computation must not.
    const now = new Date(KYIV_MIDNIGHT_BOUNDARY_CASE.utcInstant)
    const periods = computeWeeklyComparePeriods(now)
    expect(periods.current.to).toBe(KYIV_MIDNIGHT_BOUNDARY_CASE.kyivDay)
    expect(formatDateKyiv(now)).toBe(periods.current.to) // cross-check against the canonical conversion
    expect(now.toISOString().slice(0, 10)).not.toBe(periods.current.to) // proves it's NOT a raw UTC slice
  })
})
