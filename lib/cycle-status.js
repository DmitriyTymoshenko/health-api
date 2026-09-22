'use strict'

// #1487 (stage B of #1485, design D7): server-side copy of
// health-dashboard/src/utils/cycleStatus.js. This is a DELIBERATE, documented
// duplicate — NOT a refactor to share one file across the two separate repos
// (health-api/health-dashboard have no shared package). `GET /api/catalog/cycles`
// needs `computed_status`/`active_end`/`pause_end` server-side so
// lib/cycle-notify.js can decide "did this cycle just enter pause/completed"
// without duplicating date math a THIRD time inside cycle-notify.js itself.
// The dashboard's OWN `cycleStatus()` (health-dashboard/src/utils/cycleStatus.js)
// is left untouched — its #1412/#1420 tests are the acceptance bar for THAT
// file, and dashboard display logic still calls it directly. Cross-referenced
// in both files' header comments so a future edit to one is a prompt to check
// the other's parity test (src/tests/cycle-status.test.ts here).
//
// Same rule as the dashboard file: `cycle.status === 'completed'`/`'paused'`
// (a manual override, #1420) wins over date math and is checked FIRST;
// anything else falls through to pure dates.
function cycleStatus(cycle, referenceDate = new Date()) {
  if (cycle.status === 'completed') return 'completed'
  if (cycle.status === 'paused') return 'pause'

  const start = new Date(cycle.start_date)
  const activeEnd = new Date(start)
  activeEnd.setDate(activeEnd.getDate() + cycle.duration_weeks * 7)
  const pauseWeeks = cycle.pause_weeks || 0
  const pauseEnd = new Date(activeEnd)
  pauseEnd.setDate(pauseEnd.getDate() + pauseWeeks * 7)

  if (referenceDate < activeEnd) return 'active'
  if (pauseWeeks > 0 && referenceDate < pauseEnd) return 'pause'
  return 'completed'
}

// #1487 D7: `dateStatus` is the SAME date math as `cycleStatus` but WITHOUT
// the manual-override check — cycle-notify.js needs to know "would this cycle
// be pause/completed purely by its dates" separately from the manual
// override, because a manual Пауза/Закінчити click is a deliberate user
// action that should notify immediately (via the normal `cycleStatus` path),
// while the date-driven transition needs its OWN idempotency tracking so it
// doesn't re-fire every 60-minute interval tick once a cycle has already
// crossed a boundary. In practice `checkCycleEndsAndNotify` (lib/cycle-notify.js)
// uses `cycleStatus()` (override-aware) for the actual notify decision — this
// export exists for the two functions that document/test the pure-date
// component in isolation (`cycleWindow` below, and this function's own
// parity test against the dashboard's un-exported date branch).
function dateStatus(cycle, referenceDate = new Date()) {
  const start = new Date(cycle.start_date)
  const activeEnd = new Date(start)
  activeEnd.setDate(activeEnd.getDate() + cycle.duration_weeks * 7)
  const pauseWeeks = cycle.pause_weeks || 0
  const pauseEnd = new Date(activeEnd)
  pauseEnd.setDate(pauseEnd.getDate() + pauseWeeks * 7)

  if (referenceDate < activeEnd) return 'active'
  if (pauseWeeks > 0 && referenceDate < pauseEnd) return 'pause'
  return 'completed'
}

// Returns the cycle's active-window end date and pause-window end date as
// YYYY-MM-DD strings (Kyiv-agnostic — cycle dates are already plain
// YYYY-MM-DD day values, no time-of-day component to normalize, same as the
// rest of this feature's date handling).
function cycleWindow(cycle) {
  const start = new Date(cycle.start_date)
  const activeEnd = new Date(start)
  activeEnd.setDate(activeEnd.getDate() + cycle.duration_weeks * 7)
  const pauseWeeks = cycle.pause_weeks || 0
  const pauseEnd = new Date(activeEnd)
  pauseEnd.setDate(pauseEnd.getDate() + pauseWeeks * 7)
  return {
    active_end: activeEnd.toISOString().split('T')[0],
    pause_end: pauseWeeks > 0 ? pauseEnd.toISOString().split('T')[0] : activeEnd.toISOString().split('T')[0],
  }
}

module.exports = { cycleStatus, dateStatus, cycleWindow }
