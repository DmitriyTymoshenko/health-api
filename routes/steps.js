const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/steps?date=YYYY-MM-DD
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date } = req.query
      const filter = date ? { date } : {}
      const data = await db.collection('steps_log')
        .find(filter)
        .sort({ date: -1 })
        .limit(60)
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/steps — from iPhone Shortcut
  // Body: { date, steps, source? }
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const { date, steps, source = 'apple_health' } = req.body
      if (!date || steps == null) return res.status(400).json({ error: 'date and steps required' })

      const doc = {
        date,
        steps: Math.round(Number(steps)),
        source,
        synced_at: new Date().toISOString(),
      }

      // Upsert by date
      await db.collection('steps_log').updateOne(
        { date },
        { $set: doc },
        { upsert: true }
      )

      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/steps/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('steps_log').findOneAndUpdate(
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

  // DELETE /api/steps/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('steps_log').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
