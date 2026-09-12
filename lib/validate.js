'use strict'

// #1297: canonical, plain-JS validation middleware.
//
// WHY THIS FILE EXISTS (not `src/middleware/validate.ts`, which already had this
// logic and its own passing tests): `health-api.service` runs `node server.js`
// directly — there is NO build step (`dist/` is gitignored, last built by hand
// 09.09, nothing does `require('../dist/...')`). Routes are plain CommonJS JS.
// Wiring `src/middleware/validate.ts` into a route via
// `require('../dist/middleware/validate')` would only work until the next
// deploy that skips a manual `tsc` — a silent, deploy-time landmine. This file
// is the single runtime-loadable source; `src/middleware/validate.ts` (kept for
// its existing typed unit tests) now re-exports from here instead of
// duplicating the logic (see that file's header comment).
//
// Every function here follows the SAME safety rule found in this codebase's
// other insert routes (#1310/#1332 lesson): never let a missing field silently
// become `undefined` in Mongo — reject with 400 before `insertOne`/`findOneAndUpdate`
// ever runs, so `nutrition_log`/`weight_log`/etc. cannot grow more of the
// no-`food_name` documents #1297's audit already found (4 live rows).

/**
 * Validate that ALL of `fields` are present (not undefined/null) in req.body.
 * 400 + the exact missing field names if any are absent.
 */
function requireFields(...fields) {
  return (req, res, next) => {
    const missing = fields.filter((f) => req.body[f] === undefined || req.body[f] === null)
    if (missing.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` })
      return
    }
    next()
  }
}

/**
 * Validate that AT LEAST ONE of `fields` is present (not undefined/null) in
 * req.body. Used where a record is valid with any one of several optional
 * measurement/metric columns (e.g. body_measurements: weight_kg OR waist_cm OR
 * ...) but an entirely empty body is still not a real record.
 */
function requireAnyField(...fields) {
  return (req, res, next) => {
    const present = fields.some((f) => req.body[f] !== undefined && req.body[f] !== null)
    if (!present) {
      res.status(400).json({ error: `Provide at least one of: ${fields.join(', ')}` })
      return
    }
    next()
  }
}

/**
 * Validate date format YYYY-MM-DD when a date is present (body or query).
 * Does NOT require a date — routes that default a missing date to "today"
 * (weight/nutrition/notes/body_measurements/metrics) keep that behaviour;
 * this only rejects a MALFORMED one.
 */
function validateDate(req, res, next) {
  const date = (req.body && req.body.date) || (req.query && req.query.date)
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
    return
  }
  next()
}

/**
 * Normalize nutrition fields: accepts both protein/fat/carbs and
 * protein_g/fat_g/carbs_g, name -> food_name, defaults date to today.
 * (routes/nutrition.js already does an equivalent inline normalization for
 * protein/fat/carbs/sat_fat/name — this is the shared, testable version used
 * by the middleware chain; kept field-for-field compatible.)
 */
function normalizeNutrition(req, res, next) {
  if (req.body) {
    const b = req.body
    if (b.protein !== undefined && b.protein_g === undefined) b.protein_g = Number(b.protein)
    if (b.fat !== undefined && b.fat_g === undefined) b.fat_g = Number(b.fat)
    if (b.carbs !== undefined && b.carbs_g === undefined) b.carbs_g = Number(b.carbs)
    if (b.sat_fat !== undefined && b.sat_fat_g === undefined) b.sat_fat_g = Number(b.sat_fat)
    if (b.name && !b.food_name) b.food_name = String(b.name)
    if (!b.date) b.date = new Date().toISOString().split('T')[0]
  }
  next()
}

/**
 * Ensure supplement_id is stored as a number, not string.
 */
function normalizeSupplementId(req, res, next) {
  if (req.body && req.body.supplement_id !== undefined) {
    req.body.supplement_id = Number(req.body.supplement_id)
  }
  if (req.query && req.query.supplement_id !== undefined) {
    req.query.supplement_id = String(Number(req.query.supplement_id))
  }
  next()
}

module.exports = {
  requireFields,
  requireAnyField,
  validateDate,
  normalizeNutrition,
  normalizeSupplementId,
}
