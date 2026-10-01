const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { requireFields } = require('../lib/validate')
const { todayKyiv, addDaysToKyivDay, isValidKyivDayFormat } = require('../lib/kyiv-day')

// #1519 (SPEC #1518 §3/§6) — day goals (`life_day_goals`): add / close / move
// to tomorrow / list for a day. MVP explicitly carries NO history (scope item
// 4 / SPEC Q4) — "move" mutates the `day` field on the SAME doc, repeatedly
// if needed.

function toObjectId(id) {
  if (!ObjectId.isValid(id)) return null
  return new ObjectId(id)
}

module.exports = function (getDB) {
  const router = Router()

  // GET /api/life/day-goals?day= — defaults to today (Kyiv).
  router.get('/day-goals', async (req, res) => {
    try {
      const day = req.query.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const db = getDB()
      const data = await db.collection('life_day_goals').find({ day }).sort({ created_at: 1 }).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/life/day-goals — {day?, text, source?}; day defaults to today.
  router.post('/day-goals', requireFields('text'), async (req, res) => {
    try {
      const day = req.body.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const db = getDB()
      const doc = {
        day,
        text: req.body.text,
        done: false,
        done_at: null,
        created_at: new Date(),
        source: req.body.source === 'lisa' ? 'lisa' : 'dashboard',
      }
      const result = await db.collection('life_day_goals').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/life/day-goals/:id — {done?, text?}.
  router.put('/day-goals/:id', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const set = {}
      if (req.body.text !== undefined) set.text = req.body.text
      if (req.body.done !== undefined) {
        set.done = !!req.body.done
        set.done_at = set.done ? new Date() : null
      }
      const result = await db.collection('life_day_goals').findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/life/day-goals/:id/move — {to_day?} default day+1; mutates
  // `day` in place (no history — SPEC Q4 default, allowed repeatedly).
  router.post('/day-goals/:id/move', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const doc = await db.collection('life_day_goals').findOne({ _id: id })
      if (!doc) return res.status(404).json({ error: 'Not found' })

      const toDay = req.body.to_day || addDaysToKyivDay(doc.day, 1)
      if (!isValidKyivDayFormat(toDay)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const result = await db.collection('life_day_goals').findOneAndUpdate(
        { _id: id },
        { $set: { day: toDay } },
        { returnDocument: 'after' }
      )
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
