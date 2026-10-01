const { Router } = require('express')

// #1519 (SPEC #1518 §3/§6) — `life_profile` is a read-only singleton; the
// ONLY writer is the one-off `scripts/seed-life-profile.js` (SPEC Q3: hand-
// transcribed from vault jd 51.01). This route never writes it.

module.exports = function (getDB) {
  const router = Router()

  // GET /api/life/profile
  router.get('/profile', async (req, res) => {
    try {
      const db = getDB()
      const doc = await db.collection('life_profile').findOne({})
      if (!doc) return res.status(404).json({ error: 'Profile not seeded yet' })
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
