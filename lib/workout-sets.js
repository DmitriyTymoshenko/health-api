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

module.exports = { hasPositiveWeight }
