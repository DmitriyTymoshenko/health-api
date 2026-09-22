'use strict'

const { Router } = require('express')
const { formatDateKyiv } = require('../lib/training-program')
const { computeStock } = require('../lib/stock')
const { sumStack } = require('../lib/nutrient-sum')
const { checkStack } = require('../lib/interactions')

// #1489 (stage E of #1485): GET /api/catalog/stack-check — read-only
// aggregation over the CURRENTLY active catalog: derived stock/days-left
// (E2), summed nutrients vs UL (E3/E4), same-slot conflict/synergy check
// (E5). Lives in its OWN file, mounted on the SAME `/api/catalog` prefix as
// routes/supplement_catalog.js (Express allows multiple routers per prefix —
// unmatched paths fall through), same pattern as routes/exercises_catalog.js
// mounted alongside routes/workouts.js on `/api/workouts` (see that file's
// header for the rationale) — NOT inside supplement_catalog.js, which
// #1487/#1488/Lucas's concurrent stage C already own; keeps this stage's
// diff isolated to new files + the one PATCH /:id/stock anchor edit the task
// explicitly allows. No caching — every input here is a handful of cheap
// in-memory computations over small collections (11 catalog items today).
module.exports = function (getDB) {
  const router = Router()

  // GET /api/catalog/stack-check
  router.get('/stack-check', async (req, res) => {
    try {
      const db = getDB()
      const today = formatDateKyiv(new Date())

      const [allItems, cycles, knowledgeDocs] = await Promise.all([
        db.collection('supplement_catalog').find({}).toArray(),
        db.collection('supplement_cycles').find({}).toArray(),
        db.collection('supplement_knowledge').find({}).toArray(),
      ])

      const activeItems = allItems.filter((item) => item.active !== false)
      const knowledgeById = new Map(knowledgeDocs.map((k) => [k.catalog_id, k]))

      // Most-recently-started cycle per supplement_id wins (a `restart`
      // creates a new cycle doc rather than mutating the old one — the old
      // one's manual `status` may still say 'active' if it was never
      // explicitly closed, so picking by start_date rather than filtering on
      // status is the only way to always land on the CURRENT cycle).
      const cycleBySupplementId = new Map()
      for (const cycle of cycles) {
        const existing = cycleBySupplementId.get(cycle.supplement_id)
        if (!existing || cycle.start_date > existing.start_date) {
          cycleBySupplementId.set(cycle.supplement_id, cycle)
        }
      }

      const stock = activeItems.map((item) => {
        const cycle = cycleBySupplementId.get(item.id) || null
        const computed = computeStock(item, cycle, today)
        return {
          catalog_id: item.id,
          short_name: item.short_name || item.name,
          servings_per_day: computed.servings_per_day,
          remaining: computed.remaining,
          days_left: computed.days_left,
          buy_prominent: computed.buy_prominent,
        }
      })

      const nutrients = sumStack(activeItems, knowledgeById)
      const interactions = checkStack(activeItems, knowledgeById)

      res.json({ date: today, stock, nutrients, interactions })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
