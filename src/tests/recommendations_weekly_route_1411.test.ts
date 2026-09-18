/**
 * #1411 R3 (audit #1409 §2.5/§4): GET /api/recommendations/weekly used to build its 7-day
 * trailing window as `today-6..today` — an in-progress, partially-logged today could pull
 * the week's avg_calories/avg_protein down and fire a false "день недоїдання"/protein-deficit
 * pattern purely because today isn't over yet. Fixed window is `today-7..today-1` (7 FULL
 * days, today excluded entirely) — same invariant as routes/whoop.js `/weekly-compare`
 * (#1411 R3, whoop_weekly_compare_route_1411.test.ts).
 *
 * "Today" pinned via jest fake timers so the window is deterministic.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recommendationsRoute = require('../../routes/recommendations')

function chain(data: Array<Record<string, unknown>>) {
  return { toArray: async () => data }
}

function makeApp(opts: {
  profile?: Record<string, unknown> | null
  nutrition?: Array<Record<string, unknown>>
  whoopCycles?: Array<Record<string, unknown>>
  latestWeight?: Record<string, unknown> | null
}) {
  const nutrition = opts.nutrition || []
  const whoopCycles = opts.whoopCycles || []

  const db = {
    collection(name: string) {
      if (name === 'personal_profile') {
        return { findOne: async () => opts.profile ?? null }
      }
      if (name === 'weight_log') {
        return { findOne: async () => opts.latestWeight ?? null }
      }
      if (name === 'nutrition_log') {
        return {
          find(filter: { date?: { $in?: string[] } }) {
            const allowed = new Set(filter?.date?.$in || [])
            return chain(nutrition.filter((n: any) => allowed.has(n.date)))
          },
        }
      }
      if (name === 'whoop_cycles') {
        return {
          find(filter: { date?: { $gte: string; $lte: string } }) {
            const from = filter?.date?.$gte
            const to = filter?.date?.$lte
            return chain(whoopCycles.filter((c: any) => (!from || c.date >= from) && (!to || c.date <= to)))
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
  const app = express()
  app.use('/api/recommendations', recommendationsRoute(() => db))
  return app
}

describe('GET /api/recommendations/weekly (#1411 R3)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: false })
    jest.setSystemTime(new Date('2026-09-18T09:00:00.000Z')) // Friday, mid-day Kyiv
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('window is the 7 FULL days ending yesterday; a phantom low-cal/low-protein TODAY row never enters the average', async () => {
    const sevenDays = ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']
    const nutrition = sevenDays.map((date) => ({ date, kcal: 2500, protein_g: 180 }))
    // Today's row — if the window still (wrongly) included today, this single extreme entry
    // would crash avg_calories toward (2500*7+50)/8≈2231 and avg_protein toward
    // (180*7+1)/8≈157.6, and would show up as an "under_eating"/"protein_deficit" pattern.
    nutrition.push({ date: '2026-09-18', kcal: 50, protein_g: 1 })

    const app = makeApp({
      profile: { daily_kcal_goal: 2500, daily_protein_goal_g: 150, primary_goal: 'weight_loss' },
      nutrition,
      whoopCycles: [],
    })

    const res = await request(app).get('/api/recommendations/weekly')
    expect(res.status).toBe(200)

    expect(res.body.week_summary.includes_today).toBe(false)
    expect(res.body.week_summary.window_days).toBe(7)

    // `days` (the per-day chart array) is exactly the 7 full days — today is NOT in it
    expect(res.body.days).toHaveLength(7)
    expect(res.body.days.map((d: { date: string }) => d.date)).toEqual(sevenDays)
    expect(res.body.days.find((d: { date: string }) => d.date === '2026-09-18')).toBeUndefined()

    // Averages are exactly the 7 real days' values — untouched by today's phantom row
    expect(res.body.week_summary.avg_calories).toBe(2500)
    expect(res.body.week_summary.avg_protein).toBe(180)
    expect(res.body.week_summary.days_with_data).toBe(7)

    // No false "day of undereating"/"protein deficit" pattern from today's partial data
    const patternTypes = res.body.patterns.map((p: { type: string }) => p.type)
    expect(patternTypes).not.toContain('under_eating')
    expect(patternTypes).not.toContain('protein_deficit')
  })

  it('empty week (no data at all): 200 OK, no NaN, no patterns crash', async () => {
    const app = makeApp({ profile: null, nutrition: [], whoopCycles: [] })
    const res = await request(app).get('/api/recommendations/weekly')
    expect(res.status).toBe(200)
    expect(res.body.week_summary.includes_today).toBe(false)
    expect(res.body.week_summary.window_days).toBe(7)
    expect(res.body.week_summary.days_with_data).toBe(0)
    expect(Number.isNaN(res.body.week_summary.avg_calories)).toBe(false)
  })
})

export {}
