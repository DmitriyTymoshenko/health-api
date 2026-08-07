const { Router } = require('express')

/**
 * Meal Templates
 * Collection: meal_templates
 * Schema: { name, items: [{food_name, amount_g, meal_type, kcal, protein_g, fat_g, carbs_g, fiber_g, sat_fat_g}], created_at }
 */

module.exports = function (getDB) {
  const router = Router()

  // GET /api/meal-templates
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const templates = await db.collection('meal_templates')
        .find({})
        .sort({ created_at: -1 })
        .toArray()
      res.json(templates)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/meal-templates  — save new template
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const { name, items } = req.body
      if (!name || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'name and items[] required' })
      }
      const doc = {
        name: name.trim(),
        items,
        created_at: new Date(),
      }
      const result = await db.collection('meal_templates').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/meal-templates/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      let filter
      try { filter = { _id: new ObjectId(req.params.id) } } catch { return res.status(400).json({ error: 'Invalid id' }) }
      const result = await db.collection('meal_templates').deleteOne(filter)
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/meal-templates/:id/apply?date=YYYY-MM-DD
  // Applies all items from template to the nutrition log for that date
  router.post('/:id/apply', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      let filter
      try { filter = { _id: new ObjectId(req.params.id) } } catch { return res.status(400).json({ error: 'Invalid id' }) }

      const template = await db.collection('meal_templates').findOne(filter)
      if (!template) return res.status(404).json({ error: 'Template not found' })

      const date = req.query.date || new Date().toISOString().split('T')[0]
      const nutritionColl = db.collection('nutrition_log')

      const docs = template.items.map(item => ({
        date,
        meal_type: item.meal_type || 'snack',
        food_name: item.food_name,
        amount_g: item.amount_g || 0,
        kcal: item.kcal || 0,
        protein_g: item.protein_g || 0,
        fat_g: item.fat_g || 0,
        carbs_g: item.carbs_g || 0,
        fiber_g: item.fiber_g || 0,
        sugar_g: item.sugar_g || 0,
        sat_fat_g: item.sat_fat_g || 0,
        from_template: template.name,
        created_at: new Date(),
      }))

      const result = await nutritionColl.insertMany(docs)
      res.json({ applied: docs.length, date, insertedIds: result.insertedIds })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
