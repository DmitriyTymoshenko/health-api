'use strict'

/**
 * Pure write-side helpers for POST /api/workouts/log-text (#1314). Split out of the
 * route so the merge/conversion logic is unit-testable without a DB, same pattern as
 * lib/exercise-progression.js.
 */

const { KG_PER_LB } = require('./exercise-progression')

/**
 * Weight-unit model — #1291 §5 (owner decision, "затверджую", 09.09): weight_kg is the
 * ONE canonical field everything downstream calculates on, converted ONCE at write time.
 * An unknown unit is an explicit state ("не задано"), never a silent kg default — so
 * this returns null rather than assuming kg when weightUnit is missing/unrecognized.
 * @param {number} weightInput raw number as the owner said it (what's on the stack/plate)
 * @param {'kg'|'lb'|null|undefined} weightUnit
 * @returns {number|null}
 */
function toWeightKg(weightInput, weightUnit) {
  if (!Number.isFinite(weightInput)) return null
  if (weightUnit === 'kg') return weightInput
  if (weightUnit === 'lb') return Math.round(weightInput * KG_PER_LB * 100) / 100
  return null // unit_required — do NOT default to kg (#1291 §5 point 4)
}

/**
 * @param {{name:string, sets: Array<{reps:number, weight_input:number}>}} parsedEntry
 * @param {'kg'|'lb'|null} weightUnit resolved from exercises_library for this exercise
 * @returns {{name:string, sets: Array<{reps:number, weight_input:number, weight_unit:('kg'|'lb'|null), weight_kg:(number|null)}>}}
 */
function buildExerciseFromParsed(parsedEntry, weightUnit) {
  const unit = weightUnit === 'kg' || weightUnit === 'lb' ? weightUnit : null
  return {
    name: parsedEntry.name,
    sets: parsedEntry.sets.map(s => ({
      reps: s.reps,
      weight_input: s.weight_input,
      weight_unit: unit,
      weight_kg: toWeightKg(s.weight_input, unit),
    })),
  }
}

/**
 * Idempotent merge — #1314 acceptance: "ідемпотентність за датою+вправою". Replaces an
 * exercise's sets in-place if the name already exists in the session doc, otherwise
 * appends it. Re-POSTing the exact same text any number of times converges to the same
 * exercises array (same length, same set values) instead of growing it.
 * @param {Array<object>} existingExercises
 * @param {Array<object>} newExercises
 * @returns {Array<object>}
 */
function mergeExercisesIntoDoc(existingExercises, newExercises) {
  const merged = [...(existingExercises || [])]
  for (const ex of newExercises) {
    const idx = merged.findIndex(e => e.name === ex.name)
    if (idx === -1) {
      merged.push(ex)
    } else {
      merged[idx] = ex
    }
  }
  return merged
}

module.exports = { toWeightKg, buildExerciseFromParsed, mergeExercisesIntoDoc }
