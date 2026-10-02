const { Router } = require('express')
const { requireAnyField, validateDate } = require('../lib/validate')
const { todayKyiv, addDaysToKyivDay } = require('../lib/kyiv-day')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/metrics - all metrics (paginated)
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { skip = 0 } = req.query
      let limit = req.query.limit === undefined ? 30 : req.query.limit
      // #1640: honour ?days=N (clamp 1..365, pattern of nutrition.js /frequent).
      // Absent/invalid days => no date filter, behaviour unchanged (limit 30).
      const filter = {}
      if (req.query.days !== undefined) {
        const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
        if (req.query.limit === undefined) limit = days // one doc per day
        filter.date = { $gte: addDaysToKyivDay(todayKyiv(), -(days - 1)) }
      }
      const data = await db.collection('daily_metrics')
        .find(filter)
        .sort({ date: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/metrics
  // #1297: requireAnyField over the real WHOOP metric columns (live sample,
  // `daily_metrics` sorted by `_id` desc). `scripts/sync-whoop.js` writes this
  // collection directly via the Mongo driver (bypassing this HTTP route
  // entirely) — this route itself has no confirmed live HTTP caller, so this
  // only rejects a genuinely empty POST, matching the acceptance criterion.
  router.post(
    '/',
    requireAnyField(
      'recovery_score',
      'strain',
      'sleep_hours',
      'sleep_performance',
      'avg_heart_rate',
      'resting_heart_rate',
      'calories_burned',
      'hrv_rmssd'
    ),
    validateDate,
    async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = todayKyiv()
      doc.created_at = new Date()

      const result = await db.collection('daily_metrics').findOneAndUpdate(
        { date: doc.date },
        { $set: doc },
        { upsert: true, returnDocument: 'after' }
      )
      res.status(201).json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/metrics/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('daily_metrics').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { ...req.body, updated_at: new Date() } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/metrics/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('daily_metrics').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
