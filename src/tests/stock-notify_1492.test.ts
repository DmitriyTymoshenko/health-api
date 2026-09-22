/**
 * Unit tests for lib/stock-notify.js (#1492, stage H of #1485, REQ-7).
 * Fixture matches lib/stock.js's own #1489 acceptance fixture (stock_1489.test.ts):
 * "30 servings, 2/day, anchor 10 days ago -> remaining 10, days_left 5, buy_prominent true".
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkLowStockAndNotify } = require('../../lib/stock-notify')

type Doc = Record<string, any>

function makeDB(initialItems: Doc[], cycles: Doc[] = []) {
  const items = initialItems.map(i => ({ ...i }))
  return {
    collection(name: string) {
      if (name === 'supplement_catalog') {
        return {
          find(_filter: Doc) {
            return { toArray: async () => items.filter(i => i.active !== false).map(i => ({ ...i })) }
          },
          async updateOne(filter: Doc, update: Doc) {
            const doc = items.find(i => i.id === filter.id)
            if (!doc) return { matchedCount: 0 }
            Object.assign(doc, update.$set || {})
            return { matchedCount: 1 }
          },
        }
      }
      if (name === 'supplement_cycles') {
        return { find() { return { toArray: async () => cycles.map(c => ({ ...c })) } } }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
    _items: items,
  }
}

const TODAY = new Date('2026-09-22T12:00:00Z') // Kyiv day 2026-09-22
const ANCHOR_10_AGO = '2026-09-12'

function lowStockItem(overrides: Doc = {}) {
  return {
    id: 1,
    name: 'NUTREND Ashwagandha',
    short_name: 'Ashwagandha',
    active: true,
    servings_per_day: 2,
    stock_anchor_date: ANCHOR_10_AGO,
    stock_anchor_count: 30,
    ...overrides,
  }
}

describe('checkLowStockAndNotify — H1', () => {
  it('a buy_prominent item with no prior notification sends exactly 1 message and writes the flag', async () => {
    const db = makeDB([lowStockItem()])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)

    expect(sendTelegramImpl).toHaveBeenCalledTimes(1)
    const msg = sendTelegramImpl.mock.calls[0][0]
    expect(msg).toContain('Ashwagandha')
    expect(msg).toContain('купити')
    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 })
    expect(db._items[0].low_stock_notified).toEqual({ at: expect.any(String), anchor_count: 30 })
  })

  it('a repeated call for the same anchor sends 0 more messages (idempotent)', async () => {
    const db = makeDB([lowStockItem()])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    sendTelegramImpl.mockClear()

    const result2 = await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result2).toEqual({ checked: 1, sent: 0, skipped: 1 })
  })

  it('a failed send does NOT write the flag — the next tick retries', async () => {
    const db = makeDB([lowStockItem()])
    const failingSend = jest.fn(async () => false)
    const result = await checkLowStockAndNotify(db, TODAY, failingSend)

    expect(result).toEqual({ checked: 1, sent: 0, skipped: 1 })
    expect(db._items[0].low_stock_notified).toBeUndefined()

    const workingSend = jest.fn(async (_msg: string) => true)
    const result2 = await checkLowStockAndNotify(db, TODAY, workingSend)
    expect(workingSend).toHaveBeenCalledTimes(1)
    expect(result2).toEqual({ checked: 1, sent: 1, skipped: 0 })
  })

  it('an item that is not low-stock (buy_prominent:false) is never notified', async () => {
    const plentyItem = lowStockItem({ stock_anchor_date: '2026-09-22', stock_anchor_count: 60 })
    const db = makeDB([plentyItem])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ checked: 1, sent: 0, skipped: 1 })
  })

  it('an item with no stock data at all (no anchor, no legacy stock_remaining) is never notified', async () => {
    const noStockItem = { id: 2, name: 'GymBeam Vitamin D3', active: true, servings_per_day: 1 }
    const db = makeDB([noStockItem])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ checked: 1, sent: 0, skipped: 1 })
  })

  it('after a restock (bigger anchor_count) the flag resets — next low-stock crossing sends again', async () => {
    const db = makeDB([lowStockItem()])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)

    // First crossing at TODAY (2026-09-22): remaining 10, days_left 5 -> sends.
    await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(db._items[0].low_stock_notified.anchor_count).toBe(30)
    sendTelegramImpl.mockClear()

    // Owner restocks via StockEditor (PATCH /:id/stock) right now: new anchor
    // 20 servings as of today -> remaining 20, days_left 10 -> not buy_prominent yet.
    db._items[0].stock_anchor_date = '2026-09-22'
    db._items[0].stock_anchor_count = 20
    const afterRestock = await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(afterRestock).toEqual({ checked: 1, sent: 0, skipped: 1 })

    // 9 days later: remaining = 20 - 2*9 = 2, days_left = 1 -> buy_prominent
    // again. anchor_count is now 20 (not the old 30), so the stale flag from
    // the FIRST crossing does not suppress this new event.
    const NINE_DAYS_LATER = new Date('2026-10-01T12:00:00Z')
    const result = await checkLowStockAndNotify(db, NINE_DAYS_LATER, sendTelegramImpl)
    expect(sendTelegramImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 })
    expect(db._items[0].low_stock_notified).toEqual({ at: expect.any(String), anchor_count: 20 })
  })

  it('appends purchase_note when present', async () => {
    const db = makeDB([lowStockItem({ purchase_note: 'На Rozetka, 350 грн' })])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(sendTelegramImpl.mock.calls[0][0]).toContain('На Rozetka, 350 грн')
  })

  it('multiple low-stock supplements in one tick -> one message PER supplement, not a combined digest', async () => {
    const db = makeDB([
      lowStockItem({ id: 1, short_name: 'Ashwagandha' }),
      lowStockItem({ id: 5, short_name: 'ZMA' }),
    ])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await checkLowStockAndNotify(db, TODAY, sendTelegramImpl)
    expect(sendTelegramImpl).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ checked: 2, sent: 2, skipped: 0 })
  })
})

export {}
