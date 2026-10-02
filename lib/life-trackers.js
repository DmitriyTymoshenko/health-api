'use strict'

// #1602 (SPEC v2 §11.4, §12, §17) — tracker-habits, frequencies, stats,
// don't-miss-twice and nudge triggers. Pure, DB-free logic (the route file
// feeds it plain data), same split as lib/life-rules.js.
//
// DECISION (apex, #1602): a tracker habit stores NO own check-ins. Its day
// state is DERIVED at read time from the existing health-api collections
// (water_log / supplements_log / weight_log / steps_log) — /health keeps
// writing them exactly as before, so there is one source of truth.

const { addDaysToKyivDay } = require('./kyiv-day')

const TRACKER_SOURCES = Object.freeze(['water', 'supplements', 'weight', 'steps'])
const FREQUENCY_KINDS = Object.freeze(['daily', 'weekdays', 'weekly_n'])
const TRIGGER_KINDS = Object.freeze(['time', 'weekday_time', 'stale_metric'])
const STALE_METRICS = Object.freeze(['weight', 'steps', 'water'])
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_STATS_DAYS = 365

// source -> where its per-day facts live
const SOURCE_COLLECTION = Object.freeze({
  water: 'water_log',
  supplements: 'supplements_log',
  weight: 'weight_log',
  steps: 'steps_log',
})

/** ISO weekday (Mon=1..Sun=7) of a Kyiv day string. */
function isoWeekday(day) {
  const dow = new Date(day + 'T12:00:00Z').getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Monday (Kyiv day string) of the ISO week containing `day`. */
function weekStart(day) {
  return addDaysToKyivDay(day, 1 - isoWeekday(day))
}

// ---- validation (return {error} or {value}) -----------------------------

function validateFrequency(input) {
  if (input === undefined || input === null) return { value: { kind: 'daily' } }
  if (typeof input !== 'object' || !FREQUENCY_KINDS.includes(input.kind)) {
    return { error: `frequency.kind must be one of ${FREQUENCY_KINDS.join('|')}` }
  }
  if (input.kind === 'daily') return { value: { kind: 'daily' } }
  if (input.kind === 'weekdays') {
    const days = input.days
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
      return { error: 'frequency.days must be a non-empty array of ISO weekdays 1..7' }
    }
    return { value: { kind: 'weekdays', days: [...new Set(days)].sort((a, b) => a - b) } }
  }
  const n = input.n
  if (!Number.isInteger(n) || n < 1 || n > 7) return { error: 'frequency.n must be an integer 1..7' }
  return { value: { kind: 'weekly_n', n } }
}

function validateTracker(input, { type } = {}) {
  if (input === undefined || input === null) return { value: null }
  if (type === 'break') return { error: 'tracker is only allowed on build habits' }
  if (typeof input !== 'object' || !TRACKER_SOURCES.includes(input.source)) {
    return { error: `tracker.source must be one of ${TRACKER_SOURCES.join('|')}` }
  }
  const t = input.threshold
  const needsThreshold = input.source === 'water' || input.source === 'steps'
  if (t === undefined || t === null) {
    if (needsThreshold) return { error: `tracker.threshold is required for ${input.source}` }
    return { value: { source: input.source, threshold: null } }
  }
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return { error: 'tracker.threshold must be a positive number' }
  return { value: { source: input.source, threshold: t } }
}

function validateTriggers(input) {
  if (input === undefined || input === null) return { value: [] }
  if (!Array.isArray(input) || input.length > 5) return { error: 'triggers must be an array of at most 5' }
  const out = []
  for (const t of input) {
    if (!t || typeof t !== 'object' || !TRIGGER_KINDS.includes(t.kind)) {
      return { error: `trigger.kind must be one of ${TRIGGER_KINDS.join('|')}` }
    }
    if (t.kind === 'time') {
      if (!HHMM_RE.test(t.time || '')) return { error: 'trigger.time must be HH:MM' }
      out.push({ kind: 'time', time: t.time })
    } else if (t.kind === 'weekday_time') {
      if (!Number.isInteger(t.weekday) || t.weekday < 1 || t.weekday > 7) return { error: 'trigger.weekday must be ISO 1..7' }
      if (!HHMM_RE.test(t.time || '')) return { error: 'trigger.time must be HH:MM' }
      out.push({ kind: 'weekday_time', weekday: t.weekday, time: t.time })
    } else {
      if (!STALE_METRICS.includes(t.metric)) return { error: `trigger.metric must be one of ${STALE_METRICS.join('|')}` }
      if (!Number.isInteger(t.max_age_days) || t.max_age_days < 1 || t.max_age_days > 90) {
        return { error: 'trigger.max_age_days must be an integer 1..90' }
      }
      out.push({ kind: 'stale_metric', metric: t.metric, max_age_days: t.max_age_days })
    }
  }
  return { value: out }
}

// ---- tracker day state -------------------------------------------------

/**
 * Per-day state of a tracker from raw docs of its source collection.
 * Returns Map day -> { value, met }. A day with no docs is simply absent
 * (honest "no data", never 0).
 */
function trackerStatesByDay(tracker, docs) {
  const byDay = new Map()
  const group = {}
  for (const d of docs || []) {
    if (!d || !d.date) continue
    ;(group[d.date] = group[d.date] || []).push(d)
  }
  const th = tracker.threshold
  for (const [day, list] of Object.entries(group)) {
    if (tracker.source === 'water') {
      const value = list.reduce((s, e) => s + (Number(e.amount_ml) || 0), 0)
      byDay.set(day, { value, met: value >= th })
    } else if (tracker.source === 'steps') {
      const value = Math.max(...list.map((e) => Number(e.steps) || 0))
      byDay.set(day, { value, met: value >= th })
    } else if (tracker.source === 'weight') {
      const withKg = list.filter((e) => typeof e.weight_kg === 'number')
      if (!withKg.length) continue
      byDay.set(day, { value: withKg[withKg.length - 1].weight_kg, met: true })
    } else {
      const taken = list.filter((e) => e.taken === true).length
      const met = th != null ? taken >= th : taken === list.length && list.length > 0
      byDay.set(day, { value: taken, total: list.length, met })
    }
  }
  return byDay
}

// ---- periods, streaks, don't-miss-twice --------------------------------

/**
 * Scheduled calendar days (daily/weekdays) in [fromDay, toDay], oldest first.
 * weekly_n has no fixed days — every day is eligible, evaluation is by week.
 */
function scheduledDays(frequency, fromDay, toDay) {
  const out = []
  for (let d = fromDay; d <= toDay; d = addDaysToKyivDay(d, 1)) {
    if (frequency.kind === 'weekdays' && !frequency.days.includes(isoWeekday(d))) continue
    out.push(d)
  }
  return out
}

/**
 * Collapse per-day booleans into evaluation periods.
 *  - daily/weekdays: a period = one scheduled day
 *  - weekly_n: a period = one ISO week; met = (>= n done days). The first,
 *    partial week (habit created after Monday) is NOT a period — no miss is
 *    charged for days before the habit existed.
 * `doneByDay`: object day -> boolean. `today` is the (unfinished) current day.
 * Returns { past: boolean[] (completed periods, oldest first),
 *           current: {done, scheduled, count?} , totalDone, totalPeriods }.
 * ABSENCE TODAY IS NOT A MISS: the current period never enters `past`.
 */
function evaluatePeriods(frequency, createdDay, today, doneByDay) {
  if (frequency.kind === 'weekly_n') {
    const firstWeek = weekStart(createdDay)
    const startWeek = createdDay === firstWeek ? firstWeek : addDaysToKyivDay(firstWeek, 7)
    const curWeek = weekStart(today)
    const past = []
    for (let w = startWeek; w < curWeek; w = addDaysToKyivDay(w, 7)) {
      let count = 0
      for (let i = 0; i < 7; i++) if (doneByDay[addDaysToKyivDay(w, i)]) count++
      past.push(count >= frequency.n)
    }
    let curCount = 0
    for (let d = curWeek; d <= today; d = addDaysToKyivDay(d, 1)) if (doneByDay[d]) curCount++
    let totalDone = past.filter(Boolean).length
    const curDone = curCount >= frequency.n
    if (curDone) totalDone++
    return {
      past,
      current: { scheduled: true, done: curDone, count: curCount },
      totalDone,
      totalPeriods: past.length + (curDone ? 1 : 0),
    }
  }
  const days = scheduledDays(frequency, createdDay, today)
  const pastDays = days.filter((d) => d < today)
  const past = pastDays.map((d) => !!doneByDay[d])
  const scheduledToday = days.includes(today)
  const curDone = scheduledToday ? !!doneByDay[today] : false
  const totalDone = past.filter(Boolean).length + (curDone ? 1 : 0)
  return {
    past,
    current: { scheduled: scheduledToday, done: curDone },
    totalDone,
    totalPeriods: past.length + (curDone ? 1 : 0),
  }
}

/** Consecutive done periods ending at the latest completed one (+ current if done). */
function currentStreak(past, currentDone) {
  let n = 0
  for (let i = past.length - 1; i >= 0 && past[i]; i--) n++
  return currentDone ? n + 1 : n
}

function bestStreak(past, currentDone) {
  let best = 0
  let run = 0
  for (const ok of [...past, currentDone]) {
    run = ok ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

/**
 * Don't-miss-twice (Clear): one miss is fine, two in a row is a new habit.
 *   'ok'       — nothing to worry about / already done in the current period
 *   'at_risk'  — the previous period was missed and the current one is not
 *                done yet: THIS is the one that must not be missed
 *   'broken'   — the last two completed periods were both missed and the
 *                current one is not done
 *   'n/a'      — no completed period yet, or today is not a scheduled day
 * An absent check-in TODAY is never itself a miss (SPEC §12): it only counts
 * once the period has ended and lands in `past`.
 */
function dontMissTwice(past, current) {
  if (!current || !current.scheduled) return 'n/a'
  if (past.length === 0) return 'n/a'
  if (current.done) return 'ok'
  const last = past[past.length - 1]
  const prev = past.length >= 2 ? past[past.length - 2] : true
  if (!last && !prev) return 'broken'
  if (!last) return 'at_risk'
  return 'ok'
}

/**
 * Habit stats from `doneByDay` (see evaluatePeriods). `windowDays` limits the
 * % and counts to the trailing window; streaks/votes use full history.
 */
function computeStats({ habit, today, doneByDay, windowDays = 30, daysClean = null }) {
  const frequency = habit.frequency && habit.frequency.kind ? habit.frequency : { kind: 'daily' }
  const createdDay = habit.created_day
  const full = evaluatePeriods(frequency, createdDay, today, doneByDay)

  const winFrom = addDaysToKyivDay(today, -(windowDays - 1))
  const winStart = winFrom > createdDay ? winFrom : createdDay
  const win = evaluatePeriods(frequency, winStart, today, doneByDay)
  const periods = win.past.length + (win.current.scheduled ? (win.current.done ? 1 : 0) : 0)
  const done = win.past.filter(Boolean).length + (win.current.done ? 1 : 0)

  return {
    streak: currentStreak(full.past, full.current.done),
    best_streak: bestStreak(full.past, full.current.done),
    window_days: windowDays,
    periods_in_window: periods,
    done_in_window: done,
    pct: periods > 0 ? Math.round((done / periods) * 100) : null,
    clean_days: habit.type === 'break' ? daysClean : null,
    identity: habit.identity ?? null,
    identity_votes: full.totalDone,
    dont_miss_twice: dontMissTwice(full.past, full.current),
    today: { scheduled: full.current.scheduled, done: full.current.done },
  }
}

// ---- nudges -------------------------------------------------------------

/**
 * Deterministic nudge evaluation. Pure: `ctx` carries everything.
 *  ctx = { now: {day, hhmm, weekday}, habit, doneToday: boolean|null,
 *          scheduledToday: boolean, latestDates: {weight, steps, water},
 *          acked: Set<'habitId|kind|key'> }
 * Returns an array of due nudges (possibly empty). A habit already done in
 * the current period never gets a time-based nudge.
 */
function dueNudgesForHabit(ctx) {
  const { now, habit, doneToday, scheduledToday, latestDates, acked } = ctx
  const out = []
  const hid = String(habit._id)
  for (const t of habit.triggers || []) {
    if (t.kind === 'time' || t.kind === 'weekday_time') {
      if (!scheduledToday || doneToday === true) continue
      if (t.kind === 'weekday_time' && t.weekday !== now.weekday) continue
      if (now.hhmm < t.time) continue
      const key = `${t.kind}:${t.weekday || ''}:${t.time}:${now.day}`
      if (acked.has(`${hid}|${key}`)) continue
      out.push({ habit_id: hid, habit_name: habit.name, kind: t.kind, key, time: t.time, reason: `${habit.name}: ${t.time}` })
    } else if (t.kind === 'stale_metric') {
      const last = latestDates[t.metric] || null
      const age = last ? daysBetween(last, now.day) : null
      if (age !== null && age <= t.max_age_days) continue
      const key = `stale_metric:${t.metric}:${now.day}`
      if (acked.has(`${hid}|${key}`)) continue
      out.push({
        habit_id: hid,
        habit_name: habit.name,
        kind: 'stale_metric',
        key,
        metric: t.metric,
        age_days: age,
        reason: age === null ? `${t.metric}: даних немає` : `${t.metric}: останній запис ${age} дн. тому (ліміт ${t.max_age_days})`,
      })
    }
  }
  return out
}

function daysBetween(fromDay, toDay) {
  return Math.round((new Date(toDay + 'T12:00:00Z') - new Date(fromDay + 'T12:00:00Z')) / 86400000)
}

module.exports = {
  TRACKER_SOURCES,
  FREQUENCY_KINDS,
  TRIGGER_KINDS,
  STALE_METRICS,
  SOURCE_COLLECTION,
  MAX_STATS_DAYS,
  isoWeekday,
  weekStart,
  validateFrequency,
  validateTracker,
  validateTriggers,
  trackerStatesByDay,
  scheduledDays,
  evaluatePeriods,
  currentStreak,
  bestStreak,
  dontMissTwice,
  computeStats,
  dueNudgesForHabit,
  daysBetween,
}
