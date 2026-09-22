'use strict'

const { formatDateKyiv, getKyivIsoWeekday } = require('./training-program')
const { fetchLabsReminders } = require('./labs-reminders')

// #1492 (stage H of #1485, REQ-10): weekly digest of overdue/soon lab
// retests. Reuses the EXACT same bucketing `GET /api/labs/reminders` exposes
// (lib/labs-reminders.js) instead of a second copy of RETEST_INTERVALS/
// daysLeft logic. Runs on the SAME 60-min interval tick as
// lib/cycle-notify.js / lib/stock-notify.js (server.js, one setInterval) —
// fires only on the FIRST tick at/after 09:00 Kyiv on an ISO-Monday, gated
// by a `health_notify_state` doc ({key:'labs_digest', last_sent_iso_week})
// so a restart mid-week, or a later tick the same Monday, never re-sends.
// Nothing is sent (and no flag is written) when overdue+soon are both empty
// — an empty week must never count as "already handled", so the digest
// naturally sends on the first Monday that actually has something due.

const DIGEST_KEY = 'labs_digest'

/** @param {Date} now @returns {number} Kyiv local hour, 0-23 */
function kyivHour(now) {
  return Number(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }))
}

/**
 * ISO-8601 week key ("2026-W39") for the Kyiv calendar day of `now`.
 * Standard "Thursday of the week" algorithm — verified live against known
 * Kyiv dates before use (2026-09-21 Mon and 2026-09-22 Tue both -> 2026-W39).
 * @param {Date} now
 * @returns {string}
 */
function isoWeekKey(now) {
  const dateStr = formatDateKyiv(now)
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = (date.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const weekNum = 1 + Math.round((date - firstThursday) / (7 * 86400000))
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

function formatDdMm(dateStr) {
  const [, m, d] = dateStr.split('-')
  return `${d}.${m}`
}

function formatMessage(overdue, soon) {
  const marker = overdue[0] ? ` (${overdue[0].name} · останній ${formatDdMm(overdue[0].lastDate)})` : ''
  return `🔬 <b>Аналізи</b>: прострочено ${overdue.length}${marker}, скоро ${soon.length}`
}

/**
 * db: Mongo db handle (lab_results + health_notify_state collections)
 * now: reference Date (injectable for tests)
 * sendTelegramImpl: injectable (defaults to notify.js's real sendTelegram)
 *
 * Returns { sent: boolean, reason?: string, overdueCount?, soonCount? } for
 * logging/tests.
 */
async function sendWeeklyLabsDigest(db, now = new Date(), sendTelegramImpl = require('../notify').sendTelegram) {
  if (getKyivIsoWeekday(now) !== 1 || kyivHour(now) < 9) {
    return { sent: false, reason: 'not-monday-09' }
  }

  const week = isoWeekKey(now)
  const state = await db.collection('health_notify_state').findOne({ key: DIGEST_KEY })
  if (state && state.last_sent_iso_week === week) {
    return { sent: false, reason: 'already-sent-this-week' }
  }

  const { overdue, soon } = await fetchLabsReminders(db, now)
  if (overdue.length === 0 && soon.length === 0) {
    return { sent: false, reason: 'nothing-due' }
  }

  const ok = await sendTelegramImpl(formatMessage(overdue, soon))
  if (!ok) {
    console.warn('[labs-digest] sendTelegram returned false — will retry next tick')
    return { sent: false, reason: 'send-failed' }
  }

  await db.collection('health_notify_state').updateOne(
    { key: DIGEST_KEY },
    { $set: { key: DIGEST_KEY, last_sent_iso_week: week, last_sent_at: new Date().toISOString() } },
    { upsert: true }
  )
  return { sent: true, overdueCount: overdue.length, soonCount: soon.length }
}

module.exports = { sendWeeklyLabsDigest, isoWeekKey, formatMessage, DIGEST_KEY }
