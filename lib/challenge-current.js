'use strict'
// #1692 п.10 — strength-challenge goals ("Підтягування 10 разів", "Бруси 20 разів")
// must report current_value from RECORDED sets, not the stale value stored at goal
// creation. Mapping mirrors health-dashboard resolveChallengeExercise().
function resolveChallengeExercise(goalName) {
  const lower = (goalName || '').toLowerCase()
  if (lower.includes('підтягу')) return 'Підтягування'
  if (lower.includes('брус')) return 'Віджимання на брусах'
  return null
}

function bestReps(workouts, exerciseName) {
  let max = 0
  for (const w of workouts || []) {
    for (const ex of w.exercises || []) {
      if (ex.name !== exerciseName) continue
      for (const s of ex.sets || []) max = Math.max(max, Number(s.reps) || 0)
    }
  }
  return max
}

// Returns goals with current_value derived for strength goals (never lowered below start_value).
async function withDerivedChallengeValues(db, goals) {
  const out = []
  for (const g of goals) {
    const name = g.type === 'strength' ? resolveChallengeExercise(g.name) : null
    if (!name) { out.push(g); continue }
    const workouts = await db.collection('workouts').find({ 'exercises.name': name }).toArray()
    const best = bestReps(workouts, name)
    out.push({ ...g, current_value: Math.max(best, g.start_value || 0), current_value_source: 'workouts' })
  }
  return out
}

module.exports = { resolveChallengeExercise, bestReps, withDerivedChallengeValues }
