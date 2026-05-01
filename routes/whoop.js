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

      // Fallback: якщо сьогоднішні recovery/sleep відсутні (PENDING_SLEEP або ще не синхронізовано)
      // повертаємо останній валідний запис за останні 7 днів
      let recoveryData = recovery
      let recoveryFallbackDate = null
      if (!recovery || recovery.recovery_score === null) {
        const sevenDaysAgo = new Date()
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
        const fromDate = toDateStr(sevenDaysAgo)
        const fallbackRec = await db.collection('whoop_recovery')
          .find({ date: { $gte: fromDate, $lt: date }, recovery_score: { $ne: null } })
          .sort({ date: -1 })
          .limit(1)
          .next()
        if (fallbackRec) {
          recoveryData = fallbackRec
          recoveryFallbackDate = fallbackRec.date
        }
      }

      let sleepData = sleep
      let sleepFallbackDate = null
      if (!sleep || sleep.sleep_hours === null) {
        const sevenDaysAgo = new Date()
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
        const fromDate = toDateStr(sevenDaysAgo)
        const fallbackSlp = await db.collection('whoop_sleep')
          .find({ date: { $gte: fromDate, $lt: date }, sleep_hours: { $ne: null } })
          .sort({ date: -1 })
          .limit(1)
          .next()
        if (fallbackSlp) {
          sleepData = fallbackSlp
          sleepFallbackDate = fallbackSlp.date
        }
      }

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
      const recovScore = recoveryData?.recovery_score ?? null
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
        hrv: recoveryData?.hrv_rmssd ?? null,
        resting_hr: recoveryData?.resting_heart_rate ?? null,
        spo2: recoveryData?.spo2_percentage ?? null,
        skin_temp: recoveryData?.skin_temp_celsius ?? null,
        sleep_performance: sleepData?.sleep_performance ?? recoveryData?.sleep_performance ?? null,
        sleep_hours: sleepData?.sleep_hours ?? null,
        sleep_needed_hours: sleepData?.sleep_needed_hours ?? null,
        sleep_consistency: sleepData?.sleep_consistency ?? null,
        sleep_efficiency: sleepData?.sleep_efficiency ?? null,
        respiratory_rate: sleepData?.respiratory_rate ?? null,
        disturbance_count: sleepData?.disturbance_count ?? null,
        total_light_sleep_ms: sleepData?.total_light_sleep_ms ?? null,
        total_sws_ms: sleepData?.total_sws_ms ?? null,
        total_rem_ms: sleepData?.total_rem_ms ?? null,
        total_awake_ms: sleepData?.total_awake_ms ?? null,
        total_sleep_ms: sleepData?.total_sleep_ms ?? null,
        recommended_strain,
        strain_label,
        strain_color,
        recovery_data_date: recoveryFallbackDate,
        sleep_data_date: sleepFallbackDate,
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

  // GET /api/whoop/weekly-compare — compare this week vs last week
  router.get('/weekly-compare', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })

      // Calculate week boundaries (Mon-Sun)
      const todayDate = new Date(today + 'T00:00:00')
      const dayOfWeek = todayDate.getDay() // 0=Sun..6=Sat
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const thisMonday = new Date(todayDate)
      thisMonday.setDate(todayDate.getDate() - mondayOffset)
      const lastMonday = new Date(thisMonday)
      lastMonday.setDate(thisMonday.getDate() - 7)
      const lastSunday = new Date(thisMonday)
      lastSunday.setDate(thisMonday.getDate() - 1)

      const fmt = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
      const thisMondayStr = fmt(thisMonday)
      const todayStr = today
      const lastMondayStr = fmt(lastMonday)
      const lastSundayStr = fmt(lastSunday)

      // Fetch data for both weeks
      const [cycles, recovery, sleep, workouts, nutrition, weight, water, steps] = await Promise.all([
        db.collection('whoop_cycles').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_recovery').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_sleep').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).sort({ date: 1 }).toArray(),
        db.collection('whoop_workouts').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).sort({ date: 1 }).toArray(),
        db.collection('nutrition_log').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).toArray(),
        db.collection('weight_log').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).sort({ date: 1 }).toArray(),
        db.collection('water_log').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).toArray(),
        db.collection('steps').find({ date: { $gte: lastMondayStr, $lte: todayStr } }).toArray(),
      ])

      function splitWeek(arr) {
        const last = arr.filter(d => d.date >= lastMondayStr && d.date <= lastSundayStr)
        const curr = arr.filter(d => d.date >= thisMondayStr && d.date <= todayStr)
        return { last, curr }
      }

      function avg(arr, field) {
        const vals = arr.map(d => d[field]).filter(v => v != null && v > 0)
        if (!vals.length) return null
        return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10
      }

      function delta(curr, prev) {
        if (prev == null || prev === 0 || curr == null) return null
        return Math.round((curr - prev) / Math.abs(prev) * 1000) / 10
      }

      const rec = splitWeek(recovery)
      const slp = splitWeek(sleep)
      const cyc = splitWeek(cycles)
      const wk = splitWeek(workouts)
      const nut = splitWeek(nutrition)
      const wgt = splitWeek(weight)
      const wat = splitWeek(water)
      const stp = splitWeek(steps)

      function avgNutritionPerDay(entries) {
        const byDay = {}
        entries.forEach(e => {
          if (!byDay[e.date]) byDay[e.date] = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
          byDay[e.date].kcal += e.kcal || 0
          byDay[e.date].protein_g += e.protein_g || 0
          byDay[e.date].carbs_g += e.carbs_g || 0
          byDay[e.date].fat_g += e.fat_g || 0
        })
        const days = Object.values(byDay)
        if (!days.length) return { kcal: null, protein_g: null, carbs_g: null, fat_g: null }
        return {
          kcal: Math.round(days.reduce((s, d) => s + d.kcal, 0) / days.length),
          protein_g: Math.round(days.reduce((s, d) => s + d.protein_g, 0) / days.length),
          carbs_g: Math.round(days.reduce((s, d) => s + d.carbs_g, 0) / days.length),
          fat_g: Math.round(days.reduce((s, d) => s + d.fat_g, 0) / days.length),
        }
      }

      function avgWaterPerDay(entries) {
        const byDay = {}
        entries.forEach(e => {
          if (!byDay[e.date]) byDay[e.date] = 0
          byDay[e.date] += e.amount_ml || 0
        })
        const vals = Object.values(byDay)
        if (!vals.length) return null
        return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      }

      const currNut = avgNutritionPerDay(nut.curr)
      const lastNut = avgNutritionPerDay(nut.last)
      const currWater = avgWaterPerDay(wat.curr)
      const lastWater = avgWaterPerDay(wat.last)
      const currWeightEntry = wgt.curr.length ? wgt.curr[wgt.curr.length - 1].weight_kg : null
      const lastWeightEntry = wgt.last.length ? wgt.last[wgt.last.length - 1].weight_kg : null

      const result = {
        periods: {
          current: { from: thisMondayStr, to: todayStr, days_count: cyc.curr.length || rec.curr.length || 0 },
          previous: { from: lastMondayStr, to: lastSundayStr, days_count: 7 },
        },
        recovery: {
          current: avg(rec.curr, 'recovery_score'),
          previous: avg(rec.last, 'recovery_score'),
          delta: delta(avg(rec.curr, 'recovery_score'), avg(rec.last, 'recovery_score')),
        },
        hrv: {
          current: avg(rec.curr, 'hrv_rmssd'),
          previous: avg(rec.last, 'hrv_rmssd'),
          delta: delta(avg(rec.curr, 'hrv_rmssd'), avg(rec.last, 'hrv_rmssd')),
        },
        resting_hr: {
          current: avg(rec.curr, 'resting_heart_rate'),
          previous: avg(rec.last, 'resting_heart_rate'),
          delta: delta(avg(rec.curr, 'resting_heart_rate'), avg(rec.last, 'resting_heart_rate')),
        },
        strain: {
          current: avg(cyc.curr, 'strain'),
          previous: avg(cyc.last, 'strain'),
          delta: delta(avg(cyc.curr, 'strain'), avg(cyc.last, 'strain')),
        },
        calories_burned: {
          current: avg(cyc.curr, 'calories_burned'),
          previous: avg(cyc.last, 'calories_burned'),
          delta: delta(avg(cyc.curr, 'calories_burned'), avg(cyc.last, 'calories_burned')),
        },
        sleep_hours: {
          current: avg(slp.curr, 'sleep_hours'),
          previous: avg(slp.last, 'sleep_hours'),
          delta: delta(avg(slp.curr, 'sleep_hours'), avg(slp.last, 'sleep_hours')),
        },
        sleep_performance: {
          current: avg(slp.curr, 'sleep_performance'),
          previous: avg(slp.last, 'sleep_performance'),
          delta: delta(avg(slp.curr, 'sleep_performance'), avg(slp.last, 'sleep_performance')),
        },
        sleep_efficiency: {
          current: avg(slp.curr, 'sleep_efficiency'),
          previous: avg(slp.last, 'sleep_efficiency'),
          delta: delta(avg(slp.curr, 'sleep_efficiency'), avg(slp.last, 'sleep_efficiency')),
        },
        workouts_count: {
          current: wk.curr.length,
          previous: wk.last.length,
          delta: delta(wk.curr.length, wk.last.length),
        },
        nutrition: {
          current: currNut,
          previous: lastNut,
          delta: {
            kcal: delta(currNut.kcal, lastNut.kcal),
            protein_g: delta(currNut.protein_g, lastNut.protein_g),
          },
        },
        weight: {
          current: currWeightEntry,
          previous: lastWeightEntry,
          change_kg: currWeightEntry && lastWeightEntry ? Math.round((currWeightEntry - lastWeightEntry) * 10) / 10 : null,
        },
        water_ml: {
          current: currWater,
          previous: lastWater,
          delta: delta(currWater, lastWater),
        },
        steps: {
          current: avg(stp.curr, 'steps'),
          previous: avg(stp.last, 'steps'),
          delta: delta(avg(stp.curr, 'steps'), avg(stp.last, 'steps')),
        },
        daily: {
          recovery: [...rec.last, ...rec.curr].map(r => ({ date: r.date, value: r.recovery_score })),
          hrv: [...rec.last, ...rec.curr].map(r => ({ date: r.date, value: r.hrv_rmssd ? Math.round(r.hrv_rmssd) : null })),
          sleep_hours: [...slp.last, ...slp.curr].map(s => ({ date: s.date, value: s.sleep_hours })),
          strain: [...cyc.last, ...cyc.curr].map(c => ({ date: c.date, value: c.strain })),
        },
      }

      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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
