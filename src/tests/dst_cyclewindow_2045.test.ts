const { cycleWindow } = require('../../lib/cycle-status')
const { computeLabsReminders } = require('../../lib/labs-reminders')

describe('#2045 DST-crossing day math', () => {
  const tz = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Europe/Kyiv' })
  afterAll(() => { process.env.TZ = tz })
  test('cycleWindow crossing spring DST', () => {
    const w = cycleWindow({ start_date: '2026-02-20', duration_weeks: 6, pause_weeks: 2 })
    expect(w.active_end).toBe('2026-04-03')
    expect(w.pause_end).toBe('2026-04-17')
  })
  test('cycleWindow crossing autumn DST (regression-only, also green on old code)', () => {
    expect(cycleWindow({ start_date: '2026-09-20', duration_weeks: 6 }).active_end).toBe('2026-11-01')
  })
  test('labs nextDate crossing spring DST', () => {
    const r = computeLabsReminders([{ date: '2026-03-01', values: { x: 1 } }], {}, { x: 60 }, () => 'ok', new Date('2026-03-02'))
    const item = [...r.overdue, ...r.soon, ...r.upcoming][0]
    expect(item.nextDate).toBe('2026-04-30')
  })
})

export {}
