const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/nutrition
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date, limit = 50, skip = 0 } = req.query
      const filter = date ? { date } : {}
      const data = await db.collection('nutrition_log')
        .find(filter)
        .sort({ date: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/nutrition/today
  router.get('/today', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date().toISOString().split('T')[0]
      const data = await db.collection('nutrition_log')
        .find({ date: today })
        .sort({ meal_type: 1 })
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/nutrition/summary?date=YYYY-MM-DD (also /summary/today for backward compat)
  router.get('/summary/today', async (req, res) => { req.query.date = new Date().toISOString().split('T')[0]; return summaryHandler(req, res) })
  router.get('/summary', summaryHandler)
  async function summaryHandler(req, res) {
    try {
      const db = getDB()
      const today = req.query.date || new Date().toISOString().split('T')[0]
      const data = await db.collection('nutrition_log').find({ date: today }).toArray()

      const summary = data.reduce(
        (acc, item) => {
          acc.kcal += item.kcal || item.calories || 0
          acc.protein_g += item.protein_g || 0
          acc.carbs_g += item.carbs_g || 0
          acc.fat_g += item.fat_g || 0
          acc.fiber_g += item.fiber_g || 0
          return acc
        },
        { date: today, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, items: data.length }
      )

      // Round to 1 decimal
      summary.kcal = Math.round(summary.kcal)
      summary.protein_g = Math.round(summary.protein_g * 10) / 10
      summary.carbs_g = Math.round(summary.carbs_g * 10) / 10
      summary.fat_g = Math.round(summary.fat_g * 10) / 10
      summary.fiber_g = Math.round(summary.fiber_g * 10) / 10

      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }

  // POST /api/nutrition
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      doc.created_at = new Date()
      // Normalize field names: support both protein/fat/carbs and protein_g/fat_g/carbs_g
      if (doc.protein !== undefined && doc.protein_g === undefined) doc.protein_g = doc.protein
      if (doc.fat !== undefined && doc.fat_g === undefined) doc.fat_g = doc.fat
      if (doc.carbs !== undefined && doc.carbs_g === undefined) doc.carbs_g = doc.carbs
      if (doc.name && !doc.food_name) doc.food_name = doc.name

      const result = await db.collection('nutrition_log').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })


  // GET /api/nutrition/meal-suggest
  // Extensive list of common foods for suggestions
  const COMMON_FOODS = [
    // High protein
    { name: 'Куряча грудка варена', kcal_per_100g: 165, protein_per_100g: 31, fat_per_100g: 3.6, carbs_per_100g: 0, tags: ['protein'] },
    { name: 'Яловичина тушкована', kcal_per_100g: 218, protein_per_100g: 25, fat_per_100g: 12, carbs_per_100g: 0, tags: ['protein'] },
    { name: 'Лосось запечений', kcal_per_100g: 208, protein_per_100g: 20, fat_per_100g: 13, carbs_per_100g: 0, tags: ['protein', 'fat'] },
    { name: 'Творог 5%', kcal_per_100g: 121, protein_per_100g: 17, fat_per_100g: 5, carbs_per_100g: 1.8, tags: ['protein'] },
    { name: 'Яйця варені', kcal_per_100g: 155, protein_per_100g: 13, fat_per_100g: 11, carbs_per_100g: 1.1, tags: ['protein', 'fat'] },
    { name: 'Грецький йогурт 2%', kcal_per_100g: 59, protein_per_100g: 10, fat_per_100g: 0.4, carbs_per_100g: 3.6, tags: ['protein'] },
    { name: 'Тунець у воді', kcal_per_100g: 96, protein_per_100g: 21, fat_per_100g: 0.5, carbs_per_100g: 0, tags: ['protein'] },
    { name: 'Індичка варена', kcal_per_100g: 189, protein_per_100g: 29, fat_per_100g: 7, carbs_per_100g: 0, tags: ['protein'] },
    // High carbs
    { name: 'Гречка варена', kcal_per_100g: 92, protein_per_100g: 3.4, fat_per_100g: 0.6, carbs_per_100g: 20, tags: ['carbs'] },
    { name: 'Рис варений', kcal_per_100g: 130, protein_per_100g: 2.7, fat_per_100g: 0.3, carbs_per_100g: 28, tags: ['carbs'] },
    { name: 'Вівсянка на воді', kcal_per_100g: 88, protein_per_100g: 3, fat_per_100g: 1.7, carbs_per_100g: 15, tags: ['carbs'] },
    { name: 'Банан', kcal_per_100g: 89, protein_per_100g: 1.1, fat_per_100g: 0.3, carbs_per_100g: 23, tags: ['carbs'] },
    { name: 'Картопля варена', kcal_per_100g: 77, protein_per_100g: 2, fat_per_100g: 0.1, carbs_per_100g: 17, tags: ['carbs'] },
    { name: 'Хліб цільнозерновий', kcal_per_100g: 247, protein_per_100g: 9, fat_per_100g: 3, carbs_per_100g: 43, tags: ['carbs'] },
    { name: 'Макарони варені', kcal_per_100g: 131, protein_per_100g: 5, fat_per_100g: 0.9, carbs_per_100g: 25, tags: ['carbs'] },
    // Healthy fats
    { name: 'Авокадо', kcal_per_100g: 160, protein_per_100g: 2, fat_per_100g: 15, carbs_per_100g: 9, tags: ['fat'] },
    { name: 'Грецькі горіхи', kcal_per_100g: 654, protein_per_100g: 15, fat_per_100g: 65, carbs_per_100g: 14, tags: ['fat'] },
    { name: 'Мигдаль', kcal_per_100g: 579, protein_per_100g: 21, fat_per_100g: 50, carbs_per_100g: 22, tags: ['fat', 'protein'] },
    // Vegetables
    { name: 'Броколі варена', kcal_per_100g: 35, protein_per_100g: 2.4, fat_per_100g: 0.4, carbs_per_100g: 7, tags: ['vegs'] },
    { name: 'Шпинат', kcal_per_100g: 23, protein_per_100g: 2.9, fat_per_100g: 0.4, carbs_per_100g: 3.6, tags: ['vegs'] },
    { name: 'Огірок', kcal_per_100g: 16, protein_per_100g: 0.7, fat_per_100g: 0.1, carbs_per_100g: 3.6, tags: ['vegs'] },
    { name: 'Помідор', kcal_per_100g: 18, protein_per_100g: 0.9, fat_per_100g: 0.2, carbs_per_100g: 3.9, tags: ['vegs'] },
    // Mixed
    { name: 'Омлет з 2 яєць', kcal_per_100g: 154, protein_per_100g: 11, fat_per_100g: 12, carbs_per_100g: 1, tags: ['protein', 'fat'] },
    { name: 'Протеїновий шейк', kcal_per_100g: 110, protein_per_100g: 22, fat_per_100g: 1.5, carbs_per_100g: 3, tags: ['protein'] },
  ]

  router.get('/meal-suggest', async (req, res) => {
    try {
      const db = getDB()
      const { meal_type, kcal, protein_g, carbs_g, fat_g } = req.query
      const targetKcal = parseFloat(kcal) || 500
      const targetProtein = parseFloat(protein_g) || 30
      const targetCarbs = parseFloat(carbs_g) || 50
      const targetFat = parseFloat(fat_g) || 15

      // Fetch library foods
      const libraryFoods = await db.collection('foods_library').find({}).toArray()
      const libraryNormalized = libraryFoods.map(f => ({
        name: f.name,
        kcal_per_100g: f.kcal_per_100g,
        protein_per_100g: f.protein_per_100g,
        fat_per_100g: f.fat_per_100g,
        carbs_per_100g: f.carbs_per_100g,
        source: 'library',
      }))

      // Always merge library + COMMON_FOODS, dedup by name (library takes priority)
      const existingNames = new Set(libraryNormalized.map(f => f.name.toLowerCase()))
      const commonFoodsNorm = COMMON_FOODS
        .filter(f => !existingNames.has(f.name.toLowerCase()))
        .map(f => ({ ...f, source: 'common' }))
      const allFoods = [...libraryNormalized, ...commonFoodsNorm]

      // Score each food — MACRO FIT is the primary metric, calories secondary
      const scored = allFoods
        .filter(food => food.kcal_per_100g > 0)
        .map(food => {
          // Calculate amount to hit target kcal
          const idealAmount = Math.min(500, Math.max(30, Math.round((targetKcal / food.kcal_per_100g) * 100)))
          const amount = idealAmount
          const actualKcal = Math.round(food.kcal_per_100g * amount / 100)
          const actualProtein = Math.round(food.protein_per_100g * amount / 100 * 10) / 10
          const actualFat = Math.round(food.fat_per_100g * amount / 100 * 10) / 10
          const actualCarbs = Math.round(food.carbs_per_100g * amount / 100 * 10) / 10

          // Macro fit score (weighted: protein matters most for this user)
          const proteinDev = targetProtein > 0 ? Math.abs(actualProtein - targetProtein) / targetProtein : 0
          const carbsDev = targetCarbs > 0 ? Math.abs(actualCarbs - targetCarbs) / targetCarbs : 0
          const fatDev = targetFat > 0 ? Math.abs(actualFat - targetFat) / targetFat : 0
          // Protein weight 50%, carbs 30%, fat 20%
          const weightedDev = proteinDev * 0.5 + carbsDev * 0.3 + fatDev * 0.2
          const fit_score = Math.round((1 / (1 + weightedDev)) * 1000) / 1000

          return {
            food_name: food.name,
            amount_g: amount,
            kcal: actualKcal,
            protein_g: actualProtein,
            fat_g: actualFat,
            carbs_g: actualCarbs,
            fit_score,
            source: food.source,
          }
        })

      // Sort by fit_score desc, return top 6
      scored.sort((a, b) => b.fit_score - a.fit_score)
      res.json(scored.slice(0, 6))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/nutrition/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('nutrition_log').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      )
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' })
      const updated = await db.collection('nutrition_log').findOne({ _id: new ObjectId(req.params.id) })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })


  // PUT /api/nutrition/:id - update a nutrition entry
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('nutrition_log').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      )
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' })
      const updated = await db.collection('nutrition_log').findOne({ _id: new ObjectId(req.params.id) })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/nutrition/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('nutrition_log').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
// This file will be modified to add foods_library routes separately
