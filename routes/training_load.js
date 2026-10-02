'use strict'

const { Router } = require('express')
const { formatDateKyiv } = require('../lib/training-program')
const { MUSCLE_GROUPS } = require('../lib/exercise-dictionaries')
const { exerciseNamesFromWorkouts } = require('../lib/volume-by-muscle')
const { buildWeeklySets, buildLoadRecovery, addDays } = require('../lib/training-load')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// #1693 Е1 — GET /api/workouts/training-load?date=YYYY-MM-DD
// Mounted on /api/workouts/training-load (own router: workouts.js untouched).
module.exports = function (getDB) {
  const router = Router()

  router.get('/training-load', async (req, res) => {
    try {
      const db = getDB()
      const today = req.query.date || formatDateKyiv(new Date())
      if (!DATE_RE.test(today)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
      const from90 = addDays(today, -89)
      const from28 = addDays(today, -27)

      const [workouts90, whoopWorkouts90, recovery28] = await Promise.all([
        db.collection('workouts').find({ date: { $gte: from90, $lte: today } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_workouts').find({ date: { $gte: from90, $lte: today } }).toArray(),
        db.collection('whoop_recovery').find({ date: { $gte: from28, $lte: today } }).toArray(),
      ])

      const names = exerciseNamesFromWorkouts(workouts90)
      const library = names.length
        ? await db.collection('exercises_library').find({ name: { $in: names } }).toArray()
        : []
      const libraryByName = new Map(library.map((e) => [String(e.name || '').toLowerCase(), e]))

      res.json({
        date: today,
        ...buildWeeklySets({ workouts90, libraryByName, today, muscleOrder: MUSCLE_GROUPS }),
        load_recovery: buildLoadRecovery({ today, whoopWorkouts90, recovery28, workouts90 }),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
