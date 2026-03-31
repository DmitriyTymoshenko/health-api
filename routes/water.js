const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/water
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date } = req.query
      const filter = date ? { date } : {}
      const data = await db.collection('water_log')
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/water/today
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date().toISOString().split('T')[0]
      const data = await db.collection('water_log')
        .find({ date: today })
        .sort({ timestamp: 1 })
        .toArray()

      const total_ml = data.reduce((sum, e) => sum + (e.amount_ml || 0), 0)
      res.json({ date: today, total_ml, entries: data })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/water
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      if (!doc.timestamp) doc.timestamp = new Date()
      else doc.timestamp = new Date(doc.timestamp)

      const result = await db.collection('water_log').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/water/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('water_log').findOneAndUpdate(
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

  // DELETE /api/water/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('water_log').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
