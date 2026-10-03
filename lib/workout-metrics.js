'use strict'

const { bodyweightKind, resolveBodyweightForDate } = require('./bodyweight-fill')
const { calc1RM } = require('./workout-sets')

const DURATION_RE = /планк|plank|\(сек\)|\(sec\)/i
const CARDIO_RE = /mountain|альпініст|скелелаз|кардіо|cardio|скакал|jump(?:ing)?\s*rope|burpee|берпі/i
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0

function metricKind(name, set = {}) {
  if (set.duration_seconds != null || DURATION_RE.test(name)) return 'duration'
  if (CARDIO_RE.test(name)) return 'cardio'
  return 'repetitions'
}

// A metric view only. Never save this over raw sets. Explicit loads (including zero,
// unresolved units, per-dumbbell and already-converted lb) retain their own semantics.
function metricSet(name, set, bodyweightKg) {
  const kind = metricKind(name, set)
  const derived = { ...set, metric_kind: kind }
  if (kind !== 'repetitions') {
    derived.raw_reps = set.reps
    derived.reps = 0
    derived.weight_kg = null
    if (kind === 'duration') derived.duration_seconds = positive(set.duration_seconds ?? set.reps)
    return derived
  }
  if (set.weight_source === 'bodyweight' && set.weight_input == null) {
    const factor = bodyweightKind(name)
    if (factor === 'time') derived.weight_kg = null // e.g. leg raises: reps, no full-BW load
    else if (factor === 0.64) {
      derived.weight_kg = positive(bodyweightKg) ? Math.round(bodyweightKg * factor * 10) / 10 : null
      derived.weight_resolution = positive(bodyweightKg) ? 'bodyweight_at_session' : 'bodyweight_unavailable'
    }
  }
  return derived
}

async function deriveWorkoutMetrics(db, workouts) {
  const byDate = new Map()
  for (const w of workouts) {
    const needsBodyweight = (w.exercises || []).some(ex => bodyweightKind(ex.name) === 0.64 &&
      (ex.sets || []).some(s => s.weight_source === 'bodyweight' && s.weight_input == null))
    if (needsBodyweight && !byDate.has(w.date)) {
      byDate.set(w.date, await resolveBodyweightForDate(db.collection('weight_log'), w.date))
    }
  }
  return workouts.map(w => ({ ...w, exercises: (w.exercises || []).map(ex => ({
    ...ex, sets: (ex.sets || []).map(s => metricSet(ex.name, s, byDate.get(w.date))),
  })) }))
}

// Both GET PRs and POST notifications use this exact scale. Machines report best
// set volume, never an e1RM. Bodyweight tags override stale free-weight metadata.
function buildPRs(workouts, library = []) {
  const equipment = new Map(library.map(ex => [ex.name, ex.equipment]))
  const result = {}
  for (const w of workouts) for (const ex of w.exercises || []) {
    const sets = ex.sets || []
    if (!sets.length) continue
    const kind = metricKind(ex.name, sets[0])
    const free = ['barbell', 'dumbbell'].includes(equipment.get(ex.name)) &&
      !sets.some(s => s.weight_source === 'bodyweight') && kind === 'repetitions'
    const pr = result[ex.name] ||= {
      exercise: ex.name, muscle_group: ex.muscle_group || null,
      metric_kind: kind,
      max_weight: { value: 0, date: null, reps: null },
      max_volume: { value: 0, date: null },
      max_1rm: { value: 0, date: null, weight: null, reps: null },
      max_1rm_kind: free ? 'e1rm' : 'best_set',
      max_reps: { value: 0, date: null, weight: null },
      max_duration_seconds: { value: 0, date: null },
      total_sessions: 0,
    }
    pr.total_sessions++
    let volume = 0
    for (const s of sets) {
      const k = metricKind(ex.name, s)
      if (k === 'duration') {
        const value = positive(s.duration_seconds ?? s.reps)
        if (value > pr.max_duration_seconds.value) pr.max_duration_seconds = { value, date: w.date }
        continue
      }
      if (k === 'cardio') continue
      const weight = positive(s.weight_kg), reps = positive(s.reps)
      volume += weight * reps
      const value = free ? calc1RM(weight, reps) : Math.round(weight * reps)
      if (weight > pr.max_weight.value) pr.max_weight = { value: weight, date: w.date, reps }
      if (value > pr.max_1rm.value) pr.max_1rm = { value, date: w.date, weight, reps }
      if (reps > pr.max_reps.value) pr.max_reps = { value: reps, date: w.date, weight }
    }
    if (Math.round(volume) > pr.max_volume.value) pr.max_volume = { value: Math.round(volume), date: w.date }
  }
  return result
}

module.exports = { metricKind, metricSet, deriveWorkoutMetrics, buildPRs }
