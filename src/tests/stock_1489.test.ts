/**
 * #1489 (stage E of #1485, design E2): lib/stock.js::computeStock — anchor-
 * based derived stock. Fixtures match the acceptance text on task #1489
 * literally: "30 servings, 2/day, anchor 10 днів тому -> remaining 10,
 * days_left 5, buy_prominent true" and "той самий fixture з циклом у pause
 * останні 4 дні -> remaining 18".
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeStock } = require('../../lib/stock')

const TODAY = '2026-09-22'
const ANCHOR_10_AGO = '2026-09-12' // TODAY - 10 days, no month boundary crossed

describe('computeStock — E2 acceptance fixtures', () => {
  it('30 servings, 2/day, anchor 10 days ago, no cycle -> remaining 10, days_left 5, buy_prominent true', () => {
    const item = {
      id: 1,
      active: true,
      servings_per_day: 2,
      stock_anchor_date: ANCHOR_10_AGO,
      stock_anchor_count: 30,
    }
    const result = computeStock(item, null, TODAY)
    expect(result.remaining).toBe(10)
    expect(result.days_left).toBe(5)
    expect(result.buy_prominent).toBe(true)
    expect(result.servings_per_day).toBe(2)
  })

  it('same fixture, cycle paused for the last 4 of the 10 days -> remaining 18 (only 6 consuming days)', () => {
    const item = {
      id: 1,
      active: true,
      servings_per_day: 2,
      stock_anchor_date: ANCHOR_10_AGO,
      stock_anchor_count: 30,
    }
    // activeEnd = 2026-09-12 + 6/7*7 = 2026-09-18 (exactly 6 days active);
    // pauseEnd = activeEnd + 4/7*7 = 2026-09-22 (exactly 4 more days paused).
    // Verified against lib/cycle-status.js's own date math (6/7*7 === 6 in
    // JS float arithmetic — checked live before writing this fixture).
    const cycle = { start_date: ANCHOR_10_AGO, duration_weeks: 6 / 7, pause_weeks: 4 / 7 }
    const result = computeStock(item, cycle, TODAY)
    expect(result.remaining).toBe(18)
  })

  it('clamps to 0, never negative, when consumption exceeds the anchor count', () => {
    const item = {
      id: 1,
      active: true,
      servings_per_day: 2,
      stock_anchor_date: '2026-01-01', // ~265 days before TODAY
      stock_anchor_count: 5,
    }
    const result = computeStock(item, null, TODAY)
    expect(result.remaining).toBe(0)
    expect(result.days_left).toBe(0)
    expect(result.buy_prominent).toBe(true)
  })

  it('an inactive item consumes nothing since the anchor', () => {
    const item = {
      id: 1,
      active: false,
      servings_per_day: 2,
      stock_anchor_date: ANCHOR_10_AGO,
      stock_anchor_count: 30,
    }
    const result = computeStock(item, null, TODAY)
    expect(result.remaining).toBe(30)
    expect(result.days_left).toBe(15)
  })

  it('legacy item: stock_remaining set, no anchor fields, no updated_at -> anchors to today (0 days consumed)', () => {
    const item = {
      id: 13,
      active: true,
      servings_per_day: 1,
      stock_remaining: 60,
    }
    const result = computeStock(item, null, TODAY)
    expect(result.remaining).toBe(60)
    expect(result.days_left).toBe(60)
  })

  it('legacy item WITH updated_at -> anchors to that Kyiv day, not today', () => {
    const item = {
      id: 13,
      active: true,
      servings_per_day: 1,
      stock_remaining: 60,
      updated_at: '2026-09-12T10:00:00.000Z', // Kyiv day 2026-09-12 (UTC+3)
    }
    const result = computeStock(item, null, TODAY)
    // 10 days between 09-12 and TODAY (09-22), 1/day -> 60 - 10 = 50
    expect(result.remaining).toBe(50)
    expect(result.days_left).toBe(50)
  })

  it('an item with no anchor and no stock_remaining returns nulls (nothing to derive from)', () => {
    const item = { id: 19, active: true, servings_per_day: 1 }
    const result = computeStock(item, null, TODAY)
    expect(result.remaining).toBeNull()
    expect(result.days_left).toBeNull()
    expect(result.buy_prominent).toBe(false)
  })

  it('no explicit servings_per_day -> resolves via resolveServingsPerDay(schedule)', () => {
    const item = {
      id: 1,
      active: true,
      dose: '2-3 капс',
      schedule: 'morning',
      stock_anchor_date: ANCHOR_10_AGO,
      stock_anchor_count: 30,
    }
    const result = computeStock(item, null, TODAY)
    expect(result.servings_per_day).toBe(1)
    expect(result.remaining).toBe(20) // 30 - 1*10
  })
})

export {}
