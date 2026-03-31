const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/supplements
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date } = req.query
      const filter = date ? { date } : {}
      const data = await db.collection('supplements_log')
        .find(filter)
        .sort({ date: -1, timing: 1 })
        .limit(100)
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/supplements/today
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date().toISOString().split('T')[0]
      const data = await db.collection('supplements_log')
        .find({ date: today })
        .sort({ timing: 1 })
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/supplements
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      if (doc.taken === undefined) doc.taken = false

      const result = await db.collection('supplements_log').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/supplements/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('supplements_log').findOneAndUpdate(
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

  // PATCH /api/supplements/:id - toggle taken
  router.patch('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const { taken } = req.body
      const result = await db.collection('supplements_log').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { taken } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/supplements/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('supplements_log').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
