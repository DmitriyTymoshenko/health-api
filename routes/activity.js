const { Router } = require('express')
const { requireFields, validateDate } = require('../lib/validate')

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

  // GET /api/activity/today
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date().toISOString().split('T')[0]
      const entries = await db.collection('activity_log')
        .find({ date: today })
        .sort({ created_at: -1 })
        .toArray()
      res.json(entries)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/activity
  // #1297: requireFields('type') — `activity_log` has ZERO live documents
  // (verified live Mongo `countDocuments()` == 0), so there is no historical
  // shape to match and no live caller to break; `type` is the minimum a
  // meaningful activity record needs (matches the `type` field used on the
  // separate `/api/activity-plan` collection's entries, e.g. `type: 'gym'`).
  router.post('/', requireFields('type'), validateDate, async (req, res) => {
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
