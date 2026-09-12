const { Router } = require('express')
const { resolveDayTargets } = require('../lib/targets-resolver')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/targets?date=YYYY-MM-DD — THE single source for every day-level
  // health/nutrition target (#1295). /recommendations, /nutrition/summary,
  // /goals/streaks, /water/today and /profile/metrics all derive their target
  // numbers from the SAME resolveDayTargets() this endpoint calls — see
  // lib/targets-resolver.js for the full rationale.
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || new Date().toISOString().split('T')[0]
      const targets = await resolveDayTargets(db, date)
      res.json(targets)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
