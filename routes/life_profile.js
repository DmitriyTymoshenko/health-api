const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { validateBody } = require('../lib/life-contracts')
const { todayKyiv, isValidKyivDayFormat } = require('../lib/kyiv-day')

// Imported test/note remains read-only. User observations live separately and
// never rewrite the assessment, auto-score themes, or enter the business KB.
module.exports = function (getDB) {
  const router = Router()
  router.get('/profile', async (req, res) => {
    try {
      const doc = await getDB().collection('life_profile').findOne({})
      if (!doc) return res.status(404).json({ error: 'Profile not seeded yet' })
      res.json(doc)
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  router.get('/profile/observations', async (req, res) => {
    try {
      const filter = { archived_at: req.query.archived === 'true' ? { $ne: null } : null }
      if (req.query.theme) filter.theme_key = String(req.query.theme)
      const observations = await getDB().collection('life_strength_observations').find(filter).sort({ day: -1 }).limit(100).toArray()
      res.json({ observations })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  async function validateFields(body, db) {
    if (body.day !== undefined && (!isValidKyivDayFormat(body.day) || body.day > todayKyiv())) return 'Оберіть сьогоднішню або минулу дату'
    for (const key of ['context', 'action', 'result']) {
      if (body[key] !== undefined && !body[key].trim()) return 'Додайте конкретну ситуацію, дію та результат'
    }
    if (body.theme_key !== undefined) {
      const profile = await db.collection('life_profile').findOne({})
      if (!profile?.strengths?.some((s) => s.key === body.theme_key)) return 'Оберіть тему зі збереженого профілю'
    }
    return null
  }

  router.post('/profile/observations', validateBody('StrengthObservationRequest'), async (req, res) => {
    try {
      const db = getDB()
      const error = await validateFields(req.body, db)
      if (error) return res.status(400).json({ error })
      const now = new Date()
      const doc = { ...req.body, context: req.body.context.trim(), action: req.body.action.trim(), result: req.body.result.trim(), feedback: (req.body.feedback || '').trim(), source: 'dashboard', created_at: now, updated_at: now, archived_at: null }
      const inserted = await db.collection('life_strength_observations').insertOne(doc)
      res.status(201).json({ ...doc, _id: inserted.insertedId })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  router.put('/profile/observations/:id', validateBody('StrengthObservationUpdateRequest'), async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Observation not found' })
      const db = getDB()
      const error = await validateFields(req.body, db)
      if (error) return res.status(400).json({ error })
      const set = { updated_at: new Date() }
      for (const key of ['theme_key', 'day', 'kind', 'context', 'action', 'result', 'feedback']) {
        if (req.body[key] !== undefined) set[key] = req.body[key].trim()
      }
      if (req.body.archived !== undefined) set.archived_at = req.body.archived ? new Date() : null
      const doc = await db.collection('life_strength_observations').findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: set }, { returnDocument: 'after' })
      if (!doc) return res.status(404).json({ error: 'Observation not found' })
      res.json(doc)
    } catch (err) { res.status(500).json({ error: err.message }) }
  })
  return router
}
