/**
 * #1411 R3: live route-level proof that GET /api/whoop/weekly-compare (1) never lets today's
 * partial cycle/workout/nutrition into the "current week" daily-metric average, and (2) tells
 * the frontend via `periods.current.includes_today`/`days`. Route-level (supertest), not just
 * the inline-replicated unit test in whoop.weeklyCompare.dailyToday.test.ts — this exercises
 * the ACTUAL splitWeek/response-shape code path the Express app serves.
 *
 * "Today" is pinned via jest fake timers (Fri 2026-09-18, mirrors the number used in audit
 * #1409 §2.5) so the assertions are deterministic regardless of the day this suite runs on.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whoopRoute = require('../../routes/whoop')

function chain(data: Array<Record<string, unknown>>) {
  return {
    sort() { return this },
    toArray: async () => data,
  }
}

function makeApp(collections: Record<string, Array<Record<string, unknown>>>) {
  const db = {
    collection(name: string) {
      const rows = collections[name] || []
      return {
        find(filter: { date?: { $gte: string; $lte: string } }) {
          const from = filter?.date?.$gte
          const to = filter?.date?.$lte
          return chain(rows.filter((r: any) => (!from || r.date >= from) && (!to || r.date <= to)))
        },
      }
    },
  }
  const app = express()
  app.use('/api/whoop', whoopRoute(() => db))
  return app
}

describe('GET /api/whoop/weekly-compare (#1411 R3)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: false })
    jest.setSystemTime(new Date('2026-09-18T09:00:00.000Z')) // Friday, mid-day Kyiv
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('excludes today from strain/calories/workouts curr, keeps today in recovery/sleep curr, carries includes_today+days', async () => {
    const app = makeApp({
      whoop_cycles: [
        { date: '2026-09-14', strain: 10, calories_burned: 2600 },
        { date: '2026-09-15', strain: 11, calories_burned: 2500 },
        { date: '2026-09-16', strain: 12, calories_burned: 2700 },
        { date: '2026-09-17', strain: 13, calories_burned: 2620 },
        { date: '2026-09-18', strain: 0.18, calories_burned: 866 }, // today — partial, must be excluded
      ],
      whoop_recovery: [
        { date: '2026-09-14', recovery_score: 70, hrv_rmssd: 60, resting_heart_rate: 50 },
        { date: '2026-09-18', recovery_score: 68, hrv_rmssd: 58, resting_heart_rate: 51 }, // today's night — complete, must stay
      ],
      whoop_sleep: [
        { date: '2026-09-18', sleep_hours: 8.5, sleep_performance: 90, sleep_efficiency: 88 },
      ],
      whoop_workouts: [
        { date: '2026-09-17', type: 'run' },
        { date: '2026-09-18', type: 'gym' }, // today's workout — must not count toward curr
      ],
      nutrition_log: [
        { date: '2026-09-14', kcal: 2500, protein_g: 180 },
        { date: '2026-09-15', kcal: 2550, protein_g: 185 },
        { date: '2026-09-16', kcal: 2480, protein_g: 178 },
        { date: '2026-09-17', kcal: 2600, protein_g: 176 },
        { date: '2026-09-18', kcal: 624, protein_g: 44 }, // today — partial day, must not drag curr average down
      ],
      weight_log: [],
      water_log: [],
      steps: [],
    })

    const res = await request(app).get('/api/whoop/weekly-compare')
    expect(res.status).toBe(200)

    expect(res.body.periods.current).toMatchObject({
      from: '2026-09-14',
      to: '2026-09-18',
      includes_today: false,
      days: 4,
    })

    // strain/calories curr average is over the 4 complete days ONLY (10,11,12,13 -> 11.5)
    expect(res.body.strain.current).toBe(11.5)
    // workouts_count.current excludes today's gym session
    expect(res.body.workouts_count.current).toBe(1)
    // nutrition.current.protein_g averages the 4 complete days (180,185,178,176 -> 179.75 -> 179.8), NOT
    // diluted by today's partial 44g entry (which would pull it down to ~152.6, the audit's #1409 number)
    expect(res.body.nutrition.current.protein_g).toBe(180) // Math.round(179.75)

    // recovery/sleep DO include today — a completed night record
    expect(res.body.recovery.current).toBe(69) // avg(70, 68) rounded
  })

  it('Monday before the first night: curr is empty everywhere relevant, no NaN, 200 OK', async () => {
    jest.setSystemTime(new Date('2026-09-14T05:00:00.000Z')) // Monday morning Kyiv
    const app = makeApp({
      whoop_cycles: [{ date: '2026-09-14', strain: 0.02, calories_burned: 50 }],
      whoop_recovery: [],
      whoop_sleep: [],
      whoop_workouts: [],
      nutrition_log: [],
      weight_log: [],
      water_log: [],
      steps: [],
    })

    const res = await request(app).get('/api/whoop/weekly-compare')
    expect(res.status).toBe(200)
    expect(res.body.periods.current.includes_today).toBe(false)
    expect(res.body.periods.current.days).toBe(0)
    expect(res.body.strain.current).toBeNull() // no NaN, no crash
    expect(res.body.strain.delta).toBeNull()
  })
})

export {}
