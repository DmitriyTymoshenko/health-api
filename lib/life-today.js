'use strict'

// #1601 (SPEC #1518 §10–§17, stage 1 «Сьогодні») — pure helpers + HTTP-backed
// source adapters for the extended GET /api/life/today. No DB access here.
//
// Honesty rules (SPEC §16): a block whose source is unavailable is `null` + a
// `*_reason`; the other blocks still render. "No data" is never 0.

const { toKyivDay } = require('./kyiv-day')

const MAX_FOCUS_PER_DAY = 3
const MAX_CALENDAR_EVENTS = 20
const MIN_FREE_WINDOW_MIN = 90
const WINDOW_START = '08:00'
const WINDOW_END = '21:00'

// SPEC §15: advice is a FIXED table in code (not an LLM). Key = recovery zone
// from lib/recovery-zone.js (hard|moderate|light); a streak of ≥2 yellow/red
// days (readiness.yellow_red_streak_days) overrides the moderate phrase.
const ADVICE_TABLE = Object.freeze({
  hard: 'зелена зона — можна навантажувати за планом',
  moderate: 'жовта зона — тримай обсяг, без рекордів',
  moderate_streak: 'кілька днів поспіль не в зеленій — легший день, без важкого тренування',
  light: 'червона зона — легкий день, без важкого тренування',
})

function buildAdvice(zone, streakDays) {
  if (zone === 'light') return ADVICE_TABLE.light
  if (zone === 'moderate') return streakDays >= 2 ? ADVICE_TABLE.moderate_streak : ADVICE_TABLE.moderate
  if (zone === 'hard') return ADVICE_TABLE.hard
  return null
}

function hourMinuteKyiv(date) {
  const s = date.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Kiev', hour: '2-digit', minute: '2-digit', hour12: false })
  return s.slice(0, 5)
}

/** The UTC instant of Kyiv wall-clock `HH:MM` on Kyiv `day` (DST-safe: tries +3 then +2). */
function kyivInstant(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  for (const off of [3, 2]) {
    const cand = new Date(Date.UTC(y, m - 1, d, h - off, mi))
    if (toKyivDay(cand) === day && hourMinuteKyiv(cand) === hhmm) return cand
  }
  return new Date(Date.UTC(y, m - 1, d, h - 3, mi))
}

/**
 * Free gaps ≥ minMinutes inside 08:00–21:00 Kyiv. Timed events block; all-day
 * events do not (they carry no clock time). Returns [{start,end,minutes}] ISO.
 */
function computeFreeWindows(events, day, minMinutes = MIN_FREE_WINDOW_MIN) {
  const winStart = kyivInstant(day, WINDOW_START).getTime()
  const winEnd = kyivInstant(day, WINDOW_END).getTime()
  const busy = (events || [])
    .filter((e) => e && !e.all_day)
    .map((e) => [new Date(e.start).getTime(), new Date(e.end).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .map(([s, e]) => [Math.max(s, winStart), Math.min(e, winEnd)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  const out = []
  let cursor = winStart
  const push = (from, to) => {
    const minutes = Math.floor((to - from) / 60000)
    if (minutes >= minMinutes) out.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString(), minutes })
  }
  for (const [s, e] of busy) {
    if (s > cursor) push(cursor, s)
    cursor = Math.max(cursor, e)
  }
  if (winEnd > cursor) push(cursor, winEnd)
  return out
}

/** Validate + normalise PUT /calendar-snapshot events. Returns {events} or {error}. */
function normalizeEvents(raw) {
  if (!Array.isArray(raw)) return { error: 'events must be an array' }
  if (raw.length > MAX_CALENDAR_EVENTS) return { error: `events: max ${MAX_CALENDAR_EVENTS}` }
  const events = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') return { error: 'event must be an object' }
    if (typeof e.title !== 'string') return { error: 'event.title must be a string' }
    const s = new Date(e.start)
    const en = new Date(e.end)
    if (Number.isNaN(s.getTime()) || Number.isNaN(en.getTime())) return { error: 'event.start/end must be ISO date-times' }
    events.push({ start: s.toISOString(), end: en.toISOString(), title: e.title.slice(0, 200), all_day: e.all_day === true })
  }
  events.sort((a, b) => a.start.localeCompare(b.start))
  return { events }
}

/** Calendar block for /today. snapshot=null → block null + reason (NOT "no events"). */
function buildCalendarBlock(snapshot, { day, todayDay, now = new Date() }) {
  if (!snapshot) return { block: null, reason: 'Календар не синхронізовано' }
  const events = snapshot.events || []
  const upcoming = day === todayDay ? events.filter((e) => new Date(e.end).getTime() > now.getTime()) : events
  const freeWindows = (snapshot.free_windows || []).filter(
    (w) => day !== todayDay || new Date(w.end).getTime() > now.getTime()
  )
  return {
    block: {
      events: upcoming.slice(0, 3),
      free_windows: freeWindows,
      fetched_at: snapshot.fetched_at instanceof Date ? snapshot.fetched_at.toISOString() : snapshot.fetched_at,
    },
    reason: null,
  }
}

function buildStateBlock(readiness, whoop) {
  if (!readiness || readiness.data_fresh === false || readiness.recovery_score == null) {
    return { block: null, reason: 'немає свіжого recovery з WHOOP' }
  }
  const sleep = whoop && !whoop.no_data && typeof whoop.sleep_hours === 'number' ? whoop.sleep_hours : null
  const strain = whoop && !whoop.no_data && typeof whoop.strain === 'number' ? Math.round(whoop.strain * 10) / 10 : null
  return {
    block: {
      recovery_score: readiness.recovery_score,
      recovery_zone: readiness.recovery_zone,
      sleep_h: sleep,
      strain,
      advice: buildAdvice(readiness.recovery_zone, readiness.yellow_red_streak_days || 0),
      as_of: (whoop && whoop.last_synced) || readiness.date,
    },
    reason: null,
  }
}

function buildFoodBlock(summary, day) {
  if (!summary || !(summary.items > 0)) return { block: null, reason: 'їжу за сьогодні ще не записано' }
  const left = (goal, val) => (typeof goal === 'number' && typeof val === 'number' ? Math.round((goal - val) * 10) / 10 : null)
  const kcalGoal = typeof summary.kcal_goal === 'number' ? summary.kcal_goal : null
  const proteinGoal = typeof summary.protein_goal_g === 'number' ? summary.protein_goal_g : null
  return {
    block: {
      kcal: summary.kcal,
      kcal_goal: kcalGoal,
      kcal_left: left(kcalGoal, summary.kcal),
      protein_g: summary.protein_g,
      protein_goal: proteinGoal,
      protein_left: left(proteinGoal, summary.protein_g),
      as_of: day,
    },
    reason: null,
  }
}

/**
 * Loopback HTTP sources. NB food reads `/api/nutrition/summary?date=<kyiv day>`,
 * NEVER `/summary/today` (that one derives the day from UTC — wrong 00:00–03:00 Kyiv).
 */
function makeHttpSources(baseUrl, fetchImpl) {
  const f = fetchImpl || ((...a) => fetch(...a))
  const get = async (path) => {
    const res = await f(`${baseUrl}${path}`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`${path} → ${res.status}`)
    return res.json()
  }
  return {
    readiness: (day) => get(`/api/readiness?date=${day}`),
    whoop: (day) => get(`/api/whoop/summary?date=${day}`),
    nutrition: (day) => get(`/api/nutrition/summary?date=${day}`),
  }
}

async function settle(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

module.exports = {
  MAX_FOCUS_PER_DAY, MAX_CALENDAR_EVENTS, MIN_FREE_WINDOW_MIN, ADVICE_TABLE,
  buildAdvice, kyivInstant, computeFreeWindows, normalizeEvents,
  buildCalendarBlock, buildStateBlock, buildFoodBlock, makeHttpSources, settle,
}
