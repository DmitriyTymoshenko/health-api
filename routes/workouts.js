const { Router } = require('express')
const { calc1RM, pickBestSet } = require('../lib/workout-sets')
const { evaluateProgression } = require('../lib/exercise-progression')
const { buildExerciseTrends } = require('../lib/exercise-trends')
const { formatDateKyiv } = require('../lib/training-program')
const { parseWorkoutLogText } = require('../lib/workout-log-parser')
const {
  buildExerciseFromParsed,
  mergeExercisesIntoDoc,
  exercisesNeedingUnit,
  exercisesNeedingMuscleGroup,
  backfillWeightUnitInSession,
} = require('../lib/workout-log-write')
const { ensureExercisesInLibrary } = require('../lib/exercise-library-register')
const { fillBodyweightSets, resolveBodyweightForDate } = require('../lib/bodyweight-fill')
const { MUSCLE_GROUPS } = require('../lib/exercise-dictionaries')
const {
  mergeLibraryFields,
  consolidateSessionExercises,
  replaceNameDedup,
  renameInProgramDays,
} = require('../lib/exercise-rename')
const {
  periodBounds,
  summarizeVolumeByMuscle,
  exerciseNamesFromWorkouts,
} = require('../lib/volume-by-muscle')

const DEFAULT_EXERCISES = [
  // Груди
  { name: 'Жим лежачи', muscle_group: 'chest', equipment: 'barbell' },
  { name: 'Жим гантелей лежачи', muscle_group: 'chest', equipment: 'dumbbell' },
  { name: 'Розведення гантелей', muscle_group: 'chest', equipment: 'dumbbell' },
  { name: 'Жим в нахилі', muscle_group: 'chest', equipment: 'barbell' },
  { name: 'Віджимання на брусах', muscle_group: 'chest', equipment: 'bodyweight' },
  // Спина
  { name: 'Підтягування', muscle_group: 'back', equipment: 'bodyweight' },
  { name: 'Тяга штанги в нахилі', muscle_group: 'back', equipment: 'barbell' },
  { name: 'Тяга гантелі', muscle_group: 'back', equipment: 'dumbbell' },
  { name: 'Тяга верхнього блоку', muscle_group: 'back', equipment: 'cable' },
  { name: 'Горизонтальна тяга', muscle_group: 'back', equipment: 'cable' },
  // Плечі
  { name: 'Жим штанги стоячи', muscle_group: 'shoulders', equipment: 'barbell' },
  { name: 'Жим гантелей сидячи', muscle_group: 'shoulders', equipment: 'dumbbell' },
  { name: 'Розведення в сторони', muscle_group: 'shoulders', equipment: 'dumbbell' },
  { name: 'Тяга до підборіддя', muscle_group: 'shoulders', equipment: 'barbell' },
  // Ноги
  { name: 'Присідання', muscle_group: 'legs', equipment: 'barbell' },
  { name: 'Жим ногами', muscle_group: 'legs', equipment: 'machine' },
  { name: 'Румунська тяга', muscle_group: 'legs', equipment: 'barbell' },
  { name: 'Розгинання ніг', muscle_group: 'legs', equipment: 'machine' },
  { name: 'Згинання ніг', muscle_group: 'legs', equipment: 'machine' },
  { name: 'Підйом на носки', muscle_group: 'legs', equipment: 'machine' },
  // Руки
  { name: 'Згинання на біцепс', muscle_group: 'biceps', equipment: 'barbell' },
  { name: 'Молоткові згинання', muscle_group: 'biceps', equipment: 'dumbbell' },
  { name: 'Французький жим', muscle_group: 'triceps', equipment: 'barbell' },
  { name: 'Розгинання трицепса', muscle_group: 'triceps', equipment: 'cable' },
  // Кор
  { name: 'Скручування', muscle_group: 'core', equipment: 'bodyweight' },
  { name: 'Планка', muscle_group: 'core', equipment: 'bodyweight' },
  { name: 'Підйом ніг', muscle_group: 'core', equipment: 'bodyweight' },
]

// calc1RM/pickBestSet moved to lib/workout-sets.js (#1417) so this route,
// lib/exercise-trends.js, and any future consumer share ONE ranking function —
// see lib/workout-sets.js for the #1130 bodyweight-detection rationale.

module.exports = function (getDB) {
  const router = Router()

  // GET /api/workouts
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const { date, limit = 20, skip = 0 } = req.query
      const filter = date ? { date } : {}
      const data = await db.collection('workouts')
        .find(filter)
        .sort({ date: -1 })
        .skip(Number(skip))
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/recent
  router.get('/recent', async (req, res) => {
    try {
      const db = getDB()
      const { limit = 20 } = req.query
      const data = await db.collection('workouts')
        .find({})
        .sort({ date: -1 })
        .limit(Number(limit))
        .toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/volume-by-muscle?period=week|month&date=YYYY-MM-DD
  router.get('/volume-by-muscle', async (req, res) => {
    try {
      const db = getDB()
      const period = req.query.period || 'week'
      const bounds = periodBounds(period, req.query.date)
      if (bounds.error) return res.status(400).json({ error: bounds.error })

      const workoutsCol = db.collection('workouts')
      const [currentWorkouts, prevWorkouts] = await Promise.all([
        workoutsCol.find({ date: { $gte: bounds.from, $lte: bounds.to } }).sort({ date: 1 }).toArray(),
        workoutsCol.find({ date: { $gte: bounds.prevFrom, $lte: bounds.prevTo } }).sort({ date: 1 }).toArray(),
      ])

      const exerciseNames = [...new Set([
        ...exerciseNamesFromWorkouts(currentWorkouts),
        ...exerciseNamesFromWorkouts(prevWorkouts),
      ])]
      const library = exerciseNames.length > 0
        ? await db.collection('exercises_library').find({ name: { $in: exerciseNames } }).toArray()
        : []
      const libraryByName = new Map(library.map(ex => [String(ex.name || '').toLowerCase(), ex]))

      const current = summarizeVolumeByMuscle(currentWorkouts, libraryByName, MUSCLE_GROUPS)
      const prev = summarizeVolumeByMuscle(prevWorkouts, libraryByName, MUSCLE_GROUPS)

      res.json({
        period: bounds.period,
        from: bounds.from,
        to: bounds.to,
        ...current,
        prev: {
          from: bounds.prevFrom,
          to: bounds.prevTo,
          ...prev,
        },
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/exercises — all exercises from library + seed if empty
  router.get('/exercises', async (req, res) => {
    try {
      const db = getDB()
      const col = db.collection('exercises_library')
      let list = await col.find({}).sort({ muscle_group: 1, name: 1 }).toArray()

      if (list.length === 0) {
        const toInsert = DEFAULT_EXERCISES.map(e => ({ ...e, created_at: new Date() }))
        await col.insertMany(toInsert)
        list = await col.find({}).sort({ muscle_group: 1, name: 1 }).toArray()
      }

      res.json(list)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/workouts/exercises — add exercise to library
  router.post('/exercises', async (req, res) => {
    try {
      const db = getDB()
      const { name, muscle_group, equipment } = req.body
      if (!name || !muscle_group) return res.status(400).json({ error: 'name and muscle_group required' })

      const col = db.collection('exercises_library')
      const existing = await col.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } })
      if (existing) return res.status(409).json({ error: 'Exercise already exists', exercise: existing })

      const doc = { name, muscle_group, equipment: equipment || 'other', created_at: new Date() }
      const result = await col.insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PATCH /api/workouts/exercises/:name — #1304: add technique/video/photo content
  // to an EXISTING exercise. Exact-match findOne (no regex — names are canonical),
  // $set whitelist only. name/muscle_group/equipment/_id are never written here, so
  // this route is structurally unable to rename an exercise (the plan↔library link
  // key is the name, #1290) even if a caller passes those fields in the body.
  //
  // #1472: an unknown key (incl. `name` — rename lives at its own route below) used to
  // be silently dropped by the whitelist, so a caller trying to rename via this route
  // got a misleading 200 with nothing actually changed (Lisa hit this 21.09). Any key
  // outside the whitelist now 400s the WHOLE request instead of partially applying it —
  // same for an empty body, which previously $set an empty object and 200'd.
  const PATCH_EXERCISE_WHITELIST = ['description_ua', 'video_url', 'image_url', 'cues']
  router.patch('/exercises/:name', async (req, res) => {
    try {
      const db = getDB()
      const name = req.params.name
      const body = req.body || {}
      const bodyKeys = Object.keys(body)
      if (bodyKeys.length === 0) {
        return res.status(400).json({ error: 'request body must include at least one field' })
      }
      const unknown_fields = bodyKeys.filter(k => !PATCH_EXERCISE_WHITELIST.includes(k))
      if (unknown_fields.length > 0) {
        return res.status(400).json({
          error: 'unknown field(s) in body — use PATCH /exercises/:name/name to rename, ' +
            '/weight-unit or /muscle-group for those fields',
          unknown_fields,
        })
      }

      const { description_ua, video_url, image_url, cues } = body
      const update = {}
      if (description_ua !== undefined) update.description_ua = description_ua
      if (video_url !== undefined) update.video_url = video_url
      if (image_url !== undefined) update.image_url = image_url
      if (cues !== undefined) update.cues = cues

      const col = db.collection('exercises_library')
      const result = await col.updateOne({ name }, { $set: update })
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Exercise not found', name })
      }

      const updated = await col.findOne({ name })
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PATCH /api/workouts/exercises/:name/name — #1472: rename/merge an exercise in the
  // library. `:name` = source, body.name = target. If target doesn't exist yet, this is
  // a plain rename of the library doc. If target ALREADY exists, this MERGES source into
  // target (target's doc survives, source's doc is deleted; null fields on target get
  // backfilled from source per lib/exercise-rename.js's NULL_FILLABLE_LIBRARY_FIELDS —
  // muscle_group is deliberately excluded, a merge never guesses it).
  //
  // Backfills every name-keyed place source could appear: `workouts.exercises[].name`
  // (consolidating sets into ONE entry when a session already logged both names under
  // separate entries — every reader takes the FIRST `find` match by name, a leftover
  // second entry would be silently invisible, see lib/exercise-rename.js header),
  // `workouts.needs_muscle_group_clarification[]` / `needs_unit_clarification[]`
  // (dedup on collapse), and `training_programs.days[].exercises[].name` (0 live matches
  // today per Apex triage #1472 comment #8459, but the route stays generic).
  router.patch('/exercises/:name/name', async (req, res) => {
    try {
      const db = getDB()
      const source = req.params.name
      const { name: target } = req.body || {}
      if (typeof target !== 'string' || target.trim().length === 0) {
        return res.status(400).json({ error: 'name (target) must be a non-empty string' })
      }
      if (target === source) {
        return res.status(400).json({ error: 'target name must differ from the current name' })
      }

      const libCol = db.collection('exercises_library')
      const sourceDoc = await libCol.findOne({ name: source })
      if (!sourceDoc) {
        return res.status(404).json({ error: 'Exercise not found', name: source })
      }

      const targetDoc = await libCol.findOne({ name: target })
      const merged = !!targetDoc

      let exercise
      if (merged) {
        const fill = mergeLibraryFields(targetDoc, sourceDoc)
        fill.updated_at = new Date()
        await libCol.updateOne({ name: target }, { $set: fill })
        await libCol.deleteOne({ name: source })
        exercise = await libCol.findOne({ name: target })
      } else {
        await libCol.updateOne({ name: source }, { $set: { name: target, updated_at: new Date() } })
        exercise = await libCol.findOne({ name: target })
      }

      const workoutsCol = db.collection('workouts')
      const sessions = await workoutsCol.find({ 'exercises.name': source }).toArray()

      let renamedSessions = 0
      let consolidatedSessions = 0
      for (const session of sessions) {
        const result = consolidateSessionExercises(session.exercises, source, target)
        if (!result.changed) continue

        const setDoc = { exercises: result.exercises, updated_at: new Date() }
        if (Array.isArray(session.needs_muscle_group_clarification)) {
          setDoc.needs_muscle_group_clarification =
            replaceNameDedup(session.needs_muscle_group_clarification, source, target)
        }
        if (Array.isArray(session.needs_unit_clarification)) {
          setDoc.needs_unit_clarification =
            replaceNameDedup(session.needs_unit_clarification, source, target)
        }
        await workoutsCol.updateOne({ _id: session._id }, { $set: setDoc })

        if (result.consolidated) consolidatedSessions += 1
        else renamedSessions += 1
      }

      const programsCol = db.collection('training_programs')
      const programs = await programsCol.find({ 'days.exercises.name': source }).toArray()
      let updatedPrograms = 0
      for (const program of programs) {
        const { days, changed } = renameInProgramDays(program.days, source, target)
        if (!changed) continue
        await programsCol.updateOne({ _id: program._id }, { $set: { days, updated_at: new Date() } })
        updatedPrograms += 1
      }

      res.json({
        exercise,
        merged,
        renamed_sessions: renamedSessions,
        consolidated_sessions: consolidatedSessions,
        updated_programs: updatedPrograms,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PATCH /api/workouts/exercises/:name/weight-unit — #1318 KROK 2 (health-api half,
  // owner "Так, підходить" 2026-09-10, #1318 comment #7454): the ONE write path for
  // exercises_library.weight_unit. Separate from the generic content-PATCH above on
  // purpose — this one has a real side effect (backfill), the content one never does.
  // Called once per exercise, by whatever asks the owner the question (currently: no
  // caller wired yet — the Telegram-bot side that detects `needs_unit_clarification`
  // on a /log-text response and asks "кг чи фунти?" lives in chuttyevo-agent's src/,
  // a separate repo/zone; this route is the contract that side calls into).
  //
  // Exact-match findOne (canonical names, same as the content-PATCH above). On success,
  // walks EVERY `workouts` session containing this exercise and recomputes weight_kg for
  // any set that was left unresolved (weight_input present, weight_kg null) — "постфактум,
  // ДОПОВНЮЮЧИ наявний запис" (owner #7454): existing sessions are augmented, never
  // rejected or re-asked. A set that already has a resolved weight_kg is left untouched.
  router.patch('/exercises/:name/weight-unit', async (req, res) => {
    try {
      const db = getDB()
      const name = req.params.name
      const { weight_unit } = req.body
      if (weight_unit !== 'kg' && weight_unit !== 'lb') {
        return res.status(400).json({ error: "weight_unit must be 'kg' or 'lb'" })
      }

      const libCol = db.collection('exercises_library')
      const libResult = await libCol.updateOne({ name }, { $set: { weight_unit, updated_at: new Date() } })
      if (libResult.matchedCount === 0) {
        return res.status(404).json({ error: 'Exercise not found', name })
      }
      const exercise = await libCol.findOne({ name })

      const workoutsCol = db.collection('workouts')
      const sessions = await workoutsCol.find({ 'exercises.name': name }).toArray()

      let backfilledSessions = 0
      let backfilledSets = 0
      for (const session of sessions) {
        const { exercises, changed } = backfillWeightUnitInSession(session.exercises, name, weight_unit)
        if (!changed) continue
        const before = (session.exercises.find(e => e.name === name)?.sets || []).filter(
          s => s.weight_input != null && s.weight_kg == null
        ).length
        await workoutsCol.updateOne(
          { _id: session._id },
          { $set: { exercises, needs_unit_clarification: exercisesNeedingUnit(exercises), updated_at: new Date() } }
        )
        backfilledSessions += 1
        backfilledSets += before
      }

      res.json({ exercise, backfilled_sessions: backfilledSessions, backfilled_sets: backfilledSets })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PATCH /api/workouts/exercises/:name/muscle-group — #1408: the ONE write path for
  // exercises_library.muscle_group. Mirrors /weight-unit above (enum validation, 404 on
  // unknown name, post-write walk over `workouts`) — the generic content-PATCH at :158
  // deliberately excludes muscle_group from its whitelist, same reason /weight-unit is
  // its own route: this one has a real side effect on session docs, the content one
  // never does. `'other'` is a valid, explicit answer (an owner-confirmed "інше" is a
  // resolved state, not the same as a silent null) and clears the clarification array
  // exactly like any other valid value.
  //
  // Recomputing `needs_muscle_group_clarification` here does NOT need to re-derive the
  // WHOLE array from exercises_library — only THIS exercise's resolution state changed
  // (every other exercise in the session is untouched by this PATCH), so a plain filter
  // of `name` out of the existing array is both correct and avoids N extra library
  // lookups per session.
  router.patch('/exercises/:name/muscle-group', async (req, res) => {
    try {
      const db = getDB()
      const name = req.params.name
      const { muscle_group } = req.body
      if (!MUSCLE_GROUPS.includes(muscle_group)) {
        return res.status(400).json({ error: `muscle_group must be one of: ${MUSCLE_GROUPS.join(', ')}` })
      }

      const libCol = db.collection('exercises_library')
      const libResult = await libCol.updateOne({ name }, { $set: { muscle_group, updated_at: new Date() } })
      if (libResult.matchedCount === 0) {
        return res.status(404).json({ error: 'Exercise not found', name })
      }
      const exercise = await libCol.findOne({ name })

      const workoutsCol = db.collection('workouts')
      const sessions = await workoutsCol.find({ 'exercises.name': name }).toArray()

      let updatedSessions = 0
      for (const session of sessions) {
        const before = session.needs_muscle_group_clarification || []
        if (!before.includes(name)) continue
        const after = before.filter(n => n !== name)
        await workoutsCol.updateOne(
          { _id: session._id },
          { $set: { needs_muscle_group_clarification: after, updated_at: new Date() } }
        )
        updatedSessions += 1
      }

      res.json({ exercise, updated_sessions: updatedSessions })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/exercise-history?name=Жим лежачи
  router.get('/exercise-history', async (req, res) => {
    try {
      const db = getDB()
      const { name } = req.query
      if (!name) return res.status(400).json({ error: 'name required' })

      const workouts = await db.collection('workouts')
        .find({ 'exercises.name': name })
        .sort({ date: -1 })
        .toArray()

      const history = workouts.map(w => {
        const ex = w.exercises.find(e => e.name === name)
        if (!ex) return null
        const sets = ex.sets || []
        const volume = sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0)
        const total_reps = sets.reduce((sum, s) => sum + (s.reps || 0), 0)
        const best = pickBestSet(sets)

        return {
          date: w.date,
          workout_name: w.name,
          sets,
          volume: Math.round(volume),
          max_weight: best.weight,
          best_reps: best.reps,
          best_reps_set: best.reps,
          total_reps,
          est_1rm: best.orm,
        }
      }).filter(Boolean)

      res.json(history)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/progress?name=Жим лежачи
  router.get('/progress', async (req, res) => {
    try {
      const db = getDB()
      const { name } = req.query
      if (!name) return res.status(400).json({ error: 'name required' })

      const workouts = await db.collection('workouts')
        .find({ 'exercises.name': name })
        .sort({ date: 1 })
        .limit(30)
        .toArray()

      const progress = workouts.map(w => {
        const ex = w.exercises.find(e => e.name === name)
        if (!ex) return null
        const sets = ex.sets || []
        const total_volume = sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0)
        const max_weight = Math.max(...sets.map(s => s.weight_kg || 0))
        const total_reps = sets.reduce((sum, s) => sum + (s.reps || 0), 0)
        // #1130: same bodyweight-aware ranking as exercise-history, so est_1rm and the
        // new reps fields agree between the two endpoints for the same session.
        const best = pickBestSet(sets)

        return {
          date: w.date,
          max_weight,
          total_volume: Math.round(total_volume),
          est_1rm: best.orm,
          best_reps_set: best.reps,
          total_reps,
        }
      }).filter(Boolean)

      res.json(progress)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/progression?name=Жим гантелей лежачи — #1291 double-progression
  // engine. Reads ONLY ex.sets[] of the LAST logged session (§7/§10.5 — the next-step
  // recommendation needs only the latest session; history is used solely for the
  // increment-step lookup). Reuses the same collections/matching pattern as
  // /exercise-history and /progress above; core decision logic lives in
  // lib/exercise-progression.js so it is unit-testable without a DB.
  router.get('/progression', async (req, res) => {
    try {
      const db = getDB()
      const { name } = req.query
      if (!name) return res.status(400).json({ error: 'name required' })

      const exercise = await db.collection('exercises_library').findOne({ name })
      const equipment = exercise?.equipment ?? null
      const weightUnit = exercise?.weight_unit ?? null

      const workouts = await db.collection('workouts')
        .find({ 'exercises.name': name })
        .sort({ date: 1 })
        .toArray()
      const sessions = workouts.map(w => {
        const ex = (w.exercises || []).find(e => e.name === name)
        return { date: w.date, sets: (ex && ex.sets) || [] }
      })

      // Active program lookup — same query shape as routes/training_program.js's
      // getActiveProgram(), WITHOUT its auto-seed side effect (a read-only progression
      // check should never write a program document as a side effect).
      const programDoc = await db.collection('training_programs')
        .findOne({ is_active: true }, { sort: { version: -1 } })
      let targetRepsRaw
      if (programDoc) {
        outer: for (const day of programDoc.days || []) {
          for (const entry of day.exercises || []) {
            if (entry.name === name) {
              targetRepsRaw = entry.target_reps
              break outer
            }
          }
        }
      }

      const result = evaluateProgression({ exerciseName: name, equipment, weightUnit, sessions, targetRepsRaw })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/exercise-trends?window=N — #1417: overview of ALL exercises,
  // last-vs-previous-session status (up/flat/down) so the owner can see "де я
  // прогресую, а де просідаю" without opening every exercise one at a time.
  // `window` = last N SESSIONS per exercise to consider (integer >= 2), default = all
  // logged sessions. ONE `find({})` over `workouts` (projection date+exercises only,
  // per Apex triage — no per-exercise query, no `.limit(30)` copy from /progress which
  // is a PER-EXERCISE cap, not a global one). Pure grouping/classification logic lives
  // in lib/exercise-trends.js (unit-testable without a DB, same pattern as
  // lib/exercise-progression.js). Exercise-name grouping reuses exerciseKey() from
  // lib/volume-by-muscle.js — there is NO alias layer for exercise names (#1408 added
  // muscle-group clarification, not name aliasing; verified live, Apex triage).
  router.get('/exercise-trends', async (req, res) => {
    try {
      const db = getDB()
      let window
      if (req.query.window !== undefined) {
        window = Number(req.query.window)
        if (!Number.isInteger(window) || window < 2) {
          return res.status(400).json({ error: 'window must be an integer >= 2' })
        }
      }

      const workouts = await db.collection('workouts')
        .find({}, { projection: { date: 1, exercises: 1 } })
        .sort({ date: 1 })
        .toArray()

      const exerciseNames = exerciseNamesFromWorkouts(workouts)
      const library = exerciseNames.length > 0
        ? await db.collection('exercises_library').find({ name: { $in: exerciseNames } }).toArray()
        : []
      const libraryByName = new Map(library.map(ex => [String(ex.name || '').toLowerCase(), ex]))

      const todayStr = formatDateKyiv(new Date())
      const result = buildExerciseTrends({ workouts, libraryByName, window, todayStr })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // === PERSONAL RECORDS (PR) ===

  // Helper: calculate PRs from all workouts for given exercises
  async function calculatePRs(db, exerciseFilter) {
    const filter = exerciseFilter
      ? { 'exercises.name': exerciseFilter }
      : { exercises: { $exists: true, $ne: [] } }

    const workouts = await db.collection('workouts')
      .find(filter)
      .sort({ date: 1 })
      .toArray()

    const prMap = {} // exercise_name -> { max_weight, max_volume, max_1rm, max_reps }

    for (const w of workouts) {
      if (!w.exercises) continue
      for (const ex of w.exercises) {
        if (exerciseFilter && ex.name !== exerciseFilter) continue
        const sets = ex.sets || []
        if (sets.length === 0) continue

        if (!prMap[ex.name]) {
          prMap[ex.name] = {
            exercise: ex.name,
            muscle_group: ex.muscle_group || null,
            max_weight: { value: 0, date: null, reps: null },
            max_volume: { value: 0, date: null },
            max_1rm: { value: 0, date: null, weight: null, reps: null },
            max_reps: { value: 0, date: null, weight: null },
            total_sessions: 0,
            history: [],
          }
        }

        const pr = prMap[ex.name]
        pr.total_sessions++

        // Session metrics
        const sessionVolume = sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0)
        const roundedVolume = Math.round(sessionVolume)

        for (const s of sets) {
          const weight = s.weight_kg || 0
          const reps = s.reps || 0
          const orm = calc1RM(weight, reps)

          // Max weight PR
          if (weight > pr.max_weight.value) {
            pr.max_weight = { value: weight, date: w.date, reps }
          }

          // Max estimated 1RM PR
          if (orm > pr.max_1rm.value) {
            pr.max_1rm = { value: orm, date: w.date, weight, reps }
          }

          // Max reps at any weight > 0
          if (weight > 0 && reps > pr.max_reps.value) {
            pr.max_reps = { value: reps, date: w.date, weight }
          }
        }

        // Max volume PR (per session)
        if (roundedVolume > pr.max_volume.value) {
          pr.max_volume = { value: roundedVolume, date: w.date }
        }

        // Track history for timeline
        const bestORM = sets.reduce((best, s) => {
          const orm = calc1RM(s.weight_kg, s.reps)
          return orm > best ? orm : best
        }, 0)
        pr.history.push({
          date: w.date,
          est_1rm: bestORM,
          max_weight: Math.max(...sets.map(s => s.weight_kg || 0)),
          volume: roundedVolume,
        })
      }
    }

    return prMap
  }

  // POST /api/workouts — with PR detection
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      if (!doc.source) doc.source = 'manual'
      doc.created_at = new Date()

      // #1474: fill weight_kg for bodyweight sets (reps only, no weight_kg/weight_input)
      // from the owner's latest weight_log entry on/before the session date — BEFORE
      // library registration, so the library auto-create below sees the same doc that
      // gets inserted. Never overwrites an explicit weight_kg/weight_input.
      if (doc.exercises && doc.exercises.length > 0) {
        const bodyweightKg = await resolveBodyweightForDate(db.collection('weight_log'), doc.date)
        doc.exercises = fillBodyweightSets(doc.exercises, bodyweightKg).exercises
      }

      // #1473: register/match every exercise in `exercises_library` regardless of
      // `source` — this route used to be one of two write paths (with PUT /:id below)
      // that skipped the library entirely, so a bodyweight session (no weight_kg on any
      // set) was invisible to PATCH /exercises/:name/muscle-group afterward.
      if (doc.exercises && doc.exercises.length > 0) {
        await ensureExercisesInLibrary(db.collection('exercises_library'), doc.exercises.map(ex => ex.name))
      }

      // Calculate PRs BEFORE inserting to detect new records
      let newPRs = []
      if (doc.exercises && doc.exercises.length > 0) {
        const exerciseNames = doc.exercises.map(e => e.name)
        const oldPRs = await calculatePRs(db)

        // Insert the workout
        const result = await db.collection('workouts').insertOne(doc)
        const insertedDoc = { ...doc, _id: result.insertedId }

        // Check each exercise for new PRs
        for (const ex of doc.exercises) {
          const sets = ex.sets || []
          if (sets.length === 0) continue

          const oldPR = oldPRs[ex.name]
          const exercisePRs = []

          for (const s of sets) {
            const weight = s.weight_kg || 0
            const reps = s.reps || 0
            const orm = calc1RM(weight, reps)

            // New max weight?
            if (!oldPR || weight > oldPR.max_weight.value) {
              exercisePRs.push({
                type: 'max_weight',
                value: weight,
                previous: oldPR ? oldPR.max_weight.value : 0,
                reps,
              })
            }

            // New 1RM?
            if (!oldPR || orm > oldPR.max_1rm.value) {
              exercisePRs.push({
                type: 'max_1rm',
                value: orm,
                previous: oldPR ? oldPR.max_1rm.value : 0,
                weight,
                reps,
              })
            }

            // New max reps at weight?
            if (weight > 0 && (!oldPR || reps > oldPR.max_reps.value)) {
              exercisePRs.push({
                type: 'max_reps',
                value: reps,
                previous: oldPR ? oldPR.max_reps.value : 0,
                weight,
              })
            }
          }

          // Check session volume
          const sessionVolume = Math.round(sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0))
          if (!oldPR || sessionVolume > oldPR.max_volume.value) {
            exercisePRs.push({
              type: 'max_volume',
              value: sessionVolume,
              previous: oldPR ? oldPR.max_volume.value : 0,
            })
          }

          if (exercisePRs.length > 0) {
            // Deduplicate — keep only the best per type
            const bestByType = {}
            for (const pr of exercisePRs) {
              if (!bestByType[pr.type] || pr.value > bestByType[pr.type].value) {
                bestByType[pr.type] = pr
              }
            }
            newPRs.push({
              exercise: ex.name,
              records: Object.values(bestByType),
            })
          }
        }

        return res.status(201).json({
          ...insertedDoc,
          new_prs: newPRs.length > 0 ? newPRs : undefined,
        })
      }

      const result = await db.collection('workouts').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/workouts/log-text — #1314: accept a strength session the owner dictated
  // in Telegram (one line per exercise, "Назва: 8х80 · 7х80 · 6х80" — reps FIRST, weight
  // SECOND, per #1291 §"РЕФЕРЕНС ВЛАСНИКА" pt.1). This is the ONLY currently-missing
  // write path into `workouts` — the UI form (health-dashboard Workouts.jsx) already
  // POSTs structured JSON to `/` above; this route does the free-text -> structured-JSON
  // step and then reuses the SAME collection/shape, no schema change.
  //
  // weight_unit lives on the EXERCISE (#1291 §5, owner "затверджую" 09.09). #1318
  // KROK 1 (S-slice, owner "Запускай 1318" 2026-09-10): an unknown unit is an EXPLICIT
  // state, never a silent kg default — 0ecbcf0 (#1314 follow-up) had briefly made the
  // first dictated numeric load initialize a missing exercise unit to 'kg', which is
  // exactly the class of bug #1318 exists to close (розводка 235 is lb, not kg). The
  // raw weight_input is always preserved regardless of whether the unit is known; a set
  // with an unresolved unit gets weight_kg=null and its exercise name is surfaced on the
  // session doc via `needs_unit_clarification` so the session is never silently wrong —
  // KROK 2 (crosses into the Telegram bot) asks the owner once per exercise and writes
  // exercises_library.weight_unit; this route does NOT guess or write that field itself.
  //
  // Idempotency (#1314 acceptance) is scoped to {date, source:'telegram-log'}: re-POSTing
  // the same text merges into the SAME session doc, replacing each exercise's sets by
  // name rather than duplicating — a manual UI entry (source:'manual') for the same date
  // is a SEPARATE doc, untouched. `needs_unit_clarification` is recomputed from the FULL
  // merged exercises array on every write, so it always reflects current session state
  // (e.g. clears once KROK 2 backfills a unit and the exercise is re-merged).
  router.post('/log-text', async (req, res) => {
    try {
      const db = getDB()
      const { text, date, source } = req.body
      if (!text || !String(text).trim()) {
        return res.status(400).json({ error: 'text required' })
      }

      const sessionDate = date || new Date().toISOString().split('T')[0]
      const sessionSource = source || 'telegram-log'

      const { entries, skipped } = parseWorkoutLogText(text)
      if (entries.length === 0) {
        return res.status(400).json({ error: 'no parseable exercise lines found', skipped })
      }

      // #1473: auto-create/match against `exercises_library` via the SAME shared helper
      // now also used by POST / and PUT /:id — unit "не задано" (#1318 KROK 1: never
      // guess) and muscle_group likewise never guessed (#1408, surfaced below via
      // needs_muscle_group_clarification instead of staying a silent null).
      const libCol = db.collection('exercises_library')
      const libByName = await ensureExercisesInLibrary(libCol, entries.map(e => e.name))
      let newExercises = entries.map(entry => buildExerciseFromParsed(entry, libByName.get(entry.name)?.weight_unit ?? null))

      // #1474: same bodyweight autofill as POST / and PUT /:id — wired in for scope
      // consistency across all three write paths. In practice this route's parser
      // (parseWorkoutLogText) requires REPSxWEIGHT on every token, so `weight_input` is
      // always set on a parsed set and this is a no-op today; kept so a future dictation
      // format that allows a bare reps-only line doesn't silently skip autofill here.
      const bodyweightKgForText = await resolveBodyweightForDate(db.collection('weight_log'), sessionDate)
      newExercises = fillBodyweightSets(newExercises, bodyweightKgForText).exercises

      const workoutsCol = db.collection('workouts')
      const existing = await workoutsCol.findOne({ date: sessionDate, source: sessionSource })

      let resultDoc
      if (!existing) {
        const doc = {
          date: sessionDate,
          name: 'Тренування (лог)',
          source: sessionSource,
          exercises: newExercises,
          needs_unit_clarification: exercisesNeedingUnit(newExercises),
          needs_muscle_group_clarification: exercisesNeedingMuscleGroup(newExercises, libByName),
          created_at: new Date(),
        }
        const insertResult = await workoutsCol.insertOne(doc)
        resultDoc = { ...doc, _id: insertResult.insertedId }
      } else {
        const mergedExercises = mergeExercisesIntoDoc(existing.exercises, newExercises)
        const needsUnitClarification = exercisesNeedingUnit(mergedExercises)
        // #1408: exercises carried over from `existing` that this POST's text didn't
        // touch have no entry in libByName yet — resolve them with one extra lookup so
        // needs_muscle_group_clarification reflects the FULL merged array, mirroring
        // needs_unit_clarification's own "recompute from the full merged array" rule.
        const unresolvedNames = mergedExercises.map(ex => ex.name).filter(n => !libByName.has(n))
        if (unresolvedNames.length > 0) {
          const extraLibDocs = await libCol.find({ name: { $in: unresolvedNames } }).toArray()
          for (const doc of extraLibDocs) libByName.set(doc.name, doc)
        }
        const needsMuscleGroupClarification = exercisesNeedingMuscleGroup(mergedExercises, libByName)
        await workoutsCol.updateOne(
          { _id: existing._id },
          { $set: { exercises: mergedExercises, needs_unit_clarification: needsUnitClarification, needs_muscle_group_clarification: needsMuscleGroupClarification, updated_at: new Date() } }
        )
        resultDoc = { ...existing, exercises: mergedExercises, needs_unit_clarification: needsUnitClarification, needs_muscle_group_clarification: needsMuscleGroupClarification }
      }

      res.status(existing ? 200 : 201).json({ ...resultDoc, skipped: skipped.length > 0 ? skipped : undefined })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/workouts/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const doc = req.body
      delete doc._id
      doc.updated_at = new Date()

      // #1474: same bodyweight autofill as POST / above. An edit payload from the UI
      // doesn't always resend `date` (it PATCHes only `exercises` in the common case) —
      // fall back to the existing session's own date so the fill still resolves against
      // the RIGHT day, not "no date at all -> null" (resolveBodyweightForDate treats a
      // missing date as no-op, so a silent skip here would leave edited bodyweight sets
      // unfilled forever).
      if (doc.exercises && doc.exercises.length > 0) {
        let sessionDate = doc.date
        if (!sessionDate) {
          const existing = await db.collection('workouts').findOne({ _id: new ObjectId(req.params.id) })
          sessionDate = existing?.date
        }
        const bodyweightKg = await resolveBodyweightForDate(db.collection('weight_log'), sessionDate)
        doc.exercises = fillBodyweightSets(doc.exercises, bodyweightKg).exercises
      }

      // #1473: same registration as POST / above — an edit that adds/renames an
      // exercise must not leave it invisible to the library either.
      if (doc.exercises && doc.exercises.length > 0) {
        await ensureExercisesInLibrary(db.collection('exercises_library'), doc.exercises.map(ex => ex.name))
      }

      const result = await db.collection('workouts').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: doc },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/workouts/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      await db.collection('workouts').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
