const { Router } = require('express')
const { todayKyiv, isValidKyivDayFormat } = require('../lib/kyiv-day')
const { computeFreeWindows, normalizeEvents } = require('../lib/life-today')

// #1601 (SPEC §11.6) — calendar snapshot pushed by Lisa (server-side Google
// OAuth is dead: invalid_grant). One doc per Kyiv day (upsert). Titles only —
// no attendees/descriptions are accepted. free_windows computed HERE.
module.exports = function (getDB) {
  const router = Router()

  // PUT /api/life/calendar-snapshot — {day?, events:[{start,end,title,all_day?}]}
  router.put('/calendar-snapshot', async (req, res) => {
    try {
      const body = req.body || {}
      const day = body.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const allowed = new Set(['day', 'events'])
      const extra = Object.keys(body).filter((k) => !allowed.has(k))
      if (extra.length) return res.status(400).json({ error: `Unknown fields: ${extra.join(', ')}` })
      const norm = normalizeEvents(body.events)
      if (norm.error) return res.status(400).json({ error: norm.error })
      const doc = {
        day,
        fetched_at: new Date(),
        source: 'lisa',
        events: norm.events,
        free_windows: computeFreeWindows(norm.events, day),
      }
      const saved = await getDB().collection('life_calendar_snapshots').findOneAndUpdate(
        { day },
        { $set: doc },
        { upsert: true, returnDocument: 'after' }
      )
      res.json(saved)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
