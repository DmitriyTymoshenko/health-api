'use strict'

// #1487 (stage B of #1485, design D8): notify Dmytro (via the existing Lisa
// bot / OWNER_TELEGRAM_ID path in notify.js) when a supplement cycle crosses
// into pause or completed. Idempotent per (cycle, state) via an
// `end_notified.<state>` timestamp written ONLY after a CONFIRMED send
// (`sendTelegram` resolves `true`/`false` on HTTP status, #1487 D8) — a
// failed send must be retried on the next interval tick, not silently marked
// "done".
//
// Deliberately uses `cycleStatus()` (manual-override-aware), not the pure
// `dateStatus()` — a manual Пауза/Закінчити click is real user intent and
// should notify on the SAME interval tick it's clicked, exactly like a
// date-driven transition. The guard against re-notifying every 60 minutes is
// the `end_notified` flag, not which status function is used.

const { cycleStatus } = require('./cycle-status')

const NOTIFIABLE_STATES = new Set(['pause', 'completed'])

function formatMessage(cycle, state) {
  const name = cycle.supplement_name || `#${cycle.supplement_id}`
  if (state === 'pause') {
    return `⏸ <b>Цикл завершено: ${name}</b>\nАктивна фаза закінчилась — зараз пауза.`
  }
  return `✅ <b>Цикл + пауза завершені: ${name}</b>\nПочати новий цикл чи прибрати з розкладу?`
}

/**
 * db: Mongo db handle (supplement_cycles collection)
 * now: reference Date (injectable for tests, defaults to real time)
 * sendTelegramImpl: injectable (defaults to notify.js's real sendTelegram)
 *
 * Returns { checked, sent, skipped } counts for logging/tests.
 */
async function checkCycleEndsAndNotify(db, now = new Date(), sendTelegramImpl = require('../notify').sendTelegram) {
  const cycles = await db.collection('supplement_cycles').find({}).toArray()
  let sent = 0
  let skipped = 0

  for (const cycle of cycles) {
    const state = cycleStatus(cycle, now)
    if (!NOTIFIABLE_STATES.has(state)) continue

    const alreadyNotified = !!(cycle.end_notified && cycle.end_notified[state])
    if (alreadyNotified) {
      skipped++
      continue
    }

    const ok = await sendTelegramImpl(formatMessage(cycle, state))
    if (ok) {
      await db.collection('supplement_cycles').updateOne(
        { _id: cycle._id },
        { $set: { [`end_notified.${state}`]: new Date().toISOString() } }
      )
      sent++
    } else {
      // Send failed — do NOT write the flag. Next interval tick retries.
      skipped++
      console.warn('[cycle-notify] sendTelegram returned false for cycle', cycle._id, 'state', state, '— will retry next tick')
    }
  }

  return { checked: cycles.length, sent, skipped }
}

module.exports = { checkCycleEndsAndNotify, formatMessage, NOTIFIABLE_STATES }
