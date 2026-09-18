'use strict'

const { formatDateKyiv, getKyivIsoWeekday } = require('./training-program')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDateString(dateStr) {
  if (!DATE_RE.test(dateStr)) return null
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

function addDays(dateStr, days) {
  const date = parseDateString(dateStr)
  if (!date) throw new Error(`Invalid date: ${dateStr}`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function monthStart(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0, 1, 12, 0, 0)).toISOString().slice(0, 10)
}

function monthEnd(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0, 12, 0, 0)).toISOString().slice(0, 10)
}

function periodBounds(period, dateStr = formatDateKyiv(new Date())) {
  if (period !== 'week' && period !== 'month') {
    return { error: 'period must be week or month' }
  }
  const date = parseDateString(dateStr)
  if (!date) return { error: 'date must be YYYY-MM-DD' }

  if (period === 'week') {
    const isoWeekday = getKyivIsoWeekday(date)
    const from = addDays(dateStr, 1 - isoWeekday)
    const to = addDays(from, 6)
    return { period, from, to, prevFrom: addDays(from, -7), prevTo: addDays(to, -7) }
  }

  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const from = monthStart(year, month)
  const to = monthEnd(year, month)
  return {
    period,
    from,
    to,
    prevFrom: monthStart(year, month - 1),
    prevTo: monthEnd(year, month - 1),
  }
}

function exerciseKey(name) {
  return String(name || '').toLowerCase()
}

function normalizeLibrary(libraryByName) {
  if (libraryByName instanceof Map) return libraryByName
  const map = new Map()
  for (const entry of libraryByName || []) {
    if (entry && entry.name) map.set(exerciseKey(entry.name), entry)
  }
  return map
}

function summarizeVolumeByMuscle(workouts, libraryByName, muscleOrder) {
  const library = normalizeLibrary(libraryByName)
  const order = new Map(muscleOrder.map((group, index) => [group, index]))
  const byGroup = new Map()
  let workoutsCount = 0

  for (const workout of workouts || []) {
    const exercises = Array.isArray(workout.exercises) ? workout.exercises : []
    if (exercises.length === 0) continue
    workoutsCount += 1

    for (const exercise of exercises) {
      const sets = Array.isArray(exercise.sets) ? exercise.sets : []
      const volume = sets.reduce((sum, set) => sum + (Number(set.weight_kg) || 0) * (Number(set.reps) || 0), 0)
      if (volume <= 0) continue

      const libraryEntry = library.get(exerciseKey(exercise.name))
      const muscleGroup = order.has(libraryEntry?.muscle_group) ? libraryEntry.muscle_group : 'other'
      if (!byGroup.has(muscleGroup)) {
        byGroup.set(muscleGroup, {
          muscle_group: muscleGroup,
          volumeRaw: 0,
          sets: 0,
          exercises: new Set(),
        })
      }
      const group = byGroup.get(muscleGroup)
      group.volumeRaw += volume
      group.sets += sets.length
      if (exercise.name) group.exercises.add(exercise.name)
    }
  }

  const groups = [...byGroup.values()]
    .map(group => ({
      muscle_group: group.muscle_group,
      volume_kg: Math.round(group.volumeRaw),
      sets: group.sets,
      exercises_count: group.exercises.size,
    }))
    .filter(group => group.volume_kg > 0)
    .sort((a, b) => (order.get(a.muscle_group) ?? 999) - (order.get(b.muscle_group) ?? 999))

  return {
    total_kg: groups.reduce((sum, group) => sum + group.volume_kg, 0),
    workouts_count: workoutsCount,
    groups,
  }
}

function exerciseNamesFromWorkouts(workouts) {
  const names = new Set()
  for (const workout of workouts || []) {
    for (const exercise of workout.exercises || []) {
      if (exercise.name) names.add(exercise.name)
    }
  }
  return [...names]
}

module.exports = {
  periodBounds,
  summarizeVolumeByMuscle,
  exerciseNamesFromWorkouts,
  exerciseKey,
}
