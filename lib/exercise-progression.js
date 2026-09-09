'use strict'

/**
 * Double-progression-by-weight engine — task #1291 (Ф2), body redesigned by Apex 09.09
 * (queue #6100/#6113, spec KB #2542). Pure logic, no DB access, so it is unit-testable
 * on synthetic fixtures — the owner-approved acceptance path for this task, since the
 * live workouts collection has 0 exercises with >=2 sessions carrying weight_kg
 * (measured 09.09 19:1x, `GET /api/workouts/prs/summary`).
 *
 * The OLD rule ("reps hit the TOP of the range on ALL working sets -> add weight") is
 * gone from this file on purpose — falsified by the owner's own bench-press log
 * (8/7/6 reps at an 8-12 range never reaches the top on any set). Do NOT resurrect it.
 *
 * Truth table (fixed priority order, first match wins) — see task #1291 body §3:
 *   0 no session at all                          -> insufficient_data / no_session
 *   1 target_reps is a TIME value ("45с")         -> not_applicable    / time_based
 *   2 target_reps is OPEN ("макс")                -> add_reps          / range_open
 *   3 not in program / target_reps unparseable    -> range_not_set     / not_in_program
 *   4 no set in the last session has weight_kg>0  -> add_reps|hold     / bodyweight[_top]
 *   5 weighted, but the exercise has no weight_unit -> unit_not_set    / unit_required
 *   6 working-set reps stat < range LOW           -> reduce_weight     / weight_too_high
 *   7 working-set reps stat >= range HIGH         -> add_weight        / range_top_reached
 *   8 otherwise                                   -> add_reps          / below_range_top
 */

const { hasPositiveWeight } = require('./workout-sets')

const KG_PER_LB = 0.45359237

// ---------------------------------------------------------------------------
// ⏸ TOP_OF_RANGE_RULE — NOT an owner decision yet (task #1291, queue #6112, asked
// 09.09 19:0x; no reply as of this implementation). Exactly ONE production read site
// (the `variant` default parameter of evaluateProgression() below) — do not add a
// second. Per the task's explicit instruction, this is shipped as a flagged TODO
// value, not a silently-guessed default: Phil's message to the owner recommended
// 'first' (the only variant that doesn't get stuck forever on the owner's own
// descending-reps bench-press pattern), but that recommendation was NOT confirmed.
// Whoever gets the owner's answer changes ONLY this literal.
// Valid values: 'all' | 'first' | 'mean' | 'best'.
const TOP_OF_RANGE_RULE = 'first' // TODO(#1291): unconfirmed by owner — see comment above

/**
 * @param {unknown} raw the program's `target_reps` field, e.g. "8-12", "макс", "45с"
 * @returns {{kind:'range',low:number,high:number}|{kind:'open'}|{kind:'time',seconds:number}|{kind:'missing'}|{kind:'unrecognized',raw:string}}
 */
function parseTargetReps(raw) {
  if (raw === undefined || raw === null) return { kind: 'missing' }
  const s = String(raw).trim()
  if (s === '') return { kind: 'missing' }

  const rangeMatch = s.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const low = Number(rangeMatch[1])
    const high = Number(rangeMatch[2])
    if (Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low) {
      return { kind: 'range', low, high }
    }
    return { kind: 'unrecognized', raw: s }
  }

  if (/^макс\.?$/iu.test(s)) return { kind: 'open' }

  const timeMatch = s.match(/^(\d+)\s*с\.?$/iu)
  if (timeMatch) return { kind: 'time', seconds: Number(timeMatch[1]) }

  // Explicit 4th-form rejection (task instruction): anything else is NOT guessed at —
  // it folds into the same "range not set" output as a missing/empty value.
  return { kind: 'unrecognized', raw: s }
}

/**
 * working_sets = the sets of the session that carry the session's MAX weight_kg.
 * One deterministic rule, no ramp-up/straight classifier (Apex, #1291 §2) — covers all
 * 4 of the owner's reference exercises without branching: warm-up sets on an ascending
 * ramp drop out because they are below the max; a trailing fatigue drop drops out for
 * the same reason and can never be misread as a regression.
 * @param {Array<{weight_kg?: number, reps?: number}>} sets
 */
function selectWorkingSets(sets) {
  const list = sets || []
  if (!hasPositiveWeight(list)) {
    return {
      working_sets: list,
      working_weight_kg: 0,
      is_bodyweight: true,
      set_scheme: list.length <= 1 ? 'single' : 'bodyweight',
    }
  }

  const weights = list.map(s => s.weight_kg || 0)
  const maxWeight = Math.max(...weights)
  const working_sets = list.filter(s => (s.weight_kg || 0) === maxWeight)

  let set_scheme
  if (list.length === 1) {
    set_scheme = 'single'
  } else if (weights.every(w => w === weights[0])) {
    set_scheme = 'straight'
  } else {
    const nonDecreasing = weights.every((w, i) => i === 0 || w >= weights[i - 1])
    set_scheme = nonDecreasing ? 'ramp_up' : 'straight_with_drop'
  }

  return { working_sets, working_weight_kg: maxWeight, is_bodyweight: false, set_scheme }
}

/** @param {number[]} reps @param {'all'|'first'|'mean'|'best'} variant */
function repsStatValue(reps, variant) {
  if (!reps.length) return 0
  switch (variant) {
    case 'first':
      return reps[0]
    case 'best':
      return Math.max(...reps)
    case 'mean':
      return reps.reduce((a, b) => a + b, 0) / reps.length
    case 'all':
    default:
      return null // 'all' has no single scalar — handled by meetsTop/belowBottom directly
  }
}

/** @param {number[]} reps @param {number} high @param {'all'|'first'|'mean'|'best'} variant */
function meetsTop(reps, high, variant) {
  if (!reps.length) return false
  if (variant === 'all') return reps.every(r => r >= high)
  return repsStatValue(reps, variant) >= high
}

/** @param {number[]} reps @param {number} low @param {'all'|'first'|'mean'|'best'} variant */
function belowBottom(reps, low, variant) {
  if (!reps.length) return false
  if (variant === 'all') return reps.every(r => r < low)
  return repsStatValue(reps, variant) < low
}

/**
 * Increment step is derived from THIS exercise's own history, never a constant
 * (owner approval 09.09 18:34+18:36): the minimal positive gap between distinct
 * working weights actually logged across sessions. <2 distinct weights -> unknown.
 * @param {number[]} historicalWorkingWeights
 */
function computeIncrementStepKg(historicalWorkingWeights) {
  const distinct = Array.from(new Set(historicalWorkingWeights.filter(w => w > 0))).sort((a, b) => a - b)
  if (distinct.length < 2) return { increment_step_kg: null, step_source: 'unknown' }

  let minDiff = Infinity
  for (let i = 1; i < distinct.length; i++) {
    const diff = Math.round((distinct[i] - distinct[i - 1]) * 100) / 100
    if (diff > 0 && diff < minDiff) minDiff = diff
  }
  if (!Number.isFinite(minDiff)) return { increment_step_kg: null, step_source: 'unknown' }
  return { increment_step_kg: minDiff, step_source: 'history' }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** @param {number} kg @param {'kg'|'lb'} unit */
function toDisplay(kg, unit) {
  if (unit === 'lb') return { value: round2(kg / KG_PER_LB), unit: 'lb' }
  return { value: round2(kg), unit: 'kg' }
}

function baseResult(fields) {
  return {
    exercise: fields.exerciseName,
    equipment: fields.equipment ?? null,
    weight_unit: fields.weightUnit ?? null,
    set_scheme: fields.set_scheme ?? null,
    working_sets: fields.working_sets ?? [],
    working_weight_kg: fields.working_weight_kg ?? 0,
    reps_by_working_set: fields.reps_by_working_set ?? [],
    target_reps_range: fields.target_reps_range ?? null,
    next_action: fields.next_action,
    reason_code: fields.reason_code,
    suggested_weight_kg: fields.suggested_weight_kg ?? null,
    suggested_weight_display: fields.suggested_weight_display ?? null,
    increment_step_kg: fields.increment_step_kg ?? null,
    step_source: fields.step_source ?? null,
  }
}

/**
 * @param {object} params
 * @param {string} params.exerciseName
 * @param {string|null} [params.equipment] exercises_library hint, NOT ground truth
 * @param {'kg'|'lb'|null} [params.weightUnit] exercises_library.weight_unit, once it exists
 * @param {Array<{date: string, sets: Array<{weight_kg?: number, reps?: number}>}>} params.sessions
 *   ascending by date — reads ONLY `sets[]` (§7: never fall back to an exercise-level weight field)
 * @param {unknown} params.targetRepsRaw the program's target_reps for this exercise, or
 *   undefined when the exercise isn't in the active program at all
 * @param {'all'|'first'|'mean'|'best'} [params.variant] TOP_OF_RANGE_RULE override — tests only
 */
function evaluateProgression({ exerciseName, equipment = null, weightUnit = null, sessions = [], targetRepsRaw, variant = TOP_OF_RANGE_RULE }) {
  const nonEmpty = sessions.filter(s => (s.sets || []).length > 0)

  if (nonEmpty.length === 0) {
    return baseResult({ exerciseName, equipment, weightUnit, next_action: 'insufficient_data', reason_code: 'no_session' })
  }

  const parsed = parseTargetReps(targetRepsRaw)

  if (parsed.kind === 'time') {
    return baseResult({ exerciseName, equipment, weightUnit, next_action: 'not_applicable', reason_code: 'time_based' })
  }
  if (parsed.kind === 'open') {
    return baseResult({ exerciseName, equipment, weightUnit, next_action: 'add_reps', reason_code: 'range_open' })
  }
  if (parsed.kind === 'missing' || parsed.kind === 'unrecognized') {
    return baseResult({ exerciseName, equipment, weightUnit, next_action: 'range_not_set', reason_code: 'not_in_program' })
  }

  // parsed.kind === 'range' from here on.
  const last = nonEmpty[nonEmpty.length - 1]
  const { working_sets, working_weight_kg, is_bodyweight, set_scheme } = selectWorkingSets(last.sets)
  const reps_by_working_set = working_sets.map(s => s.reps || 0)
  const target_reps_range = { low: parsed.low, high: parsed.high }

  if (is_bodyweight) {
    const top = meetsTop(reps_by_working_set, parsed.high, variant)
    return baseResult({
      exerciseName, equipment, weightUnit, set_scheme, working_sets, working_weight_kg: 0,
      reps_by_working_set, target_reps_range,
      next_action: top ? 'hold' : 'add_reps',
      reason_code: top ? 'bodyweight_top' : 'bodyweight',
    })
  }

  if (!weightUnit) {
    return baseResult({
      exerciseName, equipment, weightUnit, set_scheme, working_sets, working_weight_kg,
      reps_by_working_set, target_reps_range,
      next_action: 'unit_not_set', reason_code: 'unit_required',
    })
  }

  const below = belowBottom(reps_by_working_set, parsed.low, variant)
  const top = meetsTop(reps_by_working_set, parsed.high, variant)

  let next_action, reason_code
  if (below) {
    next_action = 'reduce_weight'
    reason_code = 'weight_too_high'
  } else if (top) {
    next_action = 'add_weight'
    reason_code = 'range_top_reached'
  } else {
    next_action = 'add_reps'
    reason_code = 'below_range_top'
  }

  const historicalWorkingWeights = nonEmpty.map(s => selectWorkingSets(s.sets).working_weight_kg)
  const { increment_step_kg, step_source } = computeIncrementStepKg(historicalWorkingWeights)

  let suggested_weight_kg = null
  let suggested_weight_display = null
  if (next_action === 'add_weight' && increment_step_kg != null) {
    suggested_weight_kg = round2(working_weight_kg + increment_step_kg)
    suggested_weight_display = toDisplay(suggested_weight_kg, weightUnit)
  }

  return baseResult({
    exerciseName, equipment, weightUnit, set_scheme, working_sets, working_weight_kg,
    reps_by_working_set, target_reps_range, next_action, reason_code,
    suggested_weight_kg, suggested_weight_display, increment_step_kg, step_source,
  })
}

module.exports = {
  TOP_OF_RANGE_RULE,
  parseTargetReps,
  selectWorkingSets,
  meetsTop,
  belowBottom,
  computeIncrementStepKg,
  evaluateProgression,
}
