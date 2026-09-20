const { Router } = require('express')
const { requireFields } = require('../lib/validate')
// #1295 — /streaks used to fall back to its OWN hardcoded thresholds (calories_limit
// 2200, protein_min via the plain proteinGoalG() ignoring an explicit profile override)
// whenever the `goals` collection had no matching type. Those fallbacks now come from
// the SAME resolver every other target-facing route reads, so a day judged "on streak"
// here can never disagree with what /nutrition/summary or /recommendations showed for
// the same day (BASE RULE). #1298 R4 (owner decision 18.09): water/steps/supplements
// dropped from this endpoint entirely — see the /streaks handler below.
const { resolveDayTargets } = require('../lib/targets-resolver')
// #873 Частина 4: flat-sum reduce below missed legacy nested `items[]` records
// (#862 class) — reuse the SAME resolver aggregateDay/summaryHandler already use,
// not a re-declared local sum (BASE RULE, lessons-learned "reuse by name").
const { macroContribution } = require('../lib/nutrition-aggregate')

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
  // #1297: requireFields('type', 'name') — every live goals document has both
  // (verified live Mongo read, 6/6 docs); the caller is Lisa's own workflow
  // (Workouts.jsx comment: "POST/PUT /api/goals"), not a UI form in this repo.
  router.post('/', requireFields('type', 'name'), async (req, res) => {
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

  // GET /api/goals/streaks — calculate weight/calories/protein streaks (#1298 R4)
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

      // #1298 R4 (owner decision 18.09 ~12:00): water/steps/supplements dropped
      // from streaks entirely — water tracking removed from Today, steps
      // source dead since 06.04, supplements no longer per-day tracked.
      const goals = {
        calories_limit: targets.kcal,
        protein_min: proteinGoal?.target_value || targets.protein_g,
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
      const [weights, nutritionLogs] = await Promise.all([
        db.collection('weight_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
        db.collection('nutrition_log').find({ date: { $gte: fromDate, $lte: toDate } }).toArray(),
      ])

      // Build lookup maps
      const weightDates = new Set(weights.map(w => w.date))

      const nutritionByDay = {}
      for (const n of nutritionLogs) {
        if (!nutritionByDay[n.date]) nutritionByDay[n.date] = { kcal: 0, protein: 0 }
        const m = macroContribution(n)
        nutritionByDay[n.date].kcal += m.kcal
        nutritionByDay[n.date].protein += m.protein_g
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
      }

      // Overall streak: all THREE live metrics met on that day (#1298 R4 —
      // water/steps dropped: the old check required `waterByDay[d] >=
      // waterGoalByDay[d]` and `stepsMap[d] >= goals.steps_min`, both
      // permanently unsatisfiable once water tracking left Today and `steps`
      // (an already-nonexistent collection — writes go to `steps_log`, see
      // routes/steps.js) never got any rows, which made `overall` structurally
      // unreachable regardless of real behaviour — see #1298 Codex audit).
      const overall = calcStreak(d => {
        return weightDates.has(d) &&
          (nutritionByDay[d]?.kcal > 0 && nutritionByDay[d]?.kcal <= goals.calories_limit) &&
          (nutritionByDay[d]?.protein >= goals.protein_min)
      })

      res.json({ streaks, overall, goals })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
