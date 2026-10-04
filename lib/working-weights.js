'use strict'

/**
 * #1727 п.2 — «робочі ваги в часі»: per exercise, the heaviest WORKING set of each session
 * (date, weight_kg, reps). Warm-ups excluded (same isWorkingSet() as the PR feed / sets-per-group).
 * Only weighted exercises with >=2 weighted sessions qualify (a trend needs two points);
 * Input is the canonical derived view. Bodyweight estimates and explicit loads
 * have separate series; neither converts unknown dumbbell single/pair semantics.
 * Ranked by session count, capped. Pure function — no DB.
 */
const { metricKind } = require('./workout-metrics')
const { isWorkingSet } = require('./training-load')

function buildWorkingWeights(allWorkouts, { from, limit = 8, maxPoints = 12, library = [] } = {}) {
  const equipment = new Map(library.map(e => [e.name, e.equipment]))
  const byEx = new Map() // [name, load source] → Map(date → {weight_kg, reps})
  for (const w of allWorkouts || []) {
    if (!w || !w.date || (from && w.date < from)) continue
    for (const ex of Array.isArray(w.exercises) ? w.exercises : []) {
      if (!ex || !ex.name) continue
      const sets = (Array.isArray(ex.sets) ? ex.sets : []).filter(isWorkingSet)
      let top = null
      for (const s of sets) {
        if (metricKind(ex.name, s) !== 'repetitions') continue
        const kg = Number(s.weight_kg)
        if (!(kg > 0)) continue
        const reps = Number(s.reps) || 0
        if (!top || kg > top.weight_kg || (kg === top.weight_kg && reps > top.reps)) top = { weight_kg: kg, reps, weight_source: s.weight_source === 'bodyweight' ? 'bodyweight' : 'logged' }
      }
      if (!top) continue
      const key = JSON.stringify([ex.name, top.weight_source])
      if (!byEx.has(key)) byEx.set(key, new Map())
      const days = byEx.get(key)
      const prev = days.get(w.date)
      if (!prev || top.weight_kg > prev.weight_kg) days.set(w.date, top)
    }
  }
  const out = []
  for (const [key, days] of byEx) {
    const [exercise, weight_source] = JSON.parse(key)
    if (days.size < 2) continue
    const series = [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, weight_kg: v.weight_kg, reps: v.reps }))
    const first = series[0].weight_kg
    const last = series[series.length - 1].weight_kg
    out.push({
      exercise,
      weight_source,
      equipment: equipment.get(exercise) || null,
      sessions: series.length,
      first_kg: first,
      last_kg: last,
      delta_kg: Math.round((last - first) * 10) / 10,
      max_kg: Math.max(...series.map((p) => p.weight_kg)),
      series: series.slice(-maxPoints),
    })
  }
  return out
    .sort((a, b) => b.sessions - a.sessions || a.exercise.localeCompare(b.exercise))
    .slice(0, limit)
}

module.exports = { buildWorkingWeights }
