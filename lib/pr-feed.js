'use strict'

// Input is the canonical derived metric view, never raw historical bodyweight sets.
// Replay all history; first record on each comparable scale is a baseline, not a PR.
const { buildPRs } = require('./workout-metrics')
const { isWorkingSet } = require('./training-load')

function buildPrFeed(allWorkouts, { from, limit = 15, library = [] } = {}) {
  const sorted = [...(allWorkouts || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const equipment = new Map(library.map(e => [e.name, e.equipment]))
  const best = new Map()
  const events = []
  for (const w of sorted) {
    for (const ex of Array.isArray(w.exercises) ? w.exercises : []) {
      const sets = (Array.isArray(ex.sets) ? ex.sets : []).filter(isWorkingSet)
      if (!ex.name || sets.length === 0) continue
      // Partition BEFORE canonical ranking: a mixed session contributes to both histories.
      for (const source of ['bodyweight', 'logged']) {
        const sourceSets = sets.filter(s => (s.weight_source === 'bodyweight') === (source === 'bodyweight'))
        if (!sourceSets.length) continue
        const pr = buildPRs([{ ...w, exercises: [{ ...ex, sets: sourceSets }] }], library)[ex.name]
        if (!pr || pr.metric_kind === 'cardio') continue
        let kind, record
        if (pr.metric_kind === 'duration') { kind = 'duration'; record = pr.max_duration_seconds }
        else if (pr.max_1rm.value > 0) { kind = pr.max_1rm_kind; record = pr.max_1rm }
        else { kind = 'reps'; record = pr.max_reps }
        if (!(record.value > 0)) continue
        // Missing load / another metric must not reset a previous weighted best.
        const key = JSON.stringify([ex.name, kind, source])
        const previous = best.get(key)
        if (previous != null && record.value > previous && (!from || w.date >= from)) {
          events.push({ date: w.date, exercise: ex.name, kind,
            value: record.value, previous,
            weight_kg: ['e1rm', 'best_set'].includes(kind) ? record.weight : null,
            reps: kind === 'duration' ? null : kind === 'reps' ? record.value : record.reps,
            equipment: equipment.get(ex.name) || null, weight_source: source,
          })
        }
        if (previous == null || record.value > previous) best.set(key, record.value)
      }
    }
  }
  return events.sort((a, b) => b.date.localeCompare(a.date) || a.exercise.localeCompare(b.exercise)).slice(0, limit)
}

module.exports = { buildPrFeed }
