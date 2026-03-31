const { Router } = require('express')

const DEFAULT_SUPPLEMENTS = [
  { id: 1, name: 'GymBeam Vitamin D3', dose: '2000 IU (1 капс)', schedule: 'morning', notes: 'після сніданку', active: true },
  { id: 2, name: 'GymBeam Omega 3', dose: '2 капс (2000мг / 600мг EPA+DHA)', schedule: 'morning', notes: 'після сніданку', active: true },
  { id: 3, name: 'Amix Creatine HCl', dose: '2-3 капс (~3г)', schedule: 'morning', notes: 'ранок або до/після тренування', active: true },
  { id: 4, name: 'GymBeam Vitality Complex', dose: '2 табл', schedule: 'morning', notes: 'після сніданку', active: true },
  { id: 5, name: 'NOW Organic Spirulina', dose: '3-6 табл (500мг/табл)', schedule: 'morning', notes: 'після сніданку', active: true },
  { id: 6, name: 'NOW Psyllium Husk Caps', dose: '3-5 капс (500мг/капс)', schedule: 'pre_meal', notes: 'за 15-20 хв перед їжею', active: true },
  { id: 7, name: 'Applied Nutrition Amino Fuel EAA', dose: '1 мірна ложка (~10-14г)', schedule: 'pre_workout', notes: 'за 15-30 хв до тренування', active: true },
  { id: 8, name: 'VPLab ZMA', dose: '3 капс (Zinc 30мг + Mg 450мг + B6 10.5мг)', schedule: 'evening', notes: 'перед сном', active: true },
]

const DEFAULT_CYCLES = [
  {
    id: 1,
    supplement_id: 3,
    supplement_name: 'Amix Creatine HCl',
    start_date: '2026-03-30',
    duration_weeks: 8,
    pause_weeks: 4,
    status: 'active',
    notes: '8 тижнів прийом / 4 тижні пауза',
  },
]

module.exports = function (getDB) {
  const router = Router()

  async function ensureSeed(db) {
    const count = await db.collection('supplement_catalog').countDocuments()
    if (count === 0) {
      await db.collection('supplement_catalog').insertMany(DEFAULT_SUPPLEMENTS)
    }
    const cycleCount = await db.collection('supplement_cycles').countDocuments()
    if (cycleCount === 0) {
      await db.collection('supplement_cycles').insertMany(DEFAULT_CYCLES)
    }
  }

  // GET /api/catalog
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      await ensureSeed(db)
      const data = await db.collection('supplement_catalog').find({}).sort({ schedule: 1, id: 1 }).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/catalog
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const lastItem = await db.collection('supplement_catalog').findOne({}, { sort: { id: -1 } })
      const newId = (lastItem?.id || 0) + 1
      const doc = { ...req.body, id: newId, active: true }
      await db.collection('supplement_catalog').insertOne(doc)
      res.status(201).json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/catalog/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      const { _id, ...updates } = req.body
      const result = await db.collection('supplement_catalog').findOneAndUpdate(
        { id },
        { $set: updates },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/catalog/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      await db.collection('supplement_catalog').deleteOne({ id })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/catalog/intake?date=YYYY-MM-DD
  router.get('/intake', async (req, res) => {
    try {
      const db = getDB()
      const date = req.query.date || new Date().toISOString().split('T')[0]
      const data = await db.collection('supplement_intake').find({ date }).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/catalog/intake  — mark as taken
  router.post('/intake', async (req, res) => {
    try {
      const db = getDB()
      const sid = Number(req.body.supplement_id)
      const d = req.body.date || new Date().toISOString().split('T')[0]
      // prevent duplicate
      const exists = await db.collection('supplement_intake').findOne({ supplement_id: sid, date: d })
      if (exists) return res.json(exists)
      const doc = { supplement_id: sid, date: d, taken_at: new Date().toISOString() }
      const result = await db.collection('supplement_intake').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/catalog/intake — unmark (by supplement_id + date)
  router.delete('/intake', async (req, res) => {
    try {
      const db = getDB()
      const sid = Number(req.query.supplement_id)
      const date = req.query.date
      await db.collection('supplement_intake').deleteOne({ supplement_id: sid, date })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/catalog/cycles
  router.get('/cycles', async (req, res) => {
    try {
      const db = getDB()
      await ensureSeed(db)
      const data = await db.collection('supplement_cycles').find({}).sort({ start_date: -1 }).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/catalog/cycles
  router.post('/cycles', async (req, res) => {
    try {
      const db = getDB()
      const lastItem = await db.collection('supplement_cycles').findOne({}, { sort: { id: -1 } })
      const newId = (lastItem?.id || 0) + 1
      const doc = { ...req.body, id: newId, status: 'active' }
      await db.collection('supplement_cycles').insertOne(doc)
      res.status(201).json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/catalog/cycles/:id
  router.put('/cycles/:id', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      const { _id, ...updates } = req.body
      const result = await db.collection('supplement_cycles').findOneAndUpdate(
        { id },
        { $set: updates },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/catalog/cycles/:id
  router.delete('/cycles/:id', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      await db.collection('supplement_cycles').deleteOne({ id })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/catalog/cycles/alerts
  router.get('/cycles/alerts', async (req, res) => {
    try {
      const db = getDB()
      const today = new Date()
      const cycles = await db.collection('supplement_cycles').find({ status: 'active' }).toArray()
      const alerts = cycles.map(c => {
        const start = new Date(c.start_date)
        const endDate = new Date(start)
        endDate.setDate(endDate.getDate() + c.duration_weeks * 7)
        const daysLeft = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24))
        return { ...c, days_left: daysLeft }
      }).filter(c => c.days_left >= 0 && c.days_left <= 7)
      res.json(alerts)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/catalog/knowledge — all supplement knowledge entries
  router.get('/knowledge', async (req, res) => {
    try {
      const db = getDB()
      const data = await db.collection('supplement_knowledge').find({}).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/catalog/knowledge/:catalog_id — update knowledge entry
  router.put('/knowledge/:id', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      const { _id, ...updates } = req.body
      const result = await db.collection('supplement_knowledge').findOneAndUpdate(
        { catalog_id: id },
        { $set: updates },
        { returnDocument: 'after', upsert: true }
      )
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
