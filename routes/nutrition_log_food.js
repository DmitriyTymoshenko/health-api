'use strict'
// #1729 — POST /api/nutrition/log-food: ONE call replaces Lisa's 3–4 sequential steps
// (search library → write meal → recompute day totals). Items not found in the library are
// returned in `not_found` so the caller only has to research THOSE (WebSearch) and POST them
// via the regular POST /api/nutrition.
const { Router } = require('express')
const { todayKyiv } = require('../lib/kyiv-day')
const F = require('../lib/food-log')

module.exports = function (getDB) {
  const router = Router()
  const computeSummary = require('./nutrition')(getDB).computeSummary

  router.post('/', async (req, res) => {
    try {
      const body = req.body || {}
      const items = Array.isArray(body.items) ? body.items : []
      if (!items.length || items.length > 30) return res.status(400).json({ error: 'items must be a non-empty array (max 30)' })
      if (items.some((i) => !i || typeof i.name !== 'string' || !i.name.trim())) {
        return res.status(400).json({ error: 'every item needs a non-empty name' })
      }
      if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
      if (body.meal_type && !F.MEALS.includes(body.meal_type)) return res.status(400).json({ error: `meal_type must be one of ${F.MEALS.join(', ')}` })
      const date = body.date || todayKyiv()
      const meal_type = body.meal_type || F.mealByHour()
      const db = getDB()
      const lib = db.collection('foods_library')
      const log = db.collection('nutrition_log')

      const logged = []
      const duplicates = []
      const not_found = []
      const useIds = []

      for (const item of items) {
        const filter = F.candidateFilter(item)
        const cands = filter ? await lib.find(filter).limit(60).toArray() : []
        const { doc, candidates } = F.pickMatch(item, cands)
        if (!doc) { not_found.push({ name: item.name, brand: item.brand || null, reason: 'not_in_library', candidates }); continue }
        const amt = F.resolveGrams(item, doc)
        if (amt.error) { not_found.push({ name: item.name, brand: item.brand || null, reason: amt.error, matched: doc.name_ua || doc.name }); continue }
        const entry = F.buildLogDoc(doc, amt.grams, { date, meal_type })
        entry.idem_key = F.idemKey({ date, meal_type, name: entry.food_name, grams: amt.grams, request_id: body.request_id })
        const since = new Date(Date.now() - F.DEDUPE_WINDOW_MS)
        const dupFilter = body.request_id ? { idem_key: entry.idem_key } : { idem_key: entry.idem_key, created_at: { $gte: since } }
        const existing = await log.findOne(dupFilter)
        const view = { query: item.name, food_name: entry.food_name, amount_g: entry.amount_g, kcal: entry.kcal, protein_g: entry.protein_g, fat_g: entry.fat_g, carbs_g: entry.carbs_g, sugar_g: entry.sugar_g, fiber_g: entry.fiber_g, sat_fat_g: entry.sat_fat_g }
        if (existing) { duplicates.push(view); continue }
        entry.created_at = new Date()
        const r = await log.insertOne(entry)
        logged.push({ id: r.insertedId, ...view })
        useIds.push(doc._id)
      }
      if (useIds.length) await lib.updateMany({ _id: { $in: useIds } }, { $inc: { use_count: 1 } }).catch(() => {})

      const day_summary = await computeSummary(db, date)
      res.status(logged.length ? 201 : 200).json({ date, meal_type, logged, duplicates, not_found, day_summary })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
  return router
}
