const { Router } = require('express')
const { hasPositiveWeight } = require('../lib/workout-sets')
const { evaluateProgression } = require('../lib/exercise-progression')
const { parseWorkoutLogText } = require('../lib/workout-log-parser')
const { buildExerciseFromParsed, mergeExercisesIntoDoc, exercisesNeedingUnit } = require('../lib/workout-log-write')

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

function calc1RM(weight, reps) {
  if (!weight || !reps) return 0
  return Math.round(weight * (1 + reps / 30) * 10) / 10
}

// #1130: pick the "best" set of a session for ranking/history purposes.
// Bodyweight exercises (pull-ups, dips, planks…) log sets with no `weight_kg`, so
// calc1RM() always returns 0 for every set and the old orm-based reduce could never
// pick a winner — max_weight/best_reps/est_1rm silently stayed 0 forever.
// Bodyweight detection rule (documented, not implicit): a session is bodyweight when
// NONE of its logged sets carry a positive `weight_kg` — this reads straight off the
// `workouts` data actually being ranked (no extra `exercises_library.equipment` lookup
// needed) and degrades correctly if a bodyweight exercise is later logged WITH added
// weight (weighted pull-ups): it then ranks by 1RM again, same as any weighted lift.
function pickBestSet(sets) {
  const hasWeight = hasPositiveWeight(sets)
  if (hasWeight) {
    // Weighted exercise — unchanged behavior: rank by estimated 1RM.
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
  router.patch('/exercises/:name', async (req, res) => {
    try {
      const db = getDB()
      const name = req.params.name
      const { description_ua, video_url, image_url, cues } = req.body

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

  // GET /api/workouts/prs — all PRs across all exercises
  router.get('/prs', async (req, res) => {
    try {
      const db = getDB()
      const { muscle_group, include_history } = req.query

      const prMap = await calculatePRs(db)
      let prs = Object.values(prMap)

      // Filter by muscle group
      if (muscle_group) {
        prs = prs.filter(p => p.muscle_group === muscle_group)
      }

      // Optionally strip history for lighter response
      if (include_history !== 'true') {
        prs = prs.map(({ history, ...rest }) => rest)
      }

      // Sort by 1RM descending
      prs.sort((a, b) => b.max_1rm.value - a.max_1rm.value)

      res.json(prs)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/prs/:name — PR for specific exercise (name in query for Cyrillic support)
  router.get('/prs/exercise', async (req, res) => {
    try {
      const db = getDB()
      const { name, include_history } = req.query
      if (!name) return res.status(400).json({ error: 'name query parameter required' })

      const prMap = await calculatePRs(db, name)
      const pr = prMap[name]

      if (!pr) {
        return res.status(404).json({ error: 'No records found for this exercise' })
      }

      if (include_history !== 'true') {
        delete pr.history
      }

      res.json(pr)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/workouts/prs/summary — compact summary: top PRs + recent records
  router.get('/prs/summary', async (req, res) => {
    try {
      const db = getDB()
      const { days = 30 } = req.query
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - Number(days))
      const cutoffStr = cutoff.toISOString().split('T')[0]

      const prMap = await calculatePRs(db)
      const allPRs = Object.values(prMap)

      // Top 5 exercises by 1RM
      const top5by1RM = [...allPRs]
        .sort((a, b) => b.max_1rm.value - a.max_1rm.value)
        .slice(0, 5)
        .map(({ history, ...rest }) => rest)

      // Recent PRs — exercises where any PR was set within last N days
      const recentPRs = allPRs
        .filter(p => {
          return (p.max_weight.date >= cutoffStr) ||
                 (p.max_volume.date >= cutoffStr) ||
                 (p.max_1rm.date >= cutoffStr) ||
                 (p.max_reps.date >= cutoffStr)
        })
        .map(p => {
          const recent = {}
          if (p.max_weight.date >= cutoffStr) recent.max_weight = p.max_weight
          if (p.max_volume.date >= cutoffStr) recent.max_volume = p.max_volume
          if (p.max_1rm.date >= cutoffStr) recent.max_1rm = p.max_1rm
          if (p.max_reps.date >= cutoffStr) recent.max_reps = p.max_reps
          return {
            exercise: p.exercise,
            muscle_group: p.muscle_group,
            total_sessions: p.total_sessions,
            recent_prs: recent,
          }
        })

      // Stats
      const totalExercises = allPRs.length
      const totalSessions = allPRs.reduce((sum, p) => sum + p.total_sessions, 0)

      res.json({
        total_exercises_tracked: totalExercises,
        total_workout_sessions: totalSessions,
        top_5_by_1rm: top5by1RM,
        recent_prs: recentPRs,
        period_days: Number(days),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/workouts — with PR detection
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      if (!doc.source) doc.source = 'manual'
      doc.created_at = new Date()

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

      const libCol = db.collection('exercises_library')
      const newExercises = []
      for (const entry of entries) {
        const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        let libDoc = await libCol.findOne({ name: { $regex: new RegExp(`^${escaped}$`, 'i') } })
        if (!libDoc) {
          // Auto-create a minimal library entry — unit "не задано" (#1318 KROK 1: never
          // guess). KROK 2 fills weight_unit once the owner answers, this route never does.
          const created = { name: entry.name, muscle_group: null, equipment: null, weight_unit: null, created_at: new Date() }
          const insertResult = await libCol.insertOne(created)
          libDoc = { ...created, _id: insertResult.insertedId }
        }
        newExercises.push(buildExerciseFromParsed(entry, libDoc.weight_unit ?? null))
      }

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
          created_at: new Date(),
        }
        const insertResult = await workoutsCol.insertOne(doc)
        resultDoc = { ...doc, _id: insertResult.insertedId }
      } else {
        const mergedExercises = mergeExercisesIntoDoc(existing.exercises, newExercises)
        const needsUnitClarification = exercisesNeedingUnit(mergedExercises)
        await workoutsCol.updateOne(
          { _id: existing._id },
          { $set: { exercises: mergedExercises, needs_unit_clarification: needsUnitClarification, updated_at: new Date() } }
        )
        resultDoc = { ...existing, exercises: mergedExercises, needs_unit_clarification: needsUnitClarification }
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
