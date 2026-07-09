const { Router } = require('express')
const { ObjectId } = require('mongodb')

module.exports = function (getDB) {
  const router = Router()

  // ─── NEW: /api/supplements/log — grouped daily tracker ──────────────────────

  // GET /api/supplements/log?date=YYYY-MM-DD
  // Returns all active supplements grouped by schedule with taken status
  router.get('/log', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || new Date().toISOString().split('T')[0]

      // Ensure catalog is seeded (reuse ensureSeed logic inline)
      const catalogCount = await db.collection('supplement_catalog').countDocuments()
      if (catalogCount === 0) {
        const { DEFAULT_SUPPLEMENTS } = require('./supplement_catalog_defaults')
        if (DEFAULT_SUPPLEMENTS) {
          await db.collection('supplement_catalog').insertMany(DEFAULT_SUPPLEMENTS)
        }
      }

      // Fetch all active supplements
      const supplements = await db.collection('supplement_catalog')
        .find({ active: { $ne: false } })
        .sort({ schedule: 1, id: 1 })
        .toArray()

      // Fetch intake records for this date
      const intakeRecords = await db.collection('supplement_intake')
        .find({ date })
        .toArray()

      // Build lookup: supplement_id (number) → intake record
      const intakeMap = {}
      for (const rec of intakeRecords) {
        intakeMap[Number(rec.supplement_id)] = rec
      }

      // Group by schedule
      const SCHEDULE_ORDER = ['morning', 'pre_meal', 'pre_workout', 'evening']
      const groups = {}
      for (const slot of SCHEDULE_ORDER) {
        groups[slot] = []
      }

      let totalTaken = 0
      for (const supp of supplements) {
        const slot = supp.schedule || 'morning'
        if (!groups[slot]) groups[slot] = []
        const intake = intakeMap[Number(supp.id)]
        const taken = !!intake
        if (taken) totalTaken++
        groups[slot].push({
          _id: supp._id ? supp._id.toString() : String(supp.id),
          catalog_id: supp.id,
          name: supp.short_name || supp.name,
          full_name: supp.name,
          dose: supp.dose || '',
          schedule: slot,
          taken,
          taken_at: intake ? intake.taken_at : null,
          log_id: intake ? intake._id.toString() : null,
          brand: supp.brand || '',
          notes: supp.notes || '',
        })
      }

      // Remove empty schedule groups
      for (const slot of SCHEDULE_ORDER) {
        if (groups[slot].length === 0) delete groups[slot]
      }

      res.json({
        date,
        groups,
        summary: {
          total: supplements.length,
          taken: totalTaken,
          missed: supplements.length - totalTaken,
        },
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/supplements/log
  // Toggle taken status for a supplement on a date
  // Body: { date, supplement_id, supplement_name, dose, schedule, taken: true/false }
  router.post('/log', async (req, res) => {
    try {
      const db = getDB()
      const { date, supplement_id, supplement_name, dose, schedule, taken } = req.body
      const sid = Number(supplement_id)
      const logDate = date || new Date().toISOString().split('T')[0]

      if (taken) {
        // Upsert: insert if not exists, update taken_at if exists
        const existing = await db.collection('supplement_intake').findOne({
          supplement_id: sid,
          date: logDate,
        })
        if (existing) {
          // Already taken — update taken_at
          const updated = await db.collection('supplement_intake').findOneAndUpdate(
            { _id: existing._id },
            { $set: { taken_at: new Date().toISOString() } },
            { returnDocument: 'after' }
          )
          return res.json({
            log_id: updated._id.toString(),
            supplement_id: sid,
            supplement_name: supplement_name || existing.supplement_name || '',
            date: logDate,
            schedule: schedule || existing.schedule || 'morning',
            taken: true,
            taken_at: updated.taken_at,
          })
        } else {
          const doc = {
            supplement_id: sid,
            supplement_name: supplement_name || '',
            dose: dose || '',
            schedule: schedule || 'morning',
            date: logDate,
            taken_at: new Date().toISOString(),
          }
          const result = await db.collection('supplement_intake').insertOne(doc)
          // Auto-decrement stock_remaining if tracked
          const supp = await db.collection('supplement_catalog').findOne({ id: sid })
          if (supp && supp.stock_remaining != null && supp.stock_remaining > 0) {
            await db.collection('supplement_catalog').updateOne(
              { id: sid },
              { $inc: { stock_remaining: -1 } }
            )
          }
          return res.status(201).json({
            log_id: result.insertedId.toString(),
            supplement_id: sid,
            supplement_name: supplement_name || '',
            date: logDate,
            schedule: schedule || 'morning',
            taken: true,
            taken_at: doc.taken_at,
          })
        }
      } else {
        // Remove intake record for this date + supplement
        await db.collection('supplement_intake').deleteOne({
          supplement_id: sid,
          date: logDate,
        })
        return res.json({
          log_id: null,
          supplement_id: sid,
          date: logDate,
          taken: false,
          taken_at: null,
        })
      }
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/supplements/log/:log_id
  // Remove a specific intake log entry by its _id
  router.delete('/log/:log_id', async (req, res) => {
    try {
      const db = getDB()
      let oid
      try {
        oid = new ObjectId(req.params.log_id)
      } catch {
        return res.status(400).json({ error: 'Invalid log_id' })
      }
      const result = await db.collection('supplement_intake').deleteOne({ _id: oid })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ─── END NEW ENDPOINTS ───────────────────────────────────────────────────────


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
