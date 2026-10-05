const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { requireFields } = require('../lib/validate')
const { todayKyiv, addDaysToKyivDay, isValidKyivDayFormat } = require('../lib/kyiv-day')
const { MAX_FOCUS_PER_DAY } = require('../lib/life-today')

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

  // POST /api/life/day-goals — {day?, text, source?, focus?, focus_rank?, proposed_by?}.
  // #1601 (SPEC §11.1): ≤3 `focus:true` docs per day — the 4th → 400. A focus
  // goal proposed by Lisa is stored UNCONFIRMED (confirmed_at:null) until one tap.
  router.post('/day-goals', requireFields('text'), async (req, res) => {
    try {
      const day = req.body.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const focus = req.body.focus === true
      let focusRank = null
      if (req.body.focus_rank !== undefined && req.body.focus_rank !== null) {
        if (![1, 2, 3].includes(req.body.focus_rank)) {
          return res.status(400).json({ error: 'focus_rank must be 1, 2 or 3' })
        }
        focusRank = req.body.focus_rank
      }
      if (req.body.proposed_by !== undefined && req.body.proposed_by !== null && req.body.proposed_by !== 'lisa') {
        return res.status(400).json({ error: 'proposed_by must be "lisa" or null' })
      }
      const db = getDB()
      const proposedByLisa = req.body.proposed_by === 'lisa'
      if (focus) {
        const existing = await db.collection('life_day_goals').find({ day, focus: true }).toArray()
        if (existing.length >= MAX_FOCUS_PER_DAY) {
          return res.status(400).json({ error: `Max ${MAX_FOCUS_PER_DAY} focus goals per day` })
        }
        if (focusRank === null) {
          const used = new Set(existing.map((g) => g.focus_rank))
          focusRank = [1, 2, 3].find((r) => !used.has(r)) || null
        }
      } else {
        focusRank = null
      }
      const now = new Date()
      const doc = {
        day,
        text: req.body.text,
        done: false,
        done_at: null,
        created_at: now,
        source: req.body.source === 'lisa' ? 'lisa' : 'dashboard',
        focus,
        focus_rank: focusRank,
        proposed_by: focus && proposedByLisa ? 'lisa' : null,
        proposed_at: focus && proposedByLisa ? now : null,
        // Dashboard-created focus is confirmed by the act of creating it; a Lisa proposal waits for the tap.
        confirmed_at: focus && !proposedByLisa ? now : null,
        goal_id: null,
      }
      const result = await db.collection('life_day_goals').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/life/day-goals/confirm-focus — {day?}: ONE tap confirms every
  // still-proposed focus goal of the day (#1601). Idempotent.
  router.post('/day-goals/confirm-focus', async (req, res) => {
    try {
      const day = (req.body && req.body.day) || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const db = getDB()
      const focus = await db.collection('life_day_goals').find({ day, focus: true }).toArray()
      const pending = focus.filter((g) => !g.confirmed_at)
      const now = new Date()
      for (const g of pending) {
        await db.collection('life_day_goals').findOneAndUpdate({ _id: g._id }, { $set: { confirmed_at: now } })
      }
      res.json({ day, confirmed: pending.length, focus_total: focus.length })
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
      // 3-focus cap applies on the TARGET day too: a focus goal moved onto a
      // full day is demoted to a regular goal (carryover must not fail).
      const set = { day: toDay }
      if (doc.focus === true && toDay !== doc.day) {
        const existing = await db.collection('life_day_goals').find({ day: toDay, focus: true }).toArray()
        if (existing.length >= MAX_FOCUS_PER_DAY) {
          set.focus = false
          set.focus_rank = null
        } else {
          const used = new Set(existing.map((g) => g.focus_rank))
          if (!doc.focus_rank || used.has(doc.focus_rank)) {
            set.focus_rank = [1, 2, 3].find((r) => !used.has(r)) || null
          }
        }
      }
      const result = await db.collection('life_day_goals').findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' }
      )
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
