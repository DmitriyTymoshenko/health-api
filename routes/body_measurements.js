const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/body_measurements/latest
  router.get('/latest', async (req, res) => {
    try {
      const db = getDB()
      const doc = await db.collection('body_measurements')
        .findOne({}, { sort: { date: -1 } })
      res.json(doc || null)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/body_measurements?limit=N
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const limit = parseInt(req.query.limit) || 50
      const data = await db.collection('body_measurements')
        .find({})
        .sort({ date: -1 })
        .limit(limit)
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/body_measurements
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      doc.created_at = new Date()
      const result = await db.collection('body_measurements').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/body_measurements/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const update = { ...req.body, updated_at: new Date() }
      const result = await db.collection('body_measurements').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: update }
      )
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' })
      const updated = await db.collection('body_measurements').findOne({ _id: new ObjectId(req.params.id) })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/body_measurements/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('body_measurements').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
