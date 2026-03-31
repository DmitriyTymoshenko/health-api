const { Router } = require('express')

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
  router.post('/', async (req, res) => {
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
