'use strict'

/**
 * Readiness badge engine — task #1292 (Ф3), owner-approved combination rule
 * (Дмитро 09.09, «беремо НИЖЧИЙ з двох сигналів»; start confirmed 19.09 «давай
 * робити тоді червоний блок весь»). Pure function, no DB access — same split as
 * every other lib/*.js consumed by a thin routes/*.js (exercise-trends.js,
 * exercise-progression.js, training-program.js). Unit-testable without Mongo.
 *
 * Signal A — recovery zone. REUSE lib/recovery-zone.js — the SAME thresholds
 *   GET /api/activity-plan/suggest already uses live (>=67 hard/🟢, >=34
 *   moderate/🟡, else light/🔴). A 2-consecutive-yellow/red-DAY streak forces
 *   base_only regardless of what a single day's zone alone would say.
 *
 * Signal B — REUSE lib/exercise-trends.js::buildExerciseTrends() (#1417) for
 *   TODAY'S PROGRAM-DAY exercises only. status down/flat = "stalled". status
 *   insufficient is explicitly NOT stalled (no history yet is not a regression —
 *   task body, 09.09) and is surfaced separately via trend_coverage so the UI can
 *   say "N вправ ще без історії" instead of silently ignoring them.
 *
 * data_fresh guard: if there is no recovery score for the requested day, the
 * engine returns data_fresh:false / level:null and NEVER computes a level from a
 * defaulted recovery score. This is the opposite of routes/activity_plan.js's
 * `recovery?.recovery_score ?? 65` — that default is INTENTIONALLY left alone in
 * /suggest (task constraint: don't rewrite /suggest beyond the helper extraction),
 * but readiness must not inherit it, because a badge that prints a confident
 * recommendation is worse than a badge that says "no data" (Phil, #1292 comment).
 */

const { recoveryZone } = require('./recovery-zone')

const ZONE_LEVEL = { hard: 'as_planned', moderate: 'hold', light: 'base_only' }
const ZONE_EMOJI = { hard: '🟢', moderate: '🟡', light: '🔴' }
const YELLOW_RED_STREAK_FOR_BASE_ONLY = 2
const LEVEL_RANK = { as_planned: 2, hold: 1, base_only: 0 }

function isYellowOrRed(zone) {
  return zone === 'moderate' || zone === 'light'
}

/** @param {string} dateStr YYYY-MM-DD @returns {string} the previous calendar day, YYYY-MM-DD */
function previousDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Consecutive yellow/red DAYS ending at todayStr (inclusive). A missing day (no
 * recovery doc) breaks the streak — a data gap is never silently treated as
 * yellow/red, and it is never silently treated as green either; it just stops
 * counting there.
 * @param {Array<{date: string, recovery_score: number}>} recoveryHistory any order
 * @param {string} todayStr
 * @returns {number}
 */
function computeYellowRedStreak(recoveryHistory, todayStr) {
  const byDate = new Map(recoveryHistory.map((r) => [r.date, r]))
  const today = byDate.get(todayStr)
  if (!today || !isYellowOrRed(recoveryZone(today.recovery_score))) return 0

  let streak = 0
  let cursor = todayStr
  for (;;) {
    const doc = byDate.get(cursor)
    if (!doc || !isYellowOrRed(recoveryZone(doc.recovery_score))) break
    streak += 1
    cursor = previousDateStr(cursor)
  }
  return streak
}

/**
 * @param {{exercises: Array<object>}} trendsResult buildExerciseTrends() output
 * @param {Array<{name: string}>} todayExercises today's program-day exercise list
 *   (day.exercises from GET /api/training-program/today), or [] when today isn't a
 *   scheduled training day.
 * @returns {{stalled: Array<object>, trend_coverage: {evaluated: number, insufficient: number}}}
 */
function stalledExercisesForToday(trendsResult, todayExercises) {
  const todayNames = new Set((todayExercises || []).map((e) => e.name))
  const byName = new Map((trendsResult?.exercises || []).map((e) => [e.name, e]))
  const stalled = []
  let evaluated = 0
  let insufficient = 0

  for (const name of todayNames) {
    const t = byName.get(name)
    if (!t || t.status === 'insufficient') {
      insufficient += 1
      continue
    }
    evaluated += 1
    if (t.status === 'down' || t.status === 'flat') {
      stalled.push({
        name: t.name,
        status: t.status,
        sessions_count: t.sessions_count,
        delta_1rm_pct: t.delta_1rm_pct,
        prev: t.prev,
        last: t.last,
      })
    }
  }
  return { stalled, trend_coverage: { evaluated, insufficient } }
}

function combineLevel(recoveryLevel, stalledCount) {
  const signalBLevel = stalledCount > 0 ? 'hold' : 'as_planned'
  return LEVEL_RANK[recoveryLevel] <= LEVEL_RANK[signalBLevel] ? recoveryLevel : signalBLevel
}

function formatStalledNames(stalled) {
  return stalled
    .map((s) => (s.sessions_count ? `${s.name} стоїть ${s.sessions_count} сесії` : `${s.name} стоїть`))
    .join(', ')
}

function buildReasonText({ level, recoveryScore, zone, streak, stalled }) {
  const emoji = ZONE_EMOJI[zone]
  const recoveryPart =
    streak >= YELLOW_RED_STREAK_FOR_BASE_ONLY
      ? `recovery ${recoveryScore} ${emoji} (${streak}-й день поспіль)`
      : `recovery ${recoveryScore} ${emoji}`

  if (level === 'as_planned') {
    return `план як є — ${recoveryPart}, прогрес по вправах є`
  }
  if (stalled.length === 0) {
    return `тримай обсяг — ${recoveryPart}`
  }
  return `тримай обсяг — ${recoveryPart}, ${formatStalledNames(stalled)}`
}

/**
 * @param {object} params
 * @param {{date: string, recovery_score: number}|null} params.recoveryToday
 * @param {Array<{date: string, recovery_score: number}>} params.recoveryHistory
 *   trailing window INCLUDING today, any order.
 * @param {{exercises: Array<object>}} params.exerciseTrends buildExerciseTrends() output
 * @param {Array<{name: string}>} params.todayExercises today's program-day exercises, or []
 * @param {string} params.todayStr YYYY-MM-DD (Kyiv calendar day)
 * @param {{start: string, end: string}|null} [params.sleepWindow] the night the
 *   recoveryToday score was computed from (owner acceptance: "для контрольної дати
 *   показати recovery-значення і межі ночі, з якої воно взяте" — proves the badge
 *   isn't built on a glued/misaligned night, #1296).
 * @returns {{
 *   level: 'as_planned'|'hold'|'base_only'|null,
 *   recovery_score: number|null,
 *   recovery_zone: 'hard'|'moderate'|'light'|null,
 *   yellow_red_streak_days: number,
 *   stalled_exercises: Array<object>,
 *   trend_coverage: {evaluated: number, insufficient: number},
 *   sleep_window: {start: string, end: string}|null,
 *   reason_text: string,
 *   data_fresh: boolean,
 * }}
 */
function buildReadiness({ recoveryToday, recoveryHistory, exerciseTrends, todayExercises, todayStr, sleepWindow }) {
  if (!recoveryToday) {
    return {
      level: null,
      recovery_score: null,
      recovery_zone: null,
      yellow_red_streak_days: 0,
      stalled_exercises: [],
      trend_coverage: { evaluated: 0, insufficient: 0 },
      sleep_window: null,
      reason_text: 'немає свіжих даних WHOOP за сьогодні',
      data_fresh: false,
    }
  }

  const zone = recoveryZone(recoveryToday.recovery_score)
  const recoveryLevel = ZONE_LEVEL[zone]
  const streak = computeYellowRedStreak(recoveryHistory || [], todayStr)
  const { stalled, trend_coverage } = stalledExercisesForToday(exerciseTrends, todayExercises)

  let level = combineLevel(recoveryLevel, stalled.length)
  if (streak >= YELLOW_RED_STREAK_FOR_BASE_ONLY) level = 'base_only'

  const reason_text = buildReasonText({ level, recoveryScore: recoveryToday.recovery_score, zone, streak, stalled })

  return {
    level,
    recovery_score: recoveryToday.recovery_score,
    recovery_zone: zone,
    yellow_red_streak_days: streak,
    stalled_exercises: stalled,
    trend_coverage,
    sleep_window: sleepWindow || null,
    reason_text,
    data_fresh: true,
  }
}

module.exports = {
  YELLOW_RED_STREAK_FOR_BASE_ONLY,
  computeYellowRedStreak,
  stalledExercisesForToday,
  combineLevel,
  buildReadiness,
}
