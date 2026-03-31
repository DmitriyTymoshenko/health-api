const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/goals
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const data = await db.collection('goals').find({}).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/goals
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      doc.created_at = new Date()

      const result = await db.collection('goals').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/goals/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const doc = req.body
      delete doc._id
      doc.updated_at = new Date()

      const result = await db.collection('goals').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: doc },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/goals/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      await db.collection('goals').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
