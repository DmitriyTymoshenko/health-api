'use strict'

/**
 * Cross-exercise progression overview — task #1417. "По кожній вправі — де я
 * прогресую, а де просідаю" (Дмитро → Phil, 18.09, «затверджую»). Pure logic, no DB
 * access, unit-testable without a DB — same pattern as lib/exercise-progression.js
 * (#1291). The route (routes/workouts.js GET /exercise-trends) does exactly ONE
 * `find({})` over `workouts` and passes the raw docs here; this file does the
 * grouping/ranking/classification.
 *
 * Reuses (never re-derives — Apex triage #1417 comment, 18.09 12:16):
 *   - pickBestSet/calc1RM  <- lib/workout-sets.js (moved here from routes/workouts.js
 *     so /progress, /exercise-history and this file all rank sets identically — A1
 *     acceptance requires est_1rm to match /progress?name=... exactly)
 *   - hasPositiveWeight    <- lib/workout-sets.js (bodyweight detection, #1130 rule)
 *   - exerciseKey          <- lib/volume-by-muscle.js (lowercase name grouping key,
 *     same as the muscle-group volume aggregator — NOT an alias layer, #1408 has none)
 *   - daysBetweenDateStrings <- lib/training-program.js (Kyiv-day arithmetic)
 */

const { hasPositiveWeight, pickBestSet } = require('./workout-sets')
const { exerciseKey } = require('./volume-by-muscle')
const { daysBetweenDateStrings } = require('./training-program')

// Owner-approved threshold (Apex triage #1417, F2): ±2.5% on the ranking metric
// (est_1rm for weighted exercises, best_reps_set for bodyweight ones) separates
// up/down from flat/noise.
const DELTA_THRESHOLD_PCT = 2.5

const STATUS_ORDER = { down: 0, flat: 1, up: 2, insufficient: 3 }

/** @param {{date: string, sets: Array<{weight_kg?: number, reps?: number}>}} session */
function computeSessionMetric(session) {
  const sets = session.sets || []
  const best = pickBestSet(sets)
  const weighted = hasPositiveWeight(sets)
  const total_volume = Math.round(sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0))
  return {
    date: session.date,
    weighted,
    best_set: { weight: best.weight, reps: best.reps },
    est_1rm: best.orm,
    total_volume,
  }
}

// The ranking metric used for delta/status classification: est_1rm for weighted
// sessions, best_reps_set for bodyweight ones (Apex F2: "те саме за best_reps_set").
function metricValue(metric) {
  return metric.weighted ? metric.est_1rm : metric.best_set.reps
}

/**
 * @param {number} prevValue
 * @param {number} lastValue
 * @returns {{delta_pct: number|null, status: 'up'|'down'|'flat'}}
 */
function classifyDelta(prevValue, lastValue) {
  // prev===0 (weighted) or any other falsy prev -> flat, never NaN/Infinity from a
  // 0-division (explicit F2 requirement, covered by a unit test).
  if (!prevValue) return { delta_pct: null, status: 'flat' }
  const delta_pct = ((lastValue - prevValue) / prevValue) * 100
  let status
  if (delta_pct > DELTA_THRESHOLD_PCT) status = 'up'
  else if (delta_pct < -DELTA_THRESHOLD_PCT) status = 'down'
  else status = 'flat'
  return { delta_pct: Math.round(delta_pct * 10) / 10, status }
}

// streak_up = consecutive 'up' pairs counted backward from the most recent session,
// same threshold rule as the headline status (Apex F2: "рахувати з кінця ряду
// поспіль за тим самим правилом порогу").
function computeStreakUp(metrics) {
  let streak = 0
  for (let i = metrics.length - 1; i > 0; i--) {
    const { status } = classifyDelta(metricValue(metrics[i - 1]), metricValue(metrics[i]))
    if (status !== 'up') break
    streak += 1
  }
  return streak
}

function toLastShape(metric) {
  return {
    date: metric.date,
    best_set: metric.best_set,
    est_1rm: metric.est_1rm,
    total_volume: metric.total_volume,
  }
}

function compareExercises(a, b) {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  if (byStatus !== 0) return byStatus
  // last.date desc
  if (a.last.date === b.last.date) return 0
  return a.last.date < b.last.date ? 1 : -1
}

/**
 * @param {object} params
 * @param {Array<{date: string, exercises: Array<{name: string, sets: Array}>}>} params.workouts
 *   raw `workouts` docs, any order (sorted here).
 * @param {Map<string, {muscle_group?: string}>} [params.libraryByName] keyed by
 *   exerciseKey(name) — same shape as routes/workouts.js's volume-by-muscle libraryByName.
 * @param {number} [params.window] last N sessions per exercise to consider; undefined = all.
 *   Route-level validation (integer >= 2) happens BEFORE this is called — this file
 *   trusts the value.
 * @param {string} params.todayStr Kyiv "today" as YYYY-MM-DD (caller supplies it —
 *   this file stays pure/no-Date-access for testability, per lib/exercise-progression.js).
 */
function buildExerciseTrends({ workouts = [], libraryByName = new Map(), window, todayStr }) {
  const sorted = [...workouts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const byKey = new Map() // exerciseKey -> { name, sessions: [{date, sets}] }
  for (const w of sorted) {
    for (const ex of w.exercises || []) {
      if (!ex || !ex.name) continue
      const key = exerciseKey(ex.name)
      if (!byKey.has(key)) byKey.set(key, { name: ex.name, sessions: [] })
      byKey.get(key).sessions.push({ date: w.date, sets: ex.sets || [] })
    }
  }

  const exercises = []
  for (const { name, sessions: allSessions } of byKey.values()) {
    const windowedSessions = window ? allSessions.slice(-window) : allSessions
    const metrics = windowedSessions.map(computeSessionMetric)
    const sessions_count = metrics.length
    if (sessions_count === 0) continue // defensive — a name entry with no sessions can't happen via the loop above

    const libraryEntry = libraryByName.get(exerciseKey(name))
    const muscle_group = libraryEntry?.muscle_group ?? null

    const lastMetric = metrics[metrics.length - 1]
    const days_since_last = daysBetweenDateStrings(lastMetric.date, todayStr)

    if (sessions_count < 2) {
      exercises.push({
        name,
        muscle_group,
        status: 'insufficient',
        sessions_count,
        last: toLastShape(lastMetric),
        prev: null,
        delta_1rm_pct: null,
        streak_up: 0,
        days_since_last,
      })
      continue
    }

    const prevMetric = metrics[metrics.length - 2]
    const { delta_pct, status } = classifyDelta(metricValue(prevMetric), metricValue(lastMetric))
    const streak_up = computeStreakUp(metrics)

    exercises.push({
      name,
      muscle_group,
      status,
      sessions_count,
      last: toLastShape(lastMetric),
      prev: toLastShape(prevMetric),
      delta_1rm_pct: delta_pct,
      streak_up,
      days_since_last,
    })
  }

  exercises.sort(compareExercises)

  return { generated_for: todayStr, exercises }
}

module.exports = {
  DELTA_THRESHOLD_PCT,
  computeSessionMetric,
  metricValue,
  classifyDelta,
  computeStreakUp,
  buildExerciseTrends,
}
