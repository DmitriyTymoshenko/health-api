const { Router } = require('express')

module.exports = function (getDB) {
  const router = Router()

  function toDateStr(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // GET /api/whoop/summary?date=YYYY-MM-DD
  router.get('/summary', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || toDateStr(new Date())

      const [cycle, recovery, sleep, workouts] = await Promise.all([
        db.collection('whoop_cycles').findOne({ date }),
        db.collection('whoop_recovery').findOne({ date }),
        db.collection('whoop_sleep').findOne({ date }),
        db.collection('whoop_workouts').find({ date }).toArray(),
      ])

      // Determine last synced time (most recent of all collections)
      const syncTimes = [cycle, recovery, sleep]
        .filter(Boolean)
        .map(d => d.synced_at)
        .filter(Boolean)
        .sort()
      const last_synced = syncTimes[syncTimes.length - 1] || null

      // If today has no calories data yet — compute 30-day average as fallback
      let calories_burned = cycle?.calories_burned ?? null
      let calories_source = 'today'
      if (!calories_burned) {
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        const fromDate = toDateStr(thirtyDaysAgo)
        const history = await db.collection('whoop_cycles')
          .find({ date: { $gte: fromDate, $lt: date }, calories_burned: { $ne: null } })
          .toArray()
        if (history.length > 0) {
          const avg = history.reduce((sum, d) => sum + (d.calories_burned || 0), 0) / history.length
          calories_burned = Math.round(avg)
          calories_source = `avg_${history.length}d`
        }
      }

      // ── Recommended strain logic based on recovery ──
      const recovScore = recovery?.recovery_score ?? null
      let recommended_strain = null
      let strain_label = null
      let strain_color = null
      if (recovScore !== null) {
        if (recovScore >= 67) {
          recommended_strain = { min: 14, max: 18 }
          strain_label = 'Інтенсивне тренування'
          strain_color = '#6BCB77'
        } else if (recovScore >= 34) {
          recommended_strain = { min: 10, max: 14 }
          strain_label = 'Помірне навантаження'
          strain_color = '#FFD93D'
        } else {
          recommended_strain = { min: 0, max: 10 }
          strain_label = 'День відновлення'
          strain_color = '#FF6B6B'
        }
      }

      res.json({
        date,
        calories_burned,
        calories_source,
        strain: cycle?.strain ?? null,
        avg_heart_rate: cycle?.avg_heart_rate ?? null,
        max_heart_rate: cycle?.max_heart_rate ?? null,
        recovery_score: recovScore,
        hrv: recovery?.hrv_rmssd ?? null,
        resting_hr: recovery?.resting_heart_rate ?? null,
        spo2: recovery?.spo2_percentage ?? null,
        skin_temp: recovery?.skin_temp_celsius ?? null,
        sleep_performance: sleep?.sleep_performance ?? recovery?.sleep_performance ?? null,
        sleep_hours: sleep?.sleep_hours ?? null,
        sleep_needed_hours: sleep?.sleep_needed_hours ?? null,
        sleep_consistency: sleep?.sleep_consistency ?? null,
        sleep_efficiency: sleep?.sleep_efficiency ?? null,
        respiratory_rate: sleep?.respiratory_rate ?? null,
        disturbance_count: sleep?.disturbance_count ?? null,
        total_light_sleep_ms: sleep?.total_light_sleep_ms ?? null,
        total_sws_ms: sleep?.total_sws_ms ?? null,
        total_rem_ms: sleep?.total_rem_ms ?? null,
        total_awake_ms: sleep?.total_awake_ms ?? null,
        total_sleep_ms: sleep?.total_sleep_ms ?? null,
        recommended_strain,
        strain_label,
        strain_color,
        workouts: workouts.map(w => ({
          sport_name: w.sport_name,
          strain: w.strain,
          calories_burned: w.calories_burned,
          duration_min: w.duration_min,
          start_time: w.start_time ?? null,
          end_time: w.end_time ?? null,
          avg_heart_rate: w.avg_heart_rate ?? null,
          max_heart_rate: w.max_heart_rate ?? null,
          zone_zero_ms: w.zone_zero_ms ?? 0,
          zone_one_ms: w.zone_one_ms ?? 0,
          zone_two_ms: w.zone_two_ms ?? 0,
          zone_three_ms: w.zone_three_ms ?? 0,
          zone_four_ms: w.zone_four_ms ?? 0,
          zone_five_ms: w.zone_five_ms ?? 0,
        })),
        last_synced,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/whoop/cycles?date=YYYY-MM-DD
  router.get('/cycles', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || toDateStr(new Date())
      const doc = await db.collection('whoop_cycles').findOne({ date })
      res.json(doc || {})
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/whoop/recovery?date=YYYY-MM-DD
  router.get('/recovery', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || toDateStr(new Date())
      const doc = await db.collection('whoop_recovery').findOne({ date })
      res.json(doc || {})
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/whoop/sleep?date=YYYY-MM-DD
  router.get('/sleep', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || toDateStr(new Date())
      const doc = await db.collection('whoop_sleep').findOne({ date })
      res.json(doc || {})
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/whoop/workouts?date=YYYY-MM-DD
  router.get('/workouts', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || toDateStr(new Date())
      const docs = await db.collection('whoop_workouts').find({ date }).toArray()
      res.json(docs)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/whoop/stats/30d
  router.get('/stats/30d', async (req, res) => {
    try {
      const db = getDB()
      const from = new Date(); from.setDate(from.getDate() - 30)
      const fromStr = from.toISOString().split('T')[0]
      const docs = await db.collection('whoop_recovery').find({ date: { $gte: fromStr } }).toArray()
      const avg = (field) => {
        const vals = docs.map(d => d[field]).filter(v => v != null)
        return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null
      }
      res.json({
        hrv_avg: avg('hrv_rmssd'),
        rhr_avg: avg('resting_heart_rate'),
        spo2_avg: avg('spo2_percentage'),
        skin_temp_avg: avg('skin_temp_celsius'),
        recovery_avg: avg('recovery_score'),
        count: docs.length,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/whoop/sync
  router.post('/sync', async (req, res) => {
    const { exec } = require('child_process')
    exec('node /tmp/health-api/scripts/sync-whoop.js', (err) => {
      res.json({ ok: !err, error: err?.message })
    })
  })

  // GET /api/whoop/history?days=30
  router.get('/history', async (req, res) => {
    try {
      const db = getDB()
      const days = parseInt(req.query.days) || 30
      const from = new Date(); from.setDate(from.getDate() - days)
      const fromStr = from.toISOString().split('T')[0]
      const [cycles, recovery, sleep, workouts] = await Promise.all([
        db.collection('whoop_cycles').find({ date: { $gte: fromStr } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_recovery').find({ date: { $gte: fromStr } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_sleep').find({ date: { $gte: fromStr } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_workouts').find({ date: { $gte: fromStr } }).sort({ date: 1 }).toArray(),
      ])
      res.json({ cycles, recovery, sleep, workouts })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
