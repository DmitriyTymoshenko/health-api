const { Router } = require('express')
const {
  formatDateKyiv,
  getKyivIsoWeekday,
  computeCurrentWeek,
  phaseForWeek,
  resolveScheduledDayKey,
  SEED_TRAINING_PROGRAM,
} = require('../lib/training-program')

module.exports = function (getDB) {
  const router = Router()
  const COLLECTION = 'training_programs'

  // Auto-seed on first read, same convention as GET /api/workouts/exercises
  // (routes/workouts.js): an empty collection seeds itself instead of 404-ing forever.
  async function getActiveProgram(db) {
    const col = db.collection(COLLECTION)
    let active = await col.findOne({ is_active: true }, { sort: { version: -1 } })
    if (!active) {
      const doc = {
        ...SEED_TRAINING_PROGRAM,
        periodization: {
          ...SEED_TRAINING_PROGRAM.periodization,
          start_date: SEED_TRAINING_PROGRAM.periodization.start_date || formatDateKyiv(new Date()),
        },
        version: 1,
        is_active: true,
        created_at: new Date(),
      }
      const result = await col.insertOne(doc)
      active = { ...doc, _id: result.insertedId }
    }
    return active
  }

  function withWeekInfo(program) {
    const today = formatDateKyiv(new Date())
    const currentWeek = computeCurrentWeek(
      program.periodization?.start_date,
      program.periodization?.wave_weeks,
      today
    )
    const phase = phaseForWeek(program.periodization?.phases, currentWeek)
    return { ...program, current_week: currentWeek, current_phase: phase }
  }

  // GET /api/training-program — active program (auto-seeds if none exists yet)
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const active = await getActiveProgram(db)
      res.json(withWeekInfo(active))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/training-program — save/replace (versioned; old version kept, not deleted)
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const col = db.collection(COLLECTION)
      const body = req.body || {}
      if (!Array.isArray(body.days) || body.days.length === 0) {
        return res.status(400).json({ error: 'days (non-empty array) required' })
      }

      const current = await col.findOne({ is_active: true }, { sort: { version: -1 } })
      const nextVersion = (current?.version || 0) + 1

      if (current) {
        await col.updateOne({ _id: current._id }, { $set: { is_active: false } })
      }

      const doc = {
        name: body.name || SEED_TRAINING_PROGRAM.name,
        periodization: {
          wave_weeks: body.periodization?.wave_weeks ?? SEED_TRAINING_PROGRAM.periodization.wave_weeks,
          phases: body.periodization?.phases ?? SEED_TRAINING_PROGRAM.periodization.phases,
          start_date: body.periodization?.start_date || formatDateKyiv(new Date()),
        },
        schedule: body.schedule || SEED_TRAINING_PROGRAM.schedule,
        days: body.days,
        version: nextVersion,
        is_active: true,
        created_at: new Date(),
      }
      const result = await col.insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/training-program/today — the scheduled day for today (Kyiv calendar day)
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const active = await getActiveProgram(db)
      const now = new Date()
      const todayStr = formatDateKyiv(now)
      const isoWeekday = getKyivIsoWeekday(now)
      const dayKey = resolveScheduledDayKey(active.schedule, isoWeekday)

      if (!dayKey) {
        return res.json({
          scheduled: false,
          date: todayStr,
          message: 'Сьогодні не тренувальний день за розкладом',
        })
      }

      const day = (active.days || []).find(d => d.key === dayKey)
      if (!day) {
        return res.status(500).json({
          error: `schedule points to day key "${dayKey}" but no such day exists in the active program`,
        })
      }

      const withWeek = withWeekInfo(active)
      res.json({
        scheduled: true,
        date: todayStr,
        day_key: dayKey,
        day,
        week: withWeek.current_week,
        phase: withWeek.current_phase,
        wave_weeks: active.periodization?.wave_weeks,
        program_name: active.name,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
