'use strict'

const { formatDateKyiv } = require('./training-program')
const { computeStock, mostRecentCycleBySupplementId } = require('./stock')

// #1492 (stage H of #1485, REQ-7): low-stock "купи X" reminder. ONE message
// PER CATALOG ITEM PER LOW-STOCK EVENT (days_left < 7, via computeStock()'s
// own `buy_prominent` — #1489, E2, not re-derived here), not a daily digest.
// Idempotent via `low_stock_notified: {at, anchor_count}` on the catalog
// item: the flag is keyed to the CURRENT anchor_count, so it is implicitly
// reset the moment the owner restocks via StockEditor (PATCH /:id/stock
// writes a NEW stock_anchor_count, #1489) — the next tick sees a different
// anchor_count than the one it already notified for and sends again once
// remaining drops back under 7 days. A failed send does not write the flag,
// so the next interval tick retries (same contract as lib/cycle-notify.js).
async function checkLowStockAndNotify(db, now = new Date(), sendTelegramImpl = require('../notify').sendTelegram) {
  const today = formatDateKyiv(now)
  const [items, cycles] = await Promise.all([
    db.collection('supplement_catalog').find({ active: { $ne: false } }).toArray(),
    db.collection('supplement_cycles').find({}).toArray(),
  ])
  const cycleBySupplementId = mostRecentCycleBySupplementId(cycles)

  let sent = 0
  let skipped = 0

  for (const item of items) {
    const cycle = cycleBySupplementId.get(item.id) || null
    const computed = computeStock(item, cycle, today)

    // No stock data at all (neither anchor nor legacy stock_remaining) ->
    // computeStock returns remaining:null, buy_prominent:false — nothing to
    // warn about (StockEditor was never used for this item).
    if (!computed.buy_prominent) {
      skipped++
      continue
    }

    const anchorCount = Number.isFinite(Number(item.stock_anchor_count))
      ? Number(item.stock_anchor_count)
      : Number(item.stock_remaining)

    const prev = item.low_stock_notified
    const alreadyNotifiedForThisAnchor = !!(prev && Number(prev.anchor_count) === anchorCount)
    if (alreadyNotifiedForThisAnchor) {
      skipped++
      continue
    }

    const ok = await sendTelegramImpl(formatMessage(item, computed))
    if (ok) {
      await db.collection('supplement_catalog').updateOne(
        { id: item.id },
        { $set: { low_stock_notified: { at: new Date().toISOString(), anchor_count: anchorCount } } }
      )
      sent++
    } else {
      // Send failed — do NOT write the flag. Next interval tick retries.
      skipped++
      console.warn('[stock-notify] sendTelegram returned false for catalog item', item.id, '— will retry next tick')
    }
  }

  return { checked: items.length, sent, skipped }
}

function formatMessage(item, computed) {
  const name = item.short_name || item.name || `#${item.id}`
  const remaining = Math.round(computed.remaining)
  const daysLeft = Math.max(0, Math.round(computed.days_left))
  const note = item.purchase_note ? `\n${item.purchase_note}` : ''
  return `🛒 <b>${name}</b>: залишилось ~${remaining} порцій (~${daysLeft} дн) — купити${note}`
}

module.exports = { checkLowStockAndNotify, formatMessage }
