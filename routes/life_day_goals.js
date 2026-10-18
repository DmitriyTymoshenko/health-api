const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { validateBody } = require('../lib/life-contracts')
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
  // One health-api process owns these routes. Serialize mutations so concurrent
  // requests cannot each claim the last focus slot (create, move and update).
  let tail = Promise.resolve()
  router.use(async (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next()
    const previous = tail
    let release
    tail = new Promise((resolve) => { release = resolve })
    await previous
    if (res.destroyed) { release(); return }
    res.once('finish', release)
    res.once('close', release)
    next()
  })

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
  router.post('/day-goals', validateBody('DayGoalCreateRequest'), requireFields('text'), async (req, res) => {
    try {
      const day = req.body.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      if (typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 1000) return res.status(400).json({ error: 'Text must be 1..1000 characters' })
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
      let project = null, inbox = null
      if (req.body.project_id) {
        const id = toObjectId(req.body.project_id)
        project = id && await db.collection('life_plans').findOne({ _id: id })
        if (!project || project.status !== 'active') return res.status(400).json({ error: 'Оберіть активну ціль, проєкт або навичку' })
      }
      if (req.body.inbox_id) {
        const id = toObjectId(req.body.inbox_id)
        inbox = id && await db.collection('life_inbox').findOne({ _id: id })
        if (!inbox) return res.status(400).json({ error: 'Запис не знайдено' })
        const existing = await db.collection('life_day_goals').findOne({ inbox_id: String(id) })
        if (existing) {
          await db.collection('life_inbox').findOneAndUpdate({ _id: id }, { $set: { status: 'planned', day_goal_id: String(existing._id) } })
          return res.status(201).json(existing)
        }
        if (inbox.status !== 'inbox') return res.status(400).json({ error: 'Запис уже опрацьовано' })
      }
      if (project) {
        const existing = await db.collection('life_day_goals').findOne({ project_id: String(project._id), day, text: req.body.text.trim(), done: false })
        if (existing) return res.status(201).json(existing)
      }
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
        text: req.body.text.trim(),
        outcome: typeof req.body.outcome === 'string' ? req.body.outcome.trim().slice(0, 1000) : null,
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
        project_id: project ? String(project._id) : null,
        project_title: project?.title || null,
        inbox_id: inbox ? String(inbox._id) : null,
        estimate_minutes: req.body.estimate_minutes ?? null,
      }
      const result = await db.collection('life_day_goals').insertOne(doc)
      if (inbox) await db.collection('life_inbox').findOneAndUpdate({ _id: inbox._id }, { $set: { status: 'planned', day_goal_id: String(result.insertedId) } })
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
  router.put('/day-goals/:id', validateBody('DayGoalUpdateRequest'), async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const set = {}
      const current = await db.collection('life_day_goals').findOne({ _id: id })
      if (!current) return res.status(404).json({ error: 'Not found' })
      if (req.body.text !== undefined) {
        if (typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 1000) return res.status(400).json({ error: 'Text must be 1..1000 characters' })
        set.text = req.body.text.trim()
      }
      if (req.body.outcome !== undefined) {
        if (req.body.outcome !== null && typeof req.body.outcome !== 'string') return res.status(400).json({ error: 'Outcome must be text or null' })
        set.outcome = req.body.outcome?.trim().slice(0, 1000) || null
      }
      if (req.body.focus !== undefined) {
        if (typeof req.body.focus !== 'boolean') return res.status(400).json({ error: 'Focus must be boolean' })
        set.focus = req.body.focus
        if (set.focus && !current.focus) {
          const existing = await db.collection('life_day_goals').find({ day: current.day, focus: true }).toArray()
          if (existing.length >= MAX_FOCUS_PER_DAY) return res.status(400).json({ error: 'Max 3 focus goals per day' })
          set.focus_rank = [1, 2, 3].find((rank) => !existing.some((g) => g.focus_rank === rank))
          set.confirmed_at = new Date()
          set.proposed_by = null
        } else if (!set.focus) {
          set.focus_rank = null
          set.confirmed_at = null
          set.proposed_by = null
          set.proposed_at = null
        }
      }
      if (req.body.estimate_minutes !== undefined) set.estimate_minutes = req.body.estimate_minutes
      if (req.body.done !== undefined) {
        set.done = !!req.body.done
        set.done_at = set.done ? (current.done_at || new Date()) : null
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
