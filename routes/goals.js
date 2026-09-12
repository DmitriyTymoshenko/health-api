const { Router } = require('express')
// #1295 — /streaks used to fall back to its OWN hardcoded thresholds (calories_limit
// 2200, protein_min via the plain proteinGoalG() ignoring an explicit profile override,
// water_min_ml 2500) whenever the `goals` collection had no matching type. Those
// fallbacks now come from the SAME resolver every other target-facing route reads, so a
// day judged "on streak" here can never disagree with what /nutrition/summary or
// /recommendations showed for the same day (BASE RULE).
const { resolveDayTargets, resolveWaterGoalMl } = require('../lib/targets-resolver')

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

      // Load goals for thresholds. #1295 round 2 (QA-VERDICT BLOCKED, Max/Codex
      // 14:54, comment #7789): `calories_limit`/`water_min_ml` used to fall back
      // to `goals.type={calories,water}.target_value` when present — a stale
      // 2026-03-28 seed doc (water target_value=2500) silently OUTRANKED the
      // resolver's dynamic (weight+strain) value (4350 live), the exact class of
      // drift #1295 round 1 already fixed for `type=calories`. Fixed the same
      // way: `calories_limit`/`water_min_ml` are now resolver-first (never read
      // from `goals`); `protein_min` keeps its explicit-override capability
      // (Lisa's `POST/PUT /api/goals` workflow — no bug found there, its live
      // doc's `target_value` is already `null`). `scripts/sync-goals-canon-1295.js`
      // nulls the water doc's `target_value` too, so a future reseed of that
      // collection can't reintroduce this class of drift.
      const goalsData = await db.collection('goals').find({}).toArray()
      const proteinGoal = goalsData.find(g => g.type === 'protein')

      // #1295 round 2 (Apex triage, comment #7791): `?date=` was previously
      // ignored (`new Date().toISOString()...` = real UTC "today", always),
      // unlike every other target-facing route. Default switched to the SAME
      // Kyiv-day the 90-day window below already used
      // (`toLocaleDateString('sv-SE', {timeZone:'Europe/Kiev'})`) — the two were
      // silently on different calendars before this fix (UTC vs Kyiv), which is
      // the same "one date, one definition" violation this ticket exists to close.
      const requestedDate = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
      const targets = await resolveDayTargets(db, requestedDate)

      const goals = {
        calories_limit: targets.kcal,
        protein_min: proteinGoal?.target_value || targets.protein_g,
        water_min_ml: targets.water_ml,
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
      const [weights, nutritionLogs, waterLogs, stepsLogs, intakeLogs, supplements, whoopCycles] = await Promise.all([
        db.collection('weight_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('nutrition_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('water_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('steps').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('supplement_intake').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('supplement_catalog').find({ active: true }).toArray(),
        db.collection('whoop_cycles').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
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

      // #1295 round 2 (Apex triage): the water goal is DAY-dependent (weight +
      // that day's WHOOP strain — same math /api/water/today and /api/targets
      // use), so comparing all 90 streak days against ONE static threshold
      // (`goals.water_min_ml`, resolved only for `requestedDate`) was the same
      // one-metric-one-definition violation the rest of #1295 fixes. `weightKg`
      // reuses `resolveDayTargets`' own resolution (the latest `weight_log`
      // entry overall — the pre-existing, unrelated "which weight snapshot"
      // convention this ticket does not change, per lib/targets-resolver.js).
      const strainByDay = {}
      for (const c of whoopCycles) {
        strainByDay[c.date] = c.strain
      }
      const waterGoalByDay = {}
      for (const d of days) {
        waterGoalByDay[d] = resolveWaterGoalMl(targets.weight_kg, strainByDay[d])
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
        water: calcStreak(d => (waterByDay[d] || 0) >= waterGoalByDay[d]),
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
          ((waterByDay[d] || 0) >= waterGoalByDay[d]) &&
          ((stepsMap[d] || 0) >= goals.steps_min)
      })

      res.json({ streaks, overall, goals })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
