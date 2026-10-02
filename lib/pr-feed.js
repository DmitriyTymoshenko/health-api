'use strict'

/**
 * #1693 п.3 — personal-record feed. Replays ALL logged sessions chronologically (the
 * "previous best" needs full history) and emits an event when a session beats every
 * earlier one for that exercise. Ranking = the SAME pickBestSet() as /progress and
 * /exercise-history (weighted → est.1RM; bodyweight → best reps) — one definition.
 */
const { pickBestSet, hasPositiveWeight } = require('./workout-sets')
const { isWorkingSet } = require('./training-load')

/**
 * @param {Array} allWorkouts any order
 * @param {{from:string, limit?:number}} opts events with date >= from are returned (newest first)
 */
function buildPrFeed(allWorkouts, { from, limit = 15 } = {}) {
  const sorted = [...(allWorkouts || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const best = new Map() // exercise → { orm, reps }
  const events = []
  for (const w of sorted) {
    for (const ex of Array.isArray(w.exercises) ? w.exercises : []) {
      const sets = (Array.isArray(ex.sets) ? ex.sets : []).filter(isWorkingSet)
      if (!ex.name || sets.length === 0) continue
      const top = pickBestSet(sets)
      const weighted = hasPositiveWeight(sets)
      const metric = weighted ? top.orm : top.reps
      if (metric <= 0) continue
      const prev = best.get(ex.name)
      if (prev && prev.weighted === weighted && metric > prev.metric) {
        if (!from || w.date >= from) {
          events.push({
            date: w.date,
            exercise: ex.name,
            kind: weighted ? 'e1rm' : 'reps',
            value: metric,
            previous: prev.metric,
            weight_kg: weighted ? top.weight : null,
            reps: top.reps,
          })
        }
      }
      if (!prev || prev.weighted !== weighted || metric > prev.metric) best.set(ex.name, { metric, weighted })
    }
  }
  // first-ever session of an exercise is a baseline, not a PR (no previous to beat)
  return events.sort((a, b) => b.date.localeCompare(a.date) || a.exercise.localeCompare(b.exercise)).slice(0, limit)
}

module.exports = { buildPrFeed }
