const { Router } = require('express')
const { ObjectId } = require('mongodb')

module.exports = function (getDB) {
  const router = Router()

  // GET /api/activity-plan?date=YYYY-MM-DD
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date } = req.query
      if (!date) return res.status(400).json({ error: 'date required' })
      const data = await db.collection('activity_plans')
        .find({ date })
        .sort({ created_at: 1 })
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/activity-plan
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = {
        date: req.body.date || new Date().toISOString().split('T')[0],
        type: req.body.type || 'other',
        name: req.body.name || '',
        strain_target: req.body.strain_target ?? null,
        duration_min: req.body.duration_min ?? null,
        calories_est: req.body.calories_est ?? null,
        notes: req.body.notes || '',
        done: false,
        created_at: new Date(),
      }
      const result = await db.collection('activity_plans').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/activity-plan/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { id } = req.params
      const update = { ...req.body }
      delete update._id
      const result = await db.collection('activity_plans').findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: update },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/activity-plan/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { id } = req.params
      await db.collection('activity_plans').deleteOne({ _id: new ObjectId(id) })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/activity-plan/suggest
  router.get('/suggest', async (req, res) => {
    try {
      const db = getDB()
      const settings = await db.collection('user_settings').findOne({ key: 'default' })
      const activityStats = settings?.activity_stats || {}

      // Get today's WHOOP data: recovery + current CYCLE strain
      const today = new Date().toISOString().split('T')[0]
      const recovery = await db.collection('whoop_recovery').findOne({ date: today })
      const recoveryScore = recovery?.recovery_score ?? 65

      // Current cycle strain = total day strain so far (includes base + workouts)
      const cycle = await db.collection('whoop_cycles').findOne({ date: today })
      const currentCycleStrain = cycle?.strain ?? 0

      // Base strain without workouts: calc from history
      // Base = avg(cycle_strain on days with no workouts)
      const noWorkoutDays = await db.collection('whoop_cycles').aggregate([
        {
          $lookup: {
            from: 'whoop_workouts',
            localField: 'date',
            foreignField: 'date',
            as: 'workouts'
          }
        },
        { $match: { workouts: { $size: 0 }, strain: { $ne: null } } },
        { $group: { _id: null, avgBase: { $avg: '$strain' }, count: { $sum: 1 } } }
      ]).toArray()
      const baseStrain = noWorkoutDays[0]?.avgBase ? Math.round(noWorkoutDays[0].avgBase * 10) / 10 : 7.5

      // Workout strain already done today
      const todayWorkouts = await db.collection('whoop_workouts').find({ date: today }).toArray()
      const workoutStrainToday = todayWorkouts.reduce((s, w) => s + (w.strain || 0), 0)

      // Determine FULL day target from recovery
      let dayStrainMin, dayStrainMax, zone
      if (recoveryScore >= 67) {
        dayStrainMin = 14; dayStrainMax = 18; zone = 'hard'
      } else if (recoveryScore >= 34) {
        dayStrainMin = 10; dayStrainMax = 14; zone = 'moderate'
      } else {
        dayStrainMin = 0; dayStrainMax = 10; zone = 'light'
      }

      // Remaining workout strain = (target - base) - workouts already done
      // Because: cycle_total ≈ base + workout_strain
      const workoutTargetMin = Math.max(0, dayStrainMin - baseStrain)
      const workoutTargetMax = Math.max(0, dayStrainMax - baseStrain)
      const remainingMin = Math.max(0, workoutTargetMin - workoutStrainToday)
      const remainingMax = Math.max(0, workoutTargetMax - workoutStrainToday)

      // WHOOP strain is NOT additive — each additional workout adds diminishing returns
      // Based on analysis: additional workout adds ~0.1-0.4 of its strain to cycle
      // Intensity coef: high-strain sports add more, low-strain add less
      function projectedCycleIncrease(workoutStrain, currentCycle) {
        // Higher current cycle = less room for more strain (logarithmic saturation)
        const saturation = Math.max(0, 1 - currentCycle / 21)
        // Intensity factor: higher workout strain = higher coef
        const intensityCoef = workoutStrain >= 10 ? 0.45 : workoutStrain >= 7 ? 0.3 : 0.15
        return workoutStrain * intensityCoef * saturation
      }

      // Estimate remaining base strain for rest of day
      // WHOOP cycle ~24h starting ~21:00 Kyiv
      const kyivHour = parseInt(new Date().toLocaleString('uk', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }))
      const CYCLE_START = 0  // cycle starts ~midnight Kyiv
      const hoursElapsed = kyivHour  // hours since midnight
      const hoursRemaining = 24 - hoursElapsed
      const basePerHour = baseStrain / 24
      const remainingBaseStrain = Math.round(basePerHour * hoursRemaining * 10) / 10

      // Projected cycle at EOD without any workout = current + remaining base
      const projectedCycleEODNoWorkout = Math.min(21, currentCycleStrain + remainingBaseStrain)

      // Generate duration-specific suggestions: min 20min, step 10min
      // Each activity gets multiple duration options that burn ≥100 kcal
      const DURATION_STEP = 10
      const MIN_CALORIES = 60  // lower threshold — even 20min walk counts
      // Fixed base duration for certain sports (override avg)
      const SPORT_BASE_DURATION = {
        'soccer': 90, 'tennis': 90, 'basketball': 90,
      }

      const suggestions = []
      Object.entries(activityStats).forEach(([sport, stats]) => {
        const kcalPerMin = stats.avg_kcal_per_min || (stats.avg_calories / stats.avg_duration_min) || 3
        // Use historical average rounded to nearest 10min as the suggested duration
        const baseDur = SPORT_BASE_DURATION[sport]
        const suggestedDur = baseDur || Math.max(10, Math.ceil(stats.avg_duration_min / 10) * 10)
        // Build duration options: suggested, suggested±10, ±20 (keep > 0)
        const rawOptions = [suggestedDur - 20, suggestedDur - 10, suggestedDur, suggestedDur + 10, suggestedDur + 20]
          .filter(d => d >= 10)
        const durations = []
        for (const dur of rawOptions) {
          const estKcal = Math.round(kcalPerMin * dur)
          if (estKcal < MIN_CALORIES) continue
          const strainScale = dur / stats.avg_duration_min
          const scaledStrain = Math.round(stats.avg_strain * Math.min(strainScale, 1.5) * 10) / 10
          const cycleIncrease = projectedCycleIncrease(scaledStrain, projectedCycleEODNoWorkout)
          const projectedCycleTotal = Math.round((projectedCycleEODNoWorkout + cycleIncrease) * 10) / 10
          const alreadyOnTrack = projectedCycleEODNoWorkout >= dayStrainMin
          const fits = alreadyOnTrack
            ? projectedCycleTotal <= dayStrainMax * 1.0
            : projectedCycleTotal >= dayStrainMin * 0.9 && projectedCycleTotal <= dayStrainMax * 1.05
          durations.push({
            duration_min: dur,
            calories_est: estKcal,
            strain_est: scaledStrain,
            projected_cycle_total: projectedCycleTotal,
            fits_zone: fits,
          })
        }
        if (durations.length === 0) return
        // Best fit duration = first that fits zone, or shortest
        const bestFit = durations.find(d => d.fits_zone) || durations[0]
        const projectedWorkoutTotal = workoutStrainToday + bestFit.strain_est
        suggestions.push({
          sport_name: sport,
          avg_strain: stats.avg_strain,
          avg_duration_min: stats.avg_duration_min,
          avg_calories: stats.avg_calories,
          avg_kcal_per_min: kcalPerMin,
          count: stats.count,
          fits_zone: bestFit.fits_zone,
          // Best-fit specific values
          suggested_duration_min: bestFit.duration_min,
          suggested_calories: bestFit.calories_est,
          suggested_strain: bestFit.strain_est,
          projected_workout_total: Math.round(projectedWorkoutTotal * 10) / 10,
          projected_cycle_total: bestFit.projected_cycle_total,
          cycle_increase_est: Math.round(projectedCycleIncrease(bestFit.strain_est, projectedCycleEODNoWorkout) * 10) / 10,
          duration_options: durations.slice(0, 4), // up to 4 options
          score: Math.abs(bestFit.projected_cycle_total - (dayStrainMin + dayStrainMax) / 2),
        })
      })

      // If already on track — sort by least cycle increase (prefer light activities)
      // If not on track — sort by best fit to target midpoint
      const alreadyOnTrack = projectedCycleEODNoWorkout >= dayStrainMin
      suggestions.sort((a, b) => {
        if (a.fits_zone && !b.fits_zone) return -1
        if (!a.fits_zone && b.fits_zone) return 1
        if (alreadyOnTrack) {
          // prefer less impact on cycle
          return (a.cycle_increase_est || 0) - (b.cycle_increase_est || 0)
        }
        return a.score - b.score
      })

      res.json({
        recovery_score: recoveryScore,
        current_cycle_strain: currentCycleStrain,
        projected_eod_no_workout: Math.round(projectedCycleEODNoWorkout * 10) / 10,
        remaining_base_strain: remainingBaseStrain,
        workout_strain_today: Math.round(workoutStrainToday * 10) / 10,
        base_strain_avg: baseStrain,
        target_strain_min: dayStrainMin,
        target_strain_max: dayStrainMax,
        workout_target_min: Math.round(workoutTargetMin * 10) / 10,
        workout_target_max: Math.round(workoutTargetMax * 10) / 10,
        remaining_min: Math.round(remainingMin * 10) / 10,
        remaining_max: Math.round(remainingMax * 10) / 10,
        zone,
        suggestions: suggestions.slice(0, 5),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
