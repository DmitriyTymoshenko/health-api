'use strict'

const { Router } = require('express')
const { getEquipmentLabelsByOurEnum } = require('../lib/exercise-dictionaries')

// #1334 (Ф3/#1331, ЕТАП 1 — health-api only, no UI yet). Server-side paginated /
// searchable / filterable read endpoint for the 876-exercise free-exercise-db import
// written by #1332 (`exercises_catalog`, key `source_id`, see that migration's
// header for the full document shape).
//
// Lives in its OWN file, mounted on the SAME `/api/workouts` prefix as
// routes/workouts.js (Express allows multiple routers per prefix — unmatched paths
// fall through to the next mounted router) — NOT inside workouts.js, which is #1332's
// hot file and owns the untouched 32-exercise contract: `GET /api/workouts/exercises`
// (no pagination, `find({})`) feeds BOTH the reference library AND `ExercisePicker` in
// the workout-log form (`health-dashboard/src/pages/Workouts.jsx:168`) plus
// `getMuscleGroup()` (`:856`) — landing 876 rows into that response would regress the
// log-a-workout flow, not just grow the reference library (#1331 comment #7551 §1).
//
// The list view deliberately OMITS `instructions_en`/`instructions_ua` — 571,706 EN
// characters alone across 876 docs (#1331 comment #7549/#7552 measurement) — those are
// only needed on the detail view, never for a paginated list/search/filter UI.

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 30

// Sentinel query value for the explicit "не вказано" (source doesn't know) filter
// state — see the `equipment`/`muscle` filter block below.
const NULL_FILTER_VALUE = '__null__'

// Same escaping need as routes/foods.js's escapeRegex (#1225 lesson): raw regex
// metacharacters in a query (parens/slashes/asterisks are real in this catalog —
// "3/4 Sit-Up", "90/90 Hamstring") make an unescaped `$regex` throw and 500 the whole
// request. Not extracted into a shared lib for a 2-line helper (dev-protocol: minimal
// changes, no unrequested refactor of routes/foods.js).
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parsePagination(query) {
  let limit = parseInt(query.limit, 10)
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT
  limit = Math.min(limit, MAX_LIMIT)

  let offset = parseInt(query.offset, 10)
  if (!Number.isFinite(offset) || offset < 0) offset = 0

  return { limit, offset }
}

// Excluded from the LIST projection — present only on the detail (:source_id) route.
const LIST_EXCLUDED_FIELDS = { instructions_en: 0, instructions_ua: 0 }

module.exports = function (getDB) {
  const router = Router()

  // GET /api/workouts/exercises/catalog?limit=&offset=&q=&equipment=&muscle=
  //
  // `equipment`/`muscle` filter on the ALREADY-MAPPED #1332 fields (`equipment`,
  // `muscle_group` — our internal enum, Dictionary B), never on the raw
  // `equipment_src`/`primary_muscles_src` source values — those two dictionaries are
  // the whole point of #1331/#1332 (#7551 §2): filtering on raw source values would
  // reopen bug #1310 one layer up.
  router.get('/exercises/catalog', async (req, res) => {
    try {
      const db = getDB()
      const col = db.collection('exercises_catalog')
      const { limit, offset } = parsePagination(req.query)

      const filter = {}
      const q = String(req.query.q || '').trim()
      if (q) {
        const safeQ = escapeRegex(q)
        filter.$or = [
          { name_ua: { $regex: safeQ, $options: 'i' } },
          { name_en: { $regex: safeQ, $options: 'i' } },
        ]
      }
      // `__null__` is the explicit "не вказано" filter state (#1334 acceptance #3) —
      // a real, selectable value distinct from "no filter applied" (omitting the
      // param). Never silently fold an unmapped/unknown equipment into a working
      // filter value — that's the #1310-class bug this whole umbrella exists to fix.
      if (req.query.equipment) {
        filter.equipment = req.query.equipment === NULL_FILTER_VALUE ? null : String(req.query.equipment)
      }
      if (req.query.muscle) {
        filter.muscle_group = req.query.muscle === NULL_FILTER_VALUE ? null : String(req.query.muscle)
      }

      const [items, total] = await Promise.all([
        col
          .find(filter, { projection: LIST_EXCLUDED_FIELDS })
          .sort({ name_en: 1 })
          .skip(offset)
          .limit(limit)
          .toArray(),
        col.countDocuments(filter),
      ])

      res.json({ items, total, limit, offset })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/exercises/catalog/labels — Dictionary A∘B composed equipment
  // labels, keyed by OUR enum (#1334 ЕТАП 1б, comment #7581 §2/#7585). MUST be
  // registered BEFORE the `/:source_id` route below — Express matches routes in
  // registration order, and `/:source_id` would otherwise swallow this path (treating
  // "labels" as a source_id and 404ing, since no free-exercise-db exercise is named
  // "labels") before it ever reaches this handler.
  router.get('/exercises/catalog/labels', (req, res) => {
    try {
      res.json({ equipment: getEquipmentLabelsByOurEnum() })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/exercises/catalog/:source_id — full document, incl. instructions.
  router.get('/exercises/catalog/:source_id', async (req, res) => {
    try {
      const db = getDB()
      const col = db.collection('exercises_catalog')
      const doc = await col.findOne({ source_id: req.params.source_id })
      if (!doc) return res.status(404).json({ error: 'not found' })
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
