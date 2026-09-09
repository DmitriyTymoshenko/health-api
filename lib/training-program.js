'use strict'

/**
 * Shared training-program logic — ONE definition, used by routes/training_program.js
 * AND by src/tests/training_program.test.ts directly (no mirror-test duplication,
 * per the #966/#988 lesson: "a stub of the same typo only proves the typo").
 *
 * Task #1290 (Ф1 MVP), owner-approved 2026-09-09. KB #2542 has the full multi-phase
 * spec; this file implements ONLY the Ф1 scope: program storage + "today" lookup.
 * Adherence (#1291) and the readiness engine (#1292) are separate backlog tasks —
 * intentionally not touched here.
 */

// ---------------------------------------------------------------------------
// Kyiv-day helpers (byte-identical algorithm to src/tests/utils/kyivDayBounds.ts
// ::formatDateKyiv — that file is a TEST assertion helper imported only by *.test.ts;
// this is the PRODUCTION code path the route actually runs, so a separate copy here
// is required, not a diverging 3rd implementation of the concept. Do not fork the
// algorithm itself if it ever changes.)
// ---------------------------------------------------------------------------

/** @param {Date} date @returns {string} YYYY-MM-DD, Kyiv calendar day */
function formatDateKyiv(date) {
  return date.toLocaleString('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

const ISO_WEEKDAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** @param {Date} date @returns {number} ISO weekday in Kyiv time, 1=Mon..7=Sun */
function getKyivIsoWeekday(date) {
  const short = date.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', weekday: 'short' })
  return ISO_WEEKDAY_MAP[short]
}

/** @param {string} fromStr @param {string} toStr both YYYY-MM-DD @returns {number} calendar days from→to */
function daysBetweenDateStrings(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number)
  const [ty, tm, td] = toStr.split('-').map(Number)
  const fromUTC = Date.UTC(fy, fm - 1, fd)
  const toUTC = Date.UTC(ty, tm - 1, td)
  return Math.round((toUTC - fromUTC) / 86400000)
}

// ---------------------------------------------------------------------------
// Wave/periodization math
// ---------------------------------------------------------------------------

/**
 * current_week is DERIVED from start_date, never stored — a wave rolls over
 * continuously (week N+1 after the last phase wraps back to week 1) so the doc
 * never needs a cron to "advance" it.
 * @param {string} startDateStr YYYY-MM-DD
 * @param {number} waveWeeks
 * @param {string} todayStr YYYY-MM-DD (Kyiv day)
 * @returns {number} 1-indexed current week within the wave
 */
function computeCurrentWeek(startDateStr, waveWeeks, todayStr) {
  if (!startDateStr || !waveWeeks || waveWeeks < 1) return 1
  const daysSince = daysBetweenDateStrings(startDateStr, todayStr)
  if (daysSince < 0) return 1 // program hasn't started yet
  const weekIndex0 = Math.floor(daysSince / 7) % waveWeeks
  return weekIndex0 + 1
}

/**
 * @param {string[]} phases e.g. ["База","Білд","Пік","Deload"]
 * @param {number} currentWeek 1-indexed
 * @returns {string|null}
 */
function phaseForWeek(phases, currentWeek) {
  if (!Array.isArray(phases) || phases.length === 0) return null
  return phases[(currentWeek - 1) % phases.length] ?? null
}

// ---------------------------------------------------------------------------
// Schedule resolution — which day (A/B/home) trains on which Kyiv weekday
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, number[]>} schedule e.g. { A: [1], B: [3], home: [5] }
 * @param {number} isoWeekday 1=Mon..7=Sun
 * @returns {string|null} the day key scheduled for that weekday, or null (rest day)
 */
function resolveScheduledDayKey(schedule, isoWeekday) {
  if (!schedule) return null
  for (const [key, weekdays] of Object.entries(schedule)) {
    if (Array.isArray(weekdays) && weekdays.includes(isoWeekday)) return key
  }
  return null
}

// ---------------------------------------------------------------------------
// Exercise equipment — the constraint check (owner: wrist pain from boxing ⇒
// no straight bar / no barbell anywhere in this program). One map, both the seed
// data below AND the "0 barbell" regression test read this SAME source.
// ---------------------------------------------------------------------------

/**
 * Only the exercises actually used by SEED_TRAINING_PROGRAM (below), keyed by their
 * exact exercises_library.name — live-verified 2026-09-09 (`GET /api/workouts/exercises`)
 * for the reused ones; the 5 new ones are what NEW_EXERCISES_TO_SEED creates.
 */
const EXERCISE_EQUIPMENT_MAP = {
  // Reused from the existing 27-doc exercises_library (verified live, none barbell)
  'Жим гантелей лежачи': 'dumbbell',
  'Тяга гантелі': 'dumbbell',
  'Жим ногами': 'machine',
  'Тяга верхнього блоку': 'cable',
  'Розгинання ніг': 'machine',
  'Згинання ніг': 'machine',
  'Підйом на носки': 'machine',
  'Планка': 'bodyweight',
  'Розведення в сторони': 'dumbbell',
  'Підтягування': 'bodyweight',
  'Віджимання на брусах': 'bodyweight',
  'Підйом ніг': 'bodyweight',
  // New — seeded via the existing POST /api/workouts/exercises (never a new endpoint)
  'Жим гантелей стоячи': 'dumbbell',
  'Пуловер': 'dumbbell',
  'Розведення на задню дельту': 'dumbbell',
  'Молоткові згинання на лаві Скотта': 'dumbbell',
  'Канат на трицепс': 'cable',
}

/** The 5 exercises exercises_library is missing (KB #2542's list minus "розводки",
 * which already exists as "Розведення в сторони"). Seeded via the LIVE
 * `POST /api/workouts/exercises` — routes/workouts.js already de-dupes by
 * case-insensitive name, so re-running this is safe (409 on repeat, not a crash). */
const NEW_EXERCISES_TO_SEED = [
  { name: 'Жим гантелей стоячи', muscle_group: 'shoulders', equipment: 'dumbbell' },
  { name: 'Пуловер', muscle_group: 'chest', equipment: 'dumbbell' },
  { name: 'Розведення на задню дельту', muscle_group: 'shoulders', equipment: 'dumbbell' },
  { name: 'Молоткові згинання на лаві Скотта', muscle_group: 'biceps', equipment: 'dumbbell' },
  { name: 'Канат на трицепс', muscle_group: 'triceps', equipment: 'cable' },
]

/** @param {{days: Array<{exercises: Array<{name: string}>}>}} programDoc @returns {number} */
function countBarbellExercises(programDoc) {
  let count = 0
  for (const day of programDoc.days || []) {
    for (const ex of day.exercises || []) {
      if (EXERCISE_EQUIPMENT_MAP[ex.name] === 'barbell') count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Seed program — owner-approved plan (Dmytro, chat 2026-09-09, distilled in
// session_2026-09-09_lisa_training_program_3x + queue #6058-#6061).
// 3x/week: Day A + Day B in the gym (dumbbell/cable/machine only — see equipment
// map above), Day home = турнік+бруси only. Neutral grip everywhere per the wrist
// constraint (documented per-exercise in `notes`, since exercises_library has no
// grip field and grip is a program-level prescription, not an exercise property).
// Rep ranges (owner): base 8-12, isolation 10-15, pull-ups = max effort.
// ---------------------------------------------------------------------------

const SEED_TRAINING_PROGRAM = {
  name: '3x/тиждень full-body (гантелі/тренажери, без прямого грифа)',
  periodization: {
    wave_weeks: 4,
    phases: ['База', 'Білд', 'Пік', 'Deload'],
    start_date: null, // filled in at seed time = today's Kyiv date
  },
  // ISO weekday: 1=Mon .. 7=Sun. Mon/Wed/Fri 3x split — adjustable via a future POST.
  schedule: { A: [1], B: [3], home: [5] },
  days: [
    {
      key: 'A',
      title: 'День A — груди/спина/ноги',
      location: 'gym',
      exercises: [
        { name: 'Жим гантелей лежачи', target_sets: 4, target_reps: '8-12', rest_sec: 90, superset_group: 'SS1', notes: 'нейтральний хват (долоні одна навпроти одної)' },
        { name: 'Тяга гантелі', target_sets: 4, target_reps: '8-12', rest_sec: 90, superset_group: 'SS1', notes: 'одна рука, нейтральний хват' },
        { name: 'Жим ногами', target_sets: 4, target_reps: '8-12', rest_sec: 90, superset_group: 'SS2', notes: null },
        { name: 'Тяга верхнього блоку', target_sets: 3, target_reps: '10-15', rest_sec: 60, superset_group: 'SS2', notes: 'нейтральна (паралельна) рукоятка' },
        { name: 'Розгинання ніг', target_sets: 3, target_reps: '10-15', rest_sec: 45, superset_group: 'SS3', notes: null },
        { name: 'Згинання ніг', target_sets: 3, target_reps: '10-15', rest_sec: 45, superset_group: 'SS3', notes: null },
        { name: 'Підйом на носки', target_sets: 3, target_reps: '10-15', rest_sec: 30, superset_group: null, notes: null },
        { name: 'Планка', target_sets: 3, target_reps: '45с', rest_sec: 30, superset_group: null, notes: 'час замість повторів' },
      ],
    },
    {
      key: 'B',
      title: 'День B — плечі/руки',
      location: 'gym',
      exercises: [
        { name: 'Жим гантелей стоячи', target_sets: 4, target_reps: '8-12', rest_sec: 90, superset_group: 'SS1', notes: 'нейтральний хват' },
        { name: 'Пуловер', target_sets: 4, target_reps: '8-12', rest_sec: 90, superset_group: 'SS1', notes: null },
        { name: 'Розведення в сторони', target_sets: 3, target_reps: '10-15', rest_sec: 60, superset_group: 'SS2', notes: null },
        { name: 'Розведення на задню дельту', target_sets: 3, target_reps: '10-15', rest_sec: 60, superset_group: 'SS2', notes: null },
        { name: 'Молоткові згинання на лаві Скотта', target_sets: 3, target_reps: '10-15', rest_sec: 60, superset_group: 'SS3', notes: 'молотковий (нейтральний) хват' },
        { name: 'Канат на трицепс', target_sets: 3, target_reps: '10-15', rest_sec: 60, superset_group: 'SS3', notes: 'канатна рукоятка — нейтральний хват' },
      ],
    },
    {
      key: 'home',
      title: 'Вдома — турнік/бруси',
      location: 'home',
      exercises: [
        { name: 'Підтягування', target_sets: 4, target_reps: 'макс', rest_sec: 120, superset_group: null, notes: 'нейтральний (паралельний) хват на турніку' },
        { name: 'Віджимання на брусах', target_sets: 4, target_reps: '8-12', rest_sec: 90, superset_group: null, notes: 'нейтральний хват на брусах' },
        { name: 'Підйом ніг', target_sets: 3, target_reps: '10-15', rest_sec: 45, superset_group: null, notes: 'у висі на турніку' },
        { name: 'Планка', target_sets: 3, target_reps: '45с', rest_sec: 30, superset_group: null, notes: null },
      ],
    },
  ],
}

module.exports = {
  formatDateKyiv,
  getKyivIsoWeekday,
  daysBetweenDateStrings,
  computeCurrentWeek,
  phaseForWeek,
  resolveScheduledDayKey,
  countBarbellExercises,
  EXERCISE_EQUIPMENT_MAP,
  NEW_EXERCISES_TO_SEED,
  SEED_TRAINING_PROGRAM,
}
