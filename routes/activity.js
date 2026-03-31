const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/activity?date=YYYY-MM-DD
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date } = req.query
      const query = date ? { date } : {}
      const entries = await db.collection('activity_log')
        .find(query)
        .sort({ created_at: -1 })
        .limit(50)
        .toArray()
      res.json(entries)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/activity
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = {
        ...req.body,
        date: req.body.date || new Date().toISOString().split('T')[0],
        created_at: new Date(),
      }
      const result = await db.collection('activity_log').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/activity/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('activity_log').findOneAndUpdate(
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

  // DELETE /api/activity/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      await db.collection('activity_log').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
