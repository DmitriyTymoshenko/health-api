'use strict'

/** #1692 п.8: a WHOOP workout counts as a "real training" only if >=40 min AND strain >=6.
 *  27/35 tennis rows were shorter/lighter and inflated "N тренувань". Unknown values don't pass. */
const MIN_REAL_WORKOUT_MIN = 40
const MIN_REAL_WORKOUT_STRAIN = 6

function isRealWhoopWorkout(w) {
  if (!w) return false
  return Number(w.duration_min) >= MIN_REAL_WORKOUT_MIN && Number(w.strain) >= MIN_REAL_WORKOUT_STRAIN
}

module.exports = { MIN_REAL_WORKOUT_MIN, MIN_REAL_WORKOUT_STRAIN, isRealWhoopWorkout }
