const { Router } = require('express')
const { ObjectId } = require('mongodb')

module.exports = function (getDB) {
  const router = Router()

  // ── HABIT DEFINITIONS ───────────────────────────────────────────────────

  // GET /api/habits — list all habit definitions
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const habits = await db.collection('habits')
        .find({})
        .sort({ order: 1, created_at: 1 })
        .toArray()
      res.json(habits)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/habits — create new habit
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const { name, icon, category, frequency, target_days, color, description } = req.body
      if (!name) return res.status(400).json({ error: 'name required' })

      const doc = {
        name,
        icon: icon || '✅',
        category: category || 'general',
        frequency: frequency || 'daily', // daily | weekly
        target_days: target_days || 7,   // days per week for weekly habits
        color: color || '#4CAF50',
        description: description || '',
        is_active: true,
        order: req.body.order || 0,
        created_at: new Date(),
      }
      const result = await db.collection('habits').insertOne(doc)
      res.json({ _id: result.insertedId, ...doc })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/habits/:id — update habit
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { _id, created_at, ...update } = req.body
      await db.collection('habits').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { ...update, updated_at: new Date() } }
      )
      const doc = await db.collection('habits').findOne({ _id: new ObjectId(req.params.id) })
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/habits/:id — delete habit
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      await db.collection('habits').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── HABIT LOGS ────────────────────────────────────────────────────────────

  // GET /api/habits/log?date=YYYY-MM-DD — get log for date
  router.get('/log', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || new Date().toISOString().slice(0, 10)
      const logs = await db.collection('habit_logs')
        .find({ date })
        .toArray()
      res.json(logs)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/habits/log/range?from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get('/log/range', async (req, res) => {
    try {
      const db = getDB()
      const { from, to } = req.query
      const query = {}
      if (from || to) {
        query.date = {}
        if (from) query.date.$gte = from
        if (to) query.date.$lte = to
      }
      const logs = await db.collection('habit_logs')
        .find(query)
        .sort({ date: -1 })
        .toArray()
      res.json(logs)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/habits/log — toggle habit completion
  router.post('/log', async (req, res) => {
    try {
      const db = getDB()
      const { habit_id, date, completed, note } = req.body
      if (!habit_id || !date) return res.status(400).json({ error: 'habit_id and date required' })

      const existing = await db.collection('habit_logs').findOne({ habit_id, date })

      if (existing) {
        await db.collection('habit_logs').updateOne(
          { habit_id, date },
          { $set: { completed: completed !== undefined ? completed : !existing.completed, note: note || existing.note, updated_at: new Date() } }
        )
        const updated = await db.collection('habit_logs').findOne({ habit_id, date })
        return res.json(updated)
      } else {
        const doc = {
          habit_id,
          date,
          completed: completed !== undefined ? completed : true,
          note: note || '',
          created_at: new Date(),
        }
        const result = await db.collection('habit_logs').insertOne(doc)
        return res.json({ _id: result.insertedId, ...doc })
      }
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/habits/streaks — calculate streaks for all habits
  router.get('/streaks', async (req, res) => {
    try {
      const db = getDB()
      const habits = await db.collection('habits').find({ is_active: true }).toArray()
      const logs = await db.collection('habit_logs')
        .find({ completed: true })
        .sort({ date: -1 })
        .toArray()

      const result = habits.map(habit => {
        const habitLogs = logs
          .filter(l => l.habit_id === String(habit._id))
          .map(l => l.date)
          .sort()
          .reverse()

        // Calculate current streak
        let streak = 0
        const today = new Date().toISOString().slice(0, 10)
        let checkDate = new Date()

        for (let i = 0; i < 365; i++) {
          const dateStr = checkDate.toISOString().slice(0, 10)
          if (habitLogs.includes(dateStr)) {
            streak++
            checkDate.setDate(checkDate.getDate() - 1)
          } else if (dateStr === today) {
            // today not done yet — still check yesterday
            checkDate.setDate(checkDate.getDate() - 1)
          } else {
            break
          }
        }

        // Best streak (last 90 days)
        const last90 = habitLogs.slice(0, 90)
        let bestStreak = 0
        let currentBest = 0
        let prevDate = null
        for (const dateStr of [...last90].reverse()) {
          if (!prevDate) {
            currentBest = 1
          } else {
            const diff = (new Date(dateStr) - new Date(prevDate)) / (1000 * 60 * 60 * 24)
            if (diff === 1) {
              currentBest++
            } else {
              currentBest = 1
            }
          }
          prevDate = dateStr
          if (currentBest > bestStreak) bestStreak = currentBest
        }

        // Completion rate last 7 days
        const last7 = []
        for (let i = 0; i < 7; i++) {
          const d = new Date()
          d.setDate(d.getDate() - i)
          last7.push(d.toISOString().slice(0, 10))
        }
        const done7 = last7.filter(d => habitLogs.includes(d)).length

        return {
          habit_id: String(habit._id),
          name: habit.name,
          icon: habit.icon,
          color: habit.color,
          current_streak: streak,
          best_streak: bestStreak,
          completion_7d: Math.round((done7 / 7) * 100),
          total_completions: habitLogs.length,
        }
      })

      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
