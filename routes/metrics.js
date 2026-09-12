const { Router } = require('express')
const { requireAnyField, validateDate } = require('../lib/validate')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/metrics - all metrics (paginated)
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { limit = 30, skip = 0 } = req.query
      const data = await db.collection('daily_metrics')
        .find({})
        .sort({ date: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/metrics/today
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date().toISOString().split('T')[0]
      const data = await db.collection('daily_metrics').findOne({ date: today })
      res.json(data || {})
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/metrics/range?from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get('/range', async (req, res) => {
    try {
      const db = getDB()
      const { from, to } = req.query
      if (!from || !to) return res.status(400).json({ error: 'from and to required' })
      const data = await db.collection('daily_metrics')
        .find({ date: { $gte: from, $lte: to } })
        .sort({ date: 1 })
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
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
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
