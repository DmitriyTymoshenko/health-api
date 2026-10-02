'use strict'

/**
 * #1693 Е1 — training-load engine for the /health «Тренування» tab (п.1, 2, 5, 6).
 * Pure functions, no DB access (same split as readiness.js / volume-by-muscle.js).
 *
 * Fat-loss-without-muscle-loss lens: the headline number is WORKING SETS per muscle
 * group per week (target zone 10–20 for big groups), NOT tonnage in kg.
 */

const { periodBounds, exerciseKey } = require('./volume-by-muscle')

// Weekly working-set target zones (min–max). Big groups 10–20 (owner/audit 02.10);
// arms 6–12 (they also get indirect volume from chest/back presses/pulls).
// Groups absent here (core, forearms, neck, other) get no target / no warning.
const SET_TARGETS = {
  chest: { min: 10, max: 20 },
  back: { min: 10, max: 20 },
  shoulders: { min: 10, max: 20 },
  legs: { min: 10, max: 20 },
  biceps: { min: 6, max: 12 },
  triceps: { min: 6, max: 12 },
}
const TARGET_GROUPS = Object.keys(SET_TARGETS)
const FREQUENCY_TARGET = 2 // sessions per group per week
const DELOAD_FACTOR = 0.6 // −40% sets
const DELOAD_EVERY_N_WEEKS = 4
const WEEK_IN_PROGRESS_PENDING_DAYS = 5 // before day 5 of an unfinished week a gap is «ще не пізно»
const STRENGTH_SPORT_RE = /(weight|strength|functional|powerlift|crossfit|hiit)/i

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000)
}

/** ISO-8601 week number of a YYYY-MM-DD date (deterministic, TZ-free). */
function isoWeekNumber(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
}

/** Every 4th ISO week is a deload week (−40% sets). Week = Monday-anchored `weekFrom`. */
function isDeloadWeek(weekFrom) {
  return isoWeekNumber(weekFrom) % DELOAD_EVERY_N_WEEKS === 0
}

function isWorkingSet(set) {
  if (!set) return false
  if (set.warmup === true || set.is_warmup === true || set.type === 'warmup') return false
  return (Number(set.reps) || 0) > 0 || (Number(set.duration_sec) || 0) > 0
}

/**
 * Working sets + distinct training days per muscle group.
 * @returns {Map<string,{sets:number,days:Set<string>}>}
 */
function setsByGroup(workouts, libraryByName, { toDate } = {}) {
  const out = new Map()
  for (const w of workouts || []) {
    if (toDate && w.date > toDate) continue
    for (const ex of Array.isArray(w.exercises) ? w.exercises : []) {
      const n = (Array.isArray(ex.sets) ? ex.sets : []).filter(isWorkingSet).length
      if (n === 0) continue
      const lib = libraryByName.get(exerciseKey(ex.name))
      const group = lib && lib.muscle_group ? lib.muscle_group : 'other'
      if (!out.has(group)) out.set(group, { sets: 0, days: new Set() })
      const g = out.get(group)
      g.sets += n
      g.days.add(w.date)
    }
  }
  return out
}

function groupStatus({ sets, min, weekComplete, elapsedDays }) {
  if (sets >= min) return 'ok'
  const pending = !weekComplete && elapsedDays < WEEK_IN_PROGRESS_PENDING_DAYS
  if (pending) return 'pending'
  return sets === 0 ? 'zero' : 'low'
}

/**
 * п.1 + п.2 + п.5: sets/week by group vs target zones, vs the SAME span of last week,
 * frequency per group, deload flag. `workouts90` = all logged workouts of the last 90d
 * (must cover prev week + current week + history for last_trained/avg).
 */
function buildWeeklySets({ workouts90, libraryByName, today, muscleOrder }) {
  const bounds = periodBounds('week', today)
  const weekComplete = today >= bounds.to
  const elapsedDays = Math.min(7, daysBetween(bounds.from, today) + 1)
  const deload = isDeloadWeek(bounds.from)
  const factor = deload ? DELOAD_FACTOR : 1

  const cur = setsByGroup(workouts90.filter((w) => w.date >= bounds.from && w.date <= bounds.to), libraryByName)
  const prevSpanTo = weekComplete ? bounds.prevTo : addDays(bounds.prevFrom, elapsedDays - 1)
  const prevInWeek = workouts90.filter((w) => w.date >= bounds.prevFrom && w.date <= bounds.prevTo)
  const prevSpan = setsByGroup(prevInWeek, libraryByName, { toDate: prevSpanTo })
  const prevFull = setsByGroup(prevInWeek, libraryByName)
  const all = setsByGroup(workouts90, libraryByName)
  const weeks90 = 90 / 7

  const lastTrained = new Map()
  for (const w of workouts90) {
    const tmp = setsByGroup([w], libraryByName)
    for (const g of tmp.keys()) {
      if (!lastTrained.has(g) || lastTrained.get(g) < w.date) lastTrained.set(g, w.date)
    }
  }

  const groupNames = [...new Set([...TARGET_GROUPS, ...cur.keys()])]
  const order = new Map(muscleOrder.map((g, i) => [g, i]))
  groupNames.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999))

  const groups = groupNames.map((group) => {
    const t = SET_TARGETS[group]
    const c = cur.get(group)
    const sets = c ? c.sets : 0
    const target = t
      ? { min: Math.round(t.min * factor), max: Math.round(t.max * factor), base_min: t.min, base_max: t.max }
      : null
    const a = all.get(group)
    return {
      muscle_group: group,
      sets,
      target,
      status: target ? groupStatus({ sets, min: target.min, weekComplete, elapsedDays }) : 'no_target',
      over: target ? sets > target.max : false,
      prev_sets_same_span: (prevSpan.get(group) || { sets: 0 }).sets,
      prev_sets_full_week: (prevFull.get(group) || { sets: 0 }).sets,
      frequency: c ? c.days.size : 0,
      frequency_target: t ? FREQUENCY_TARGET : null,
      sets_90d: a ? a.sets : 0,
      avg_sets_per_week_90d: a ? Math.round((a.sets / weeks90) * 10) / 10 : 0,
      last_trained: lastTrained.get(group) || null,
    }
  })

  const warnings = groups
    .filter((g) => g.target && (g.status === 'zero' || g.status === 'low'))
    .map((g) => ({
      muscle_group: g.muscle_group,
      kind: g.status,
      sets: g.sets,
      min: g.target.min,
      sets_90d: g.sets_90d,
    }))

  return {
    week: { from: bounds.from, to: bounds.to, complete: weekComplete, elapsed_days: elapsedDays },
    prev_span: { from: bounds.prevFrom, to: prevSpanTo },
    deload: { active: deload, factor, every_n_weeks: DELOAD_EVERY_N_WEEKS, iso_week: isoWeekNumber(bounds.from) },
    groups,
    warnings,
  }
}

const ms2min = (ms) => (Number(ms) || 0) / 60000

function avg(nums) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n))
  return v.length ? Math.round((v.reduce((s, n) => s + n, 0) / v.length) * 10) / 10 : null
}

/**
 * п.6: load vs recovery. `whoopWorkouts90` (whoop_workouts), `recovery28` (whoop_recovery,
 * ≥28d back from `today`), `workouts90` (logged strength sessions).
 */
function buildLoadRecovery({ today, whoopWorkouts90, recovery28, workouts90 }) {
  const from7 = addDays(today, -6)
  const from28 = addDays(today, -27)
  const weeks90 = 90 / 7
  const scored = (whoopWorkouts90 || []).filter((w) => w.score_state !== 'UNSCORABLE')

  const zoneMin = (list, key) => list.reduce((s, w) => s + ms2min(w[key]), 0)
  const z2 = zoneMin(scored, 'zone_two_ms')
  const z3plus = zoneMin(scored, 'zone_three_ms') + zoneMin(scored, 'zone_four_ms') + zoneMin(scored, 'zone_five_ms')

  const loggedSessions = (workouts90 || []).filter((w) => Array.isArray(w.exercises) && w.exercises.length > 0)
  const strengthWhoop = scored.filter((w) => STRENGTH_SPORT_RE.test(w.sport_name || '') && (w.duration_min || 0) >= 30)

  const activeDays = (fromDate) => {
    const set = new Set()
    for (const w of scored) if (w.date >= fromDate && w.date <= today) set.add(w.date)
    for (const w of loggedSessions) if (w.date >= fromDate && w.date <= today) set.add(w.date)
    return set
  }
  const a7 = activeDays(from7)
  const a28 = activeDays(from28)
  const rec = (fromDate) => (recovery28 || []).filter((r) => r.date >= fromDate && r.date <= today).map((r) => r.recovery_score)
  const inRange = (list, fromDate) => list.filter((w) => w.date >= fromDate && w.date <= today)

  const sportBreakdown = {}
  for (const w of inRange(scored, from7)) {
    const k = w.sport_name || 'other'
    sportBreakdown[k] = (sportBreakdown[k] || 0) + (w.duration_min || 0)
  }

  const r7 = avg(rec(from7))
  const r28 = avg(rec(from28))
  return {
    window_days: 90,
    cardio_zones_per_week: {
      z2_min: Math.round(z2 / weeks90),
      z3plus_min: Math.round(z3plus / weeks90),
    },
    strength: {
      logged_sessions_90d: loggedSessions.length,
      logged_sessions_7d: inRange(loggedSessions, from7).length,
      whoop_sessions_90d: strengthWhoop.length,
      unlogged_gap_90d: Math.max(0, strengthWhoop.length - loggedSessions.length),
    },
    last_7d: {
      sessions_whoop: inRange(scored, from7).length,
      minutes_by_sport: sportBreakdown,
      rest_days: 7 - a7.size,
      avg_recovery: r7,
    },
    last_28d: {
      sessions_whoop: inRange(scored, from28).length,
      rest_days: 28 - a28.size,
      avg_recovery: r28,
    },
    recovery_trend: r7 != null && r28 != null ? Math.round((r7 - r28) * 10) / 10 : null,
  }
}

module.exports = {
  SET_TARGETS,
  DELOAD_FACTOR,
  DELOAD_EVERY_N_WEEKS,
  isoWeekNumber,
  isDeloadWeek,
  isWorkingSet,
  setsByGroup,
  buildWeeklySets,
  buildLoadRecovery,
  addDays,
}
