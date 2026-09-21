'use strict'

/**
 * Bodyweight-set weight autofill — #1474 (owner addendum to #1473, apex triage 21.09,
 * comment #8481 on #1474). A session logged with `reps` only (planks, push-ups, pull-ups,
 * mountain climbers — no explicit `weight_kg`/`weight_input`) left every such set at
 * `weight_kg: null` forever, so it was invisible to `GET /volume-by-muscle` (#1410) and
 * `/exercise-trends` (#1417): `lib/volume-by-muscle.js` sums `weight_kg * reps` and skips
 * a set whose volume is `<= 0`.
 *
 * This backfills `weight_kg` from the owner's own bodyweight (`weight_log`, latest entry
 * on/before the session date) — WITHOUT poisoning the #1130/#1291 bodyweight-session
 * predicate (`lib/workout-sets.js::hasPositiveWeight`), which must keep classifying these
 * sessions as bodyweight for progression/ranking purposes (`pickBestSet` ranks by reps,
 * not 1RM; `/progression` keeps its `bodyweight`/`bodyweight_top` reason codes). The
 * `weight_source: 'bodyweight'` tag on the set is the ONE signal `hasPositiveWeight()`
 * reads to tell "filled from bodyweight" apart from a real barbell/dumbbell entry — see
 * that file for the predicate change.
 *
 * Autofill applies ONLY when a set has NEITHER `weight_kg` NOR `weight_input` set. Any
 * explicit value — including an unresolved `weight_input` still awaiting a unit answer
 * (#1314/#1318, `weight_input != null && weight_kg == null`) — is left untouched, never
 * overwritten. If no `weight_log` entry exists yet, `weight_kg` stays `null` (never a
 * hardcoded number) but the set is still tagged `weight_source: 'bodyweight'` so the
 * predicate/UI can still tell it apart from an explicit-weight set once a measurement
 * eventually appears.
 */

/**
 * @param {Array<{name:string, sets:Array<object>}>} exercises
 * @param {number|null} bodyweightKg latest `weight_log.weight_kg` on/before the session
 *   date, or `null` if no measurement exists yet
 * @returns {{exercises: Array<object>, filledCount: number}}
 */
function fillBodyweightSets(exercises, bodyweightKg) {
  let filledCount = 0
  const updated = (exercises || []).map(ex => {
    let exChanged = false
    const sets = (ex.sets || []).map(s => {
      if (s.weight_kg != null || s.weight_input != null) return s
      filledCount += 1
      exChanged = true
      return { ...s, weight_kg: bodyweightKg != null ? bodyweightKg : null, weight_source: 'bodyweight' }
    })
    return exChanged ? { ...ex, sets } : ex
  })
  return { exercises: updated, filledCount }
}

/**
 * Resolve the owner's bodyweight on/before a given session date from `weight_log`.
 * @param {import('mongodb').Collection} weightCol
 * @param {string} sessionDate YYYY-MM-DD
 * @returns {Promise<number|null>}
 */
async function resolveBodyweightForDate(weightCol, sessionDate) {
  if (!sessionDate) return null
  const entries = await weightCol
    .find({ date: { $lte: sessionDate } })
    .sort({ date: -1 })
    .limit(1)
    .toArray()
  return entries.length > 0 && entries[0].weight_kg != null ? entries[0].weight_kg : null
}

module.exports = { fillBodyweightSets, resolveBodyweightForDate }
