'use strict'

/**
 * Shared write-path into `exercises_library` — #1473. Before this, `POST
 * /api/workouts/log-text` was the ONLY route that auto-created/matched a library entry
 * per logged exercise name (routes/workouts.js, the per-entry loop this file replaces).
 * `POST /` and `PUT /:id` wrote straight into `workouts` and never touched the library,
 * so any exercise logged only through those two paths — e.g. a bodyweight session
 * (source=lisa/manual/anything) whose sets carry `reps` but no `weight_kg` — was
 * invisible to `PATCH /exercises/:name/muscle-group` (404 "Exercise not found").
 *
 * This factors the EXACT case-insensitive match+auto-create logic out of log-text so all
 * three write paths share ONE implementation. weight_unit/muscle_group/equipment are
 * NEVER guessed on auto-create (#1318/#1408) — a set with no weight is a perfectly valid
 * reason to still register the exercise; the library doc just starts with everything
 * null, same as any other newly-seen exercise name.
 *
 * @param {import('mongodb').Collection} libCol the `exercises_library` collection
 * @param {string[]} names exercise names to ensure exist. Duplicates are allowed and
 *   each is resolved independently (same as the original per-entry loop) — this keeps
 *   behavior/DB-call-count identical for log-text's existing tests.
 * @returns {Promise<Map<string, object>>} name -> its exercises_library doc (existing
 *   case-insensitive match, or a freshly auto-created doc)
 */
async function ensureExercisesInLibrary(libCol, names) {
  const libByName = new Map()
  for (const name of names || []) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let libDoc = await libCol.findOne({ name: { $regex: new RegExp(`^${escaped}$`, 'i') } })
    if (!libDoc) {
      const created = { name, muscle_group: null, equipment: null, weight_unit: null, created_at: new Date() }
      const insertResult = await libCol.insertOne(created)
      libDoc = { ...created, _id: insertResult.insertedId }
    }
    libByName.set(name, libDoc)
  }
  return libByName
}

module.exports = { ensureExercisesInLibrary }
