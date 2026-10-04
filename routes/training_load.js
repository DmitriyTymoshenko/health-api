'use strict'

const { Router } = require('express')
const { formatDateKyiv } = require('../lib/training-program')
const { MUSCLE_GROUPS } = require('../lib/exercise-dictionaries')
const { exerciseNamesFromWorkouts } = require('../lib/volume-by-muscle')
const { deriveWorkoutMetrics } = require('../lib/workout-metrics')
const { buildPrFeed } = require('../lib/pr-feed')
const { buildWorkingWeights } = require('../lib/working-weights')
const { buildWeeklySets, buildLoadRecovery, buildProgramAdherence, addDays } = require('../lib/training-load')

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

      const [allWorkouts, whoopWorkouts90, recovery28] = await Promise.all([
        // ALL history: the PR feed needs the previous best, not just the last 90d
        db.collection('workouts').find({ date: { $lte: today } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_workouts').find({ date: { $gte: from90, $lte: today } }).toArray(),
        db.collection('whoop_recovery').find({ date: { $gte: from28, $lte: today } }).toArray(),
      ])

      const metricWorkouts = await deriveWorkoutMetrics(db, allWorkouts)
      const workouts90 = metricWorkouts.filter((w) => w.date >= from90)
      const names = exerciseNamesFromWorkouts(metricWorkouts)
      const library = names.length
        ? await db.collection('exercises_library').find({ name: { $in: names } }).toArray()
        : []
      const libraryByName = new Map(library.map((e) => [String(e.name || '').toLowerCase(), e]))

      // read-only: never seeds/writes the program (routes/training_program.js owns that)
      const program = await db.collection('training_programs').findOne({ is_active: true }, { sort: { version: -1 } })
      const weekly = buildWeeklySets({ workouts90, libraryByName, today, muscleOrder: MUSCLE_GROUPS, periodization: program && program.periodization })

      res.json({
        date: today,
        ...weekly,
        prs: buildPrFeed(metricWorkouts, { from: from90, library }),
        // #1727 п.2: working weight per session over the last 90d
        working_weights: buildWorkingWeights(metricWorkouts, { from: from90, library }),
        program_adherence: buildProgramAdherence({ program, workouts90, whoopWorkouts90, today, weekFrom: weekly.week.from, weekTo: weekly.week.to }),
        load_recovery: buildLoadRecovery({ today, whoopWorkouts90, recovery28, workouts90 }),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
