const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/notes
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date, tag, limit = 20, skip = 0 } = req.query
      const filter = {}
      if (date) filter.date = date
      if (tag) filter.tags = tag

      const data = await db.collection('notes')
        .find(filter)
        .sort({ date: -1, created_at: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/notes
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      if (!doc.tags) doc.tags = []
      doc.created_at = new Date()

      const result = await db.collection('notes').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/notes/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('notes').findOneAndUpdate(
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

  // DELETE /api/notes/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      await db.collection('notes').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
