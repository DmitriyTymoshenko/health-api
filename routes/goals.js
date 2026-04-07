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

  // GET /api/goals/streaks — calculate streaks for all habits
  router.get('/streaks', async (req, res) => {
    try {
      const db = getDB()

      // Load goals for thresholds
      const goalsData = await db.collection('goals').find({}).toArray()
      const caloriesGoal = goalsData.find(g => g.type === 'calories')
      const proteinGoal = goalsData.find(g => g.type === 'protein')
      const waterGoal = goalsData.find(g => g.type === 'water')

      const goals = {
        calories_limit: caloriesGoal?.target_value || 2200,
        protein_min: proteinGoal?.target_value || 180,
        water_min_ml: waterGoal?.target_value || 2500,
        steps_min: 10000,
        supplements_count: 8,
      }

      // Generate last 90 days
      const days = []
      for (let i = 0; i < 90; i++) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        days.push(d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' }))
      }
      const fromDate = days[days.length - 1]
      const toDate = days[0]

      // Fetch all data in parallel
      const [weights, nutritionLogs, waterLogs, stepsLogs, intakeLogs, supplements] = await Promise.all([
        db.collection('weight_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('nutrition_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('water_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('steps').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('supplement_intake').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('supplement_catalog').find({ active: true }).toArray(),
      ])

      // Build lookup maps
      const weightDates = new Set(weights.map(w => w.date))

      const nutritionByDay = {}
      for (const n of nutritionLogs) {
        if (!nutritionByDay[n.date]) nutritionByDay[n.date] = { kcal: 0, protein: 0 }
        nutritionByDay[n.date].kcal += n.kcal || 0
        nutritionByDay[n.date].protein += (n.protein_g || n.protein || 0)
      }

      const waterByDay = {}
      for (const w of waterLogs) {
        waterByDay[w.date] = (waterByDay[w.date] || 0) + (w.amount_ml || 0)
      }

      const stepsMap = {}
      for (const s of stepsLogs) {
        stepsMap[s.date] = s.steps || 0
      }

      const activeSupIds = new Set(supplements.map(s => s.id))
      const intakeByDay = {}
      for (const i of intakeLogs) {
        if (!intakeByDay[i.date]) intakeByDay[i.date] = new Set()
        if (i.taken && activeSupIds.has(i.supplement_id)) {
          intakeByDay[i.date].add(i.supplement_id)
        }
      }

      // Calculate streak for each habit
      function calcStreak(checkFn) {
        let current = 0
        let best = 0
        let counting = true

        for (const day of days) {
          if (checkFn(day)) {
            if (counting) current++
            best = Math.max(best, counting ? current : 0)
          } else {
            if (counting && current > 0) {
              best = Math.max(best, current)
            }
            counting = false
          }
        }

        // Recalculate best by scanning all consecutive runs
        let run = 0
        for (const day of days.slice().reverse()) {
          if (checkFn(day)) {
            run++
            best = Math.max(best, run)
          } else {
            run = 0
          }
        }

        return { current, best }
      }

      const streaks = {
        weight: calcStreak(d => weightDates.has(d)),
        calories: calcStreak(d => {
          const n = nutritionByDay[d]
          return n && n.kcal > 0 && n.kcal <= goals.calories_limit
        }),
        protein: calcStreak(d => {
          const n = nutritionByDay[d]
          return n && n.protein >= goals.protein_min
        }),
        water: calcStreak(d => (waterByDay[d] || 0) >= goals.water_min_ml),
        steps: calcStreak(d => (stepsMap[d] || 0) >= goals.steps_min),
        supplements: calcStreak(d => {
          const taken = intakeByDay[d]
          return taken && taken.size >= activeSupIds.size && activeSupIds.size > 0
        }),
      }

      // Overall streak: all habits met on that day
      const overall = calcStreak(d => {
        return weightDates.has(d) &&
          (nutritionByDay[d]?.kcal > 0 && nutritionByDay[d]?.kcal <= goals.calories_limit) &&
          (nutritionByDay[d]?.protein >= goals.protein_min) &&
          ((waterByDay[d] || 0) >= goals.water_min_ml) &&
          ((stepsMap[d] || 0) >= goals.steps_min)
      })

      res.json({ streaks, overall, goals })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
