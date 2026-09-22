/**
 * Parity test for lib/cycle-status.js (#1487, stage B of #1485, design D7)
 * against health-dashboard/src/utils/cycleStatus.js's OWN test fixtures
 * (src/tests/cycleStatus.test.js in that repo, #1412/#1420) — identical
 * cases, ported literally (no shared package between the two repos) so a
 * future edit to either file's date math is caught by BOTH suites.
 *
 * Also covers the two example dates named in #1487's acceptance B5 text
 * (Creatine 2026-06-10/8/4 → pause on 2026-08-10, completed on 2026-09-22) —
 * both fall inside the same pause/completed windows as the dashboard's own
 * boundary tests (activeEnd 2026-08-05, pauseEnd 2026-09-02), not new
 * boundary values.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cycleStatus, dateStatus, cycleWindow } = require('../../lib/cycle-status')

const CREATINE_CYCLE = { start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 4 }

describe('cycleStatus — boundary days (parity with health-dashboard/src/utils/cycleStatus.js)', () => {
  it('the start day itself is active', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-06-10'))).toBe('active')
  })
  it('the day BEFORE the active→pause transition is still active', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-08-04'))).toBe('active')
  })
  it('the exact active→pause transition day (activeEnd) is pause, not active', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-08-05'))).toBe('pause')
  })
  it('a day well inside the pause window is pause', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-08-20'))).toBe('pause')
  })
  it('the exact pause→completed transition day (pauseEnd) is completed, not pause', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-09-02'))).toBe('completed')
  })
  it('18.09 (the #1409 audit date) is completed', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-09-18'))).toBe('completed')
  })
  it('pause_weeks: 0 skips the pause stage entirely', () => {
    const noPause = { start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 0 }
    expect(cycleStatus(noPause, new Date('2026-08-04'))).toBe('active')
    expect(cycleStatus(noPause, new Date('2026-08-05'))).toBe('completed')
  })
  it('pause_weeks missing (undefined) behaves the same as 0', () => {
    const noPauseField = { start_date: '2026-06-10', duration_weeks: 8 }
    expect(cycleStatus(noPauseField, new Date('2026-08-05'))).toBe('completed')
  })

  // #1487 acceptance B5 example dates — both inside the SAME window as above.
  it('B5 example: 2026-08-10 is pause', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-08-10'))).toBe('pause')
  })
  it('B5 example: 2026-09-22 is completed', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-09-22'))).toBe('completed')
  })
})

describe('cycleStatus — manual status override (#1420 parity)', () => {
  it('status: "paused" forces "pause" even while active by dates', () => {
    const cycle = { ...CREATINE_CYCLE, status: 'paused' }
    expect(cycleStatus(cycle, new Date('2026-06-15'))).toBe('pause')
  })
  it('status: "completed" forces "completed" even while active by dates', () => {
    const cycle = { ...CREATINE_CYCLE, status: 'completed' }
    expect(cycleStatus(cycle, new Date('2026-06-15'))).toBe('completed')
  })
  it('status: "paused" wins over an already-completed date window', () => {
    const cycle = { ...CREATINE_CYCLE, status: 'paused' }
    expect(cycleStatus(cycle, new Date('2026-09-18'))).toBe('pause')
  })
  it('status: "active" is NOT an override — resolved purely from dates', () => {
    const cycle = { ...CREATINE_CYCLE, status: 'active' }
    expect(cycleStatus(cycle, new Date('2026-06-15'))).toBe('active')
    expect(cycleStatus(cycle, new Date('2026-09-18'))).toBe('completed')
  })
  it('missing status field is NOT an override', () => {
    expect(cycleStatus(CREATINE_CYCLE, new Date('2026-06-15'))).toBe('active')
  })
})

describe('dateStatus — pure dates, ignores manual override (used by cycle-notify.js)', () => {
  it('ignores a manual status:"paused" override and still resolves from dates alone', () => {
    const cycle = { ...CREATINE_CYCLE, status: 'paused' }
    expect(dateStatus(cycle, new Date('2026-06-15'))).toBe('active')
    expect(dateStatus(cycle, new Date('2026-08-20'))).toBe('pause')
    expect(dateStatus(cycle, new Date('2026-09-18'))).toBe('completed')
  })
})

describe('cycleWindow — active_end/pause_end as YYYY-MM-DD', () => {
  it('computes the correct boundary dates for the Creatine fixture', () => {
    expect(cycleWindow(CREATINE_CYCLE)).toEqual({ active_end: '2026-08-05', pause_end: '2026-09-02' })
  })
  it('with pause_weeks:0, pause_end equals active_end', () => {
    const noPause = { start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 0 }
    const win = cycleWindow(noPause)
    expect(win.active_end).toBe(win.pause_end)
    expect(win.active_end).toBe('2026-08-05')
  })
})

export {}
