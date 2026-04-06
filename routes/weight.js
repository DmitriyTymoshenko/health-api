const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/weight
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const data = await db.collection('weight_log')
        .find({})
        .sort({ date: -1 })
        .limit(50)
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/weight/history
  router.get('/history', async (req, res) => {
    try {
      const db = getDB()
      const { days = 30 } = req.query
      const fromDate = new Date()
      fromDate.setDate(fromDate.getDate() - Number(days))
      const from = fromDate.toISOString().split('T')[0]

      const data = await db.collection('weight_log')
        .find({ date: { $gte: from } })
        .sort({ date: 1 })
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/weight/analysis
  router.get('/analysis', async (req, res) => {
    try {
      const db = getDB()
      const today = kyivToday()

      // Try to get today's weight first
      const todayEntry = await db.collection('weight_log').findOne({ date: today })

      const entries = await db.collection('weight_log')
        .find({})
        .sort({ date: -1 })
        .limit(14)
        .toArray()

      if (entries.length < 2) return res.json({ status: 'insufficient_data', message: 'Недостатньо даних' })

      // Use today's weight if available, otherwise fall back to latest entry
      const latest = todayEntry || entries[0]
      const today_logged = !!todayEntry
      const oldest7 = entries.find(e => {
        const diff = (new Date(latest.date) - new Date(e.date)) / 86400000
        return diff >= 6
      }) || entries[entries.length - 1]

      const daysDiff = Math.round((new Date(latest.date) - new Date(oldest7.date)) / 86400000) || 1

      if (daysDiff < 4) return res.json({ status: 'insufficient_data', message: `Замало даних (${daysDiff} дн.). Потрібно 5+ днів записів`, days_analyzed: daysDiff, latest_weight: latest.weight_kg })
      const actualChange = parseFloat((latest.weight_kg - oldest7.weight_kg).toFixed(1))
      const actualPerWeek = parseFloat((actualChange / daysDiff * 7).toFixed(2))

      const settings = await db.collection('user_settings').findOne({ key: 'default' })
      const deficit = settings?.daily_deficit_goal ?? 500
      const plannedPerWeek = parseFloat(((deficit * 7) / 7700).toFixed(2)) * -1

      let status, message, recommendation, color

      const last5 = entries.slice(0, 5)
      const plateau = last5.length >= 5 && Math.abs(last5[0].weight_kg - last5[4].weight_kg) < 0.2

      if (plateau) {
        status = 'plateau'
        message = '📊 Плато — вага не змінюється 5+ днів'
        recommendation = 'Спробуй збільшити дефіцит на 100 ккал або додати кардіо'
        color = '#FF8C42'
      } else if (actualPerWeek < plannedPerWeek * 0.3) {
        status = 'behind'
        message = `⚠️ Відстаєш від плану (фактично ${actualPerWeek} кг/тижд)`
        recommendation = `План: ${plannedPerWeek} кг/тижд. Перевір точність обліку їжі або збільш дефіцит`
        color = '#FF6B6B'
      } else if (actualPerWeek < plannedPerWeek * 1.3) {
        status = 'on_track'
        message = `✅ Ідеш по плану (${actualPerWeek} кг/тижд)`
        recommendation = 'Продовжуй в тому ж темпі'
        color = '#6BCB77'
      } else {
        status = 'too_fast'
        message = `⚡ Темп зависокий (${actualPerWeek} кг/тижд)`
        recommendation = "Більше 0.8 кг/тижд — ризик втрати м'язів. Збільш ліміт калорій на 150-200 ккал"
        color = '#FFD93D'
      }

      res.json({
        status,
        message,
        recommendation,
        color,
        actual_per_week: actualPerWeek,
        planned_per_week: plannedPerWeek,
        latest_weight: latest.weight_kg,
        latest_date: latest.date,
        oldest_weight: oldest7.weight_kg,
        days_analyzed: daysDiff,
        plateau,
        today_logged,
        ...(!today_logged && { warning: 'Сьогоднішню вагу ще не записано — використано останній запис' }),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/weight
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      doc.created_at = new Date()

      const result = await db.collection('weight_log').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/weight/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('weight_log').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { ...req.body, updated_at: new Date() } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/weight/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('weight_log').deleteOne({ _id: new ObjectId(req.params.id) })
      if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
