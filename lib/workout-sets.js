'use strict'

/**
 * Shared "is this session bodyweight?" predicate.
 *
 * Canonicalized by #1130 inside routes/workouts.js::pickBestSet() ("a session is
 * bodyweight when NONE of its logged sets carry a positive `weight_kg`"). Task #1291
 * (double-progression engine) needs the exact same predicate and was explicitly told
 * NOT to reintroduce it via `equipment === 'bodyweight'` (equipment is only a default
 * HINT, not ground truth — 2/2 exercises in the owner's own reference example have the
 * wrong `equipment` value in exercises_library). Extracted here so both call sites
 * (pickBestSet and lib/exercise-progression.js) read ONE definition instead of two
 * copies that could drift.
 *
 * @param {Array<{weight_kg?: number}>} sets
 * @returns {boolean} true if at least one set has weight_kg > 0
 */
function hasPositiveWeight(sets) {
  return (sets || []).some(s => (s.weight_kg || 0) > 0)
}

/**
 * Estimated 1RM (Epley-style), same formula used by #1130 pickBestSet() and the
 * /prs endpoints. weight=0 or reps=0 -> 0 (never NaN/Infinity).
 * @param {number} weight
 * @param {number} reps
 */
function calc1RM(weight, reps) {
  if (!weight || !reps) return 0
  return Math.round(weight * (1 + reps / 30) * 10) / 10
}

// #1130: pick the "best" set of a session for ranking/history purposes.
// Bodyweight exercises (pull-ups, dips, planks…) log sets with no `weight_kg`, so
// calc1RM() always returns 0 for every set and the old orm-based reduce could never
// pick a winner — max_weight/best_reps/est_1rm silently stayed 0 forever.
// Extracted from routes/workouts.js (#1417) so lib/exercise-trends.js can reuse the
// EXACT SAME ranking function as /progress and /exercise-history — one definition,
// not a second copy that could drift (A1 numbers must match across endpoints).
/** @param {Array<{weight_kg?: number, reps?: number}>} sets */
function pickBestSet(sets) {
  const hasWeight = hasPositiveWeight(sets)
  if (hasWeight) {
    // Weighted exercise — rank by estimated 1RM.
    return sets.reduce((best, s) => {
      const orm = calc1RM(s.weight_kg, s.reps)
      return orm > best.orm ? { orm, weight: s.weight_kg || 0, reps: s.reps || 0 } : best
    }, { orm: 0, weight: 0, reps: 0 })
  }
  // Bodyweight exercise — rank by reps instead of a 1RM that can never be nonzero.
  return sets.reduce((best, s) => {
    const reps = s.reps || 0
    return reps > best.reps ? { orm: 0, weight: 0, reps } : best
  }, { orm: 0, weight: 0, reps: 0 })
}

module.exports = { hasPositiveWeight, calc1RM, pickBestSet }
