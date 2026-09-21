'use strict'

/**
 * Pure helpers for PATCH /api/workouts/exercises/:name/name (#1472) — rename/merge an
 * exercises_library exercise and backfill every name-keyed place in `workouts` and
 * `training_programs`. Split out of the route so the merge/consolidation logic is
 * unit-testable without a DB, same pattern as lib/workout-log-write.js.
 *
 * Model (Apex triage, #1472 comment #8459): there is NO separate sessions/sets
 * collection — a "session" is one `workouts` doc, "sets" live at
 * `workouts.exercises[].sets[]` (embedded). Every reader (`exercise-history`,
 * `progress`, `progression`, `exercise-trends`) takes the FIRST `exercises[]` entry
 * matching a name — so a session that ends up with TWO entries sharing the same name
 * after a rename would silently hide the second entry's sets from every reader. This
 * file's `consolidateSessionExercises` is what prevents that: when a session already
 * has both the source and target name, it merges them into ONE entry instead of
 * leaving two.
 */

/** Fields on an exercises_library doc that may be backfilled from `source` onto
 * `target` on merge, but ONLY where `target` doesn't already have a value (owner
 * spec, #1472: explicit list — muscle_group is deliberately NOT in it, a merge never
 * guesses muscle_group for the surviving doc). */
const NULL_FILLABLE_LIBRARY_FIELDS = [
  'equipment',
  'description_ua',
  'video_url',
  'image_url',
  'cues',
  'weight_unit',
]

/**
 * @param {Record<string, any>} targetDoc the exercises_library doc that survives
 * @param {Record<string, any>} sourceDoc the exercises_library doc being merged away
 * @returns {Record<string, any>} fields to $set on targetDoc (never includes name/_id)
 */
function mergeLibraryFields(targetDoc, sourceDoc) {
  const fill = {}
  for (const field of NULL_FILLABLE_LIBRARY_FIELDS) {
    if ((targetDoc[field] === undefined || targetDoc[field] === null) &&
        sourceDoc[field] !== undefined && sourceDoc[field] !== null) {
      fill[field] = sourceDoc[field]
    }
  }
  return fill
}

/**
 * Renames `source` to `target` within one session's exercises[] array. If the session
 * already has a `target`-named entry too, consolidates both into ONE entry at the
 * target entry's position (sets = target's sets followed by source's sets, order
 * preserved within each side) and drops the source entry — never leaves two entries
 * with the same name (see file header for why that would be silently wrong).
 * @param {Array<{name:string, sets?: Array<object>}>} exercises
 * @param {string} source
 * @param {string} target
 * @returns {{exercises: Array<object>, changed: boolean, consolidated: boolean}}
 *   changed=false means this session had no `source` entry — caller should skip the write
 */
function consolidateSessionExercises(exercises, source, target) {
  const list = exercises || []
  const sourceIdx = list.findIndex(e => e.name === source)
  if (sourceIdx === -1) {
    return { exercises: list, changed: false, consolidated: false }
  }

  const targetIdx = list.findIndex(e => e.name === target)
  if (targetIdx === -1) {
    // Simple rename — no pre-existing target entry in this session.
    const renamed = list.map(e => (e.name === source ? { ...e, name: target } : e))
    return { exercises: renamed, changed: true, consolidated: false }
  }

  // Both present — consolidate into the target entry's slot, drop the source entry.
  const mergedSets = [...(list[targetIdx].sets || []), ...(list[sourceIdx].sets || [])]
  const mergedEntry = { ...list[targetIdx], sets: mergedSets }
  const consolidated = list
    .filter((_, i) => i !== sourceIdx)
    .map(e => (e.name === target ? mergedEntry : e))
  return { exercises: consolidated, changed: true, consolidated: true }
}

/**
 * Replaces `source` with `target` in a name list (e.g. `needs_muscle_group_clarification`,
 * `needs_unit_clarification`), then dedupes — a session flagging BOTH names for
 * clarification must not end up with `target` listed twice after the rename collapses
 * them. Order-preserving. Returns the input unchanged if `source` isn't present (and
 * not an array, returns as-is) so callers can skip a no-op $set.
 * @param {string[]|undefined} list
 * @param {string} source
 * @param {string} target
 * @returns {string[]|undefined}
 */
function replaceNameDedup(list, source, target) {
  if (!Array.isArray(list)) return list
  if (!list.includes(source)) return list
  const replaced = list.map(n => (n === source ? target : n))
  return [...new Set(replaced)]
}

/**
 * Renames `source` to `target` in every `day.exercises[].name` of one training_programs
 * doc's `days[]`. Generic on purpose (#1472 spec) even though live data has 0 matches
 * today (Apex triage) — a plan referencing an exercise by name must follow a rename the
 * same way a workout session does.
 * @param {Array<{exercises?: Array<{name:string}>}>} days
 * @param {string} source
 * @param {string} target
 * @returns {{days: Array<object>, changed: boolean}}
 */
function renameInProgramDays(days, source, target) {
  let anyChanged = false
  const updated = (days || []).map(day => {
    let dayChanged = false
    const exercises = (day.exercises || []).map(entry => {
      if (entry.name !== source) return entry
      dayChanged = true
      return { ...entry, name: target }
    })
    if (!dayChanged) return day
    anyChanged = true
    return { ...day, exercises }
  })
  return { days: updated, changed: anyChanged }
}

module.exports = {
  NULL_FILLABLE_LIBRARY_FIELDS,
  mergeLibraryFields,
  consolidateSessionExercises,
  replaceNameDedup,
  renameInProgramDays,
}
