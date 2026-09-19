const { Router } = require('express')
const { buildExerciseTrends } = require('../lib/exercise-trends')
const { buildReadiness } = require('../lib/readiness')
const { formatDateKyiv, getKyivIsoWeekday, resolveScheduledDayKey } = require('../lib/training-program')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HISTORY_WINDOW_DAYS = 6 // trailing days before the target, on top of the target itself — comfortably
// covers the owner's 2-consecutive-day streak rule (YELLOW_RED_STREAK_FOR_BASE_ONLY) with margin.

/** @param {string} dateStr YYYY-MM-DD @param {number} days @returns {string} dateStr - days, YYYY-MM-DD */
function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

module.exports = function (getDB) {
  const router = Router()

  // GET /api/readiness?date=YYYY-MM-DD — task #1292 (Ф3). Combines two independent
  // signals (recovery zone + exercise-trend stagnation, REUSE not re-derive — see
  // lib/readiness.js header) into one badge, taking the LOWER (owner rule, 09.09).
  // `date` is optional, for controlled-date inspection/testing (same convention as
  // GET /api/training-program/today); default = today, Kyiv calendar day.
  router.get('/', async (req, res) => {
    try {
      const db = getDB()

      let dateStr
      if (req.query.date !== undefined) {
        if (!DATE_RE.test(req.query.date)) {
          return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
        }
        dateStr = req.query.date
      } else {
        dateStr = formatDateKyiv(new Date())
      }

      const recoveryDoc = await db.collection('whoop_recovery').findOne({ date: dateStr })

      // Night boundaries for the sleep the recovery score is FROM. Resolved via
      // sleep_id -> whoop_sleep (post-#1296: whoop_recovery.date is the WAKE day,
      // not a fixed date-offset from the night — #1324 lesson: no safe constant
      // offset exists, so this NEVER derives the night from dateStr arithmetic).
      let sleepWindow = null
      if (recoveryDoc?.sleep_id) {
        const sleepDoc = await db.collection('whoop_sleep').findOne({ sleep_id: recoveryDoc.sleep_id })
        if (sleepDoc) sleepWindow = { start: sleepDoc.start, end: sleepDoc.end }
      }

      const historyFromStr = subtractDays(dateStr, HISTORY_WINDOW_DAYS)
      const recoveryHistoryDocs = await db
        .collection('whoop_recovery')
        .find({ date: { $gte: historyFromStr, $lte: dateStr } })
        .toArray()
      const recoveryHistory = recoveryHistoryDocs.map((r) => ({ date: r.date, recovery_score: r.recovery_score }))

      // Signal B input — REUSE the #1417 aggregator over the full workouts journal
      // (same shape/defaults as GET /api/workouts/exercise-trends), then narrow to
      // today's program-day exercises inside lib/readiness.js.
      const workouts = await db
        .collection('workouts')
        .find({}, { projection: { date: 1, exercises: 1 } })
        .sort({ date: 1 })
        .toArray()
      const exerciseTrends = buildExerciseTrends({ workouts, todayStr: dateStr })

      // Today's program-day exercise list — read-only lookup, mirrors
      // GET /api/training-program/today's day-resolution but never auto-seeds (that
      // side effect belongs to the training-program route alone).
      const activeProgram = await db
        .collection('training_programs')
        .findOne({ is_active: true }, { sort: { version: -1 } })
      let dayKey = null
      let todayExercises = []
      if (activeProgram) {
        const isoWeekday = getKyivIsoWeekday(new Date(dateStr + 'T12:00:00.000Z'))
        dayKey = resolveScheduledDayKey(activeProgram.schedule, isoWeekday)
        if (dayKey) {
          const day = (activeProgram.days || []).find((d) => d.key === dayKey)
          todayExercises = day?.exercises || []
        }
      }

      const readiness = buildReadiness({
        recoveryToday: recoveryDoc ? { date: recoveryDoc.date, recovery_score: recoveryDoc.recovery_score } : null,
        recoveryHistory,
        exerciseTrends,
        todayExercises,
        todayStr: dateStr,
        sleepWindow,
      })

      res.json({ date: dateStr, day_key: dayKey, ...readiness })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
