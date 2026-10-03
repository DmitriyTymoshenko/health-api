'use strict'
// #1692 п.4 — link a logged strength session to the WHOOP workout of the same day
// (duration, strain, kcal) + that morning's recovery. Read-time enrichment only: nothing
// is written to the workouts collection.
const { isRealWhoopWorkout } = require('./whoop-real-workout')

const STRENGTH_RE = /functional|strength|weight|gym|crossfit/i

function pickStrengthWhoop(whoopWorkouts) {
  const list = (whoopWorkouts || []).filter(isRealWhoopWorkout)
  if (list.length === 0) return null
  const strength = list.filter(w => STRENGTH_RE.test(w.sport_name || ''))
  const pool = strength.length ? strength : null
  if (!pool) return null
  return pool.reduce((a, b) => (Number(b.duration_min) > Number(a.duration_min) ? b : a))
}

async function attachWhoop(db, workouts) {
  if (!Array.isArray(workouts) || workouts.length === 0) return workouts
  const dates = [...new Set(workouts.map(w => w.date).filter(Boolean))]
  const [wh, rec] = await Promise.all([
    db.collection('whoop_workouts').find({ date: { $in: dates } }).toArray(),
    db.collection('whoop_recovery').find({ date: { $in: dates } }).toArray(),
  ])
  return workouts.map(w => {
    const match = pickStrengthWhoop(wh.filter(x => x.date === w.date))
    if (!match) return w
    const r = rec.find(x => x.date === w.date)
    return {
      ...w,
      duration_min: w.duration_min ?? match.duration_min ?? null,
      whoop: {
        sport_name: match.sport_name,
        duration_min: match.duration_min,
        strain: match.strain,
        calories_burned: match.calories_burned ?? null,
        recovery_score: r?.recovery_score ?? null,
      },
    }
  })
}

module.exports = { pickStrengthWhoop, attachWhoop }
