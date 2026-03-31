const { Router } = require('express')

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
        const best = sets.reduce((best, s) => {
          const orm = calc1RM(s.weight_kg, s.reps)
          return orm > best.orm ? { orm, weight: s.weight_kg, reps: s.reps } : best
        }, { orm: 0, weight: 0, reps: 0 })

        return {
          date: w.date,
          workout_name: w.name,
          sets,
          volume: Math.round(volume),
          max_weight: best.weight,
          best_reps: best.reps,
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
        const est_1rm = sets.reduce((best, s) => {
          const orm = calc1RM(s.weight_kg, s.reps)
          return orm > best ? orm : best
        }, 0)

        return {
          date: w.date,
          max_weight,
          total_volume: Math.round(total_volume),
          est_1rm,
        }
      }).filter(Boolean)

      res.json(progress)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/workouts
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const doc = req.body
      if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
      if (!doc.source) doc.source = 'manual'
      doc.created_at = new Date()

      const result = await db.collection('workouts').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
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
