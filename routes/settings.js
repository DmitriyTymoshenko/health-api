const express = require('express')

const DEFAULT_SETTINGS = {
  key: 'default',
  daily_deficit_goal: 500,
  weight_start: 102.5,
  weight_goal_near: 100,
  weight_milestones: [
    { date: '2026-03-31', target: 101.5, label: 'Березень' },
    { date: '2026-04-30', target: 99.5, label: 'Квітень' },
    { date: '2026-05-31', target: 97.5, label: 'Травень' },
    { date: '2026-06-30', target: 95.0, label: 'Червень 🎯' },
    { date: '2026-09-30', target: 92.5, label: 'Вересень' },
    { date: '2026-12-31', target: 90.0, label: 'Грудень 🏆' },
  ],
  name: 'Дмитро',
  height_cm: 186,
  birth_year: 1995,
}

module.exports = function (getDB) {
  const router = express.Router()

  // GET /api/settings
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      let doc = await db.collection('user_settings').findOne({ key: 'default' })
      if (!doc) {
        await db.collection('user_settings').insertOne({ ...DEFAULT_SETTINGS })
        doc = { ...DEFAULT_SETTINGS }
      }
      delete doc._id
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/settings
  router.put('/', async (req, res) => {
    try {
      const db = getDB()
      const updates = { ...req.body }
      delete updates._id
      delete updates.key

      await db.collection('user_settings').updateOne(
        { key: 'default' },
        { $set: updates },
        { upsert: true }
      )

      // Save daily plan snapshot when deficit changes
      if (updates.daily_deficit_goal !== undefined) {
        const today = new Date().toISOString().split('T')[0]
        await db.collection('daily_plans').updateOne(
          { date: today },
          { $set: { date: today, daily_deficit_goal: updates.daily_deficit_goal, saved_at: new Date().toISOString() } },
          { upsert: true }
        )
      }

      const doc = await db.collection('user_settings').findOne({ key: 'default' })
      delete doc._id
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/settings/plan?date=YYYY-MM-DD — get deficit for a specific past date
  router.get('/plan', async (req, res) => {
    try {
      const db = getDB()
      const { date } = req.query
      if (!date) return res.status(400).json({ error: 'date required' })

      // Find the plan that was active on that date (last saved before or on that date)
      const plan = await db.collection('daily_plans')
        .find({ date: { $lte: date } })
        .sort({ date: -1 })
        .limit(1)
        .toArray()

      if (plan.length > 0) {
        res.json({ date, daily_deficit_goal: plan[0].daily_deficit_goal })
      } else {
        // No plan saved yet — return current settings
        const settings = await db.collection('user_settings').findOne({ key: 'default' })
        res.json({ date, daily_deficit_goal: settings?.daily_deficit_goal ?? 500 })
      }
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/settings/recalc-tdee — recalculate avg TDEE from last 30 days WHOOP data
  router.post('/recalc-tdee', async (req, res) => {
  try {
    const db = getDB()
    const cycles = await db.collection('whoop_cycles')
      .find({ calories_burned: { $ne: null } })
      .sort({ date: -1 })
      .limit(30)
      .toArray()
    
    const workouts = await db.collection('whoop_workouts').find({}).toArray()
    const wByDate = {}
    workouts.forEach(w => { wByDate[w.date] = (wByDate[w.date] || 0) + 1 })

    const allVals = cycles.map(d => d.calories_burned).filter(Boolean)
    const activeVals = cycles.filter(c => wByDate[c.date] > 0).map(d => d.calories_burned)
    const restVals = cycles.filter(c => !wByDate[c.date]).map(d => d.calories_burned)

    if (allVals.length < 3) return res.json({ ok: false, message: 'Недостатньо даних' })

    const avg = arr => arr.length ? Math.round(arr.reduce((a,b) => a+b, 0) / arr.length) : null

    const avgAll = avg(allVals)
    const avgActive = avg(activeVals)
    const avgRest = avg(restVals)
    
    await db.collection('user_settings').updateOne(
      { key: 'default' },
      { $set: {
        avg_tdee: avgAll,
        avg_tdee_active: avgActive,
        avg_tdee_rest: avgRest,
        avg_tdee_updated: new Date().toISOString(),
        avg_tdee_days: allVals.length
      }},
      { upsert: true }
    )
    
    res.json({ ok: true, avg_tdee: avgAll, avg_tdee_active: avgActive, avg_tdee_rest: avgRest, days: allVals.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
  })

  return router
}
