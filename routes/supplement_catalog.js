const { Router } = require('express')
const { validateSupplementKnowledgeCycle, validateKnowledgeCycleInvariant } = require('../lib/validate')
const { ensureAutoCycleForSupplement } = require('../lib/supplement-autocycle')
const { cycleStatus, cycleWindow } = require('../lib/cycle-status')
const { formatDateKyiv } = require('../lib/training-program')
const { loadCorpus } = require('../lib/koliada-corpus')
const { callGemini, GEMINI_MODEL } = require('../lib/gemini-text')
const { fetchLatestLabs } = require('../lib/labs-latest')
const { RECS_RESPONSE_SCHEMA, buildRecsPrompt, toRawCandidate } = require('../lib/recs-generate')
const { postprocessRecommendations } = require('../lib/recs-postprocess')
const { retrieveKoliadaSnippets, formatSnippets, termsFromStackAndLabs } = require('../lib/koliada-retrieve')

// #1488 (stage C of #1485): manual refresh cap for GET /catalog/recommendations
// /refresh — env-overridable with a hardcoded default (no new drop-in needed,
// same rule as GEMINI_TEXT_MODEL in lib/gemini-text.js — a pure code default
// needs no systemd unit file).
const RECS_REFRESH_CAP = Math.max(1, Number(process.env.RECS_REFRESH_CAP) || 5)

// supplement_intake: retained read-only (84 docs, last write 2026-06-29); drop = owner decision (Level 3), #1485

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
  // #1487 (stage B of #1485, design D6): an optional `knowledge` object in
  // the body ({continuous, cycle, purchase_url, purchase_note, source}) gets
  // upserted into supplement_knowledge for the new catalog id, and — when
  // `knowledge.cycle` is non-null — an auto-cycle is created starting today
  // (Kyiv). Response shape: {item, knowledge, cycle, cycle_error?}. When the
  // request has no `knowledge` at all (every pre-#1487 caller), `knowledge`
  // and `cycle` are both `null` in the response — a purely additive change,
  // no existing caller reads this route's response body (grepped: the
  // dashboard's `addOrReactivateSupplement` fires the POST and never awaits
  // `.json()` on it).
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const { knowledge: knowledgeInput, ...itemBody } = req.body
      const lastItem = await db.collection('supplement_catalog').findOne({}, { sort: { id: -1 } })
      const newId = (lastItem?.id || 0) + 1
      const doc = { ...itemBody, id: newId, active: true }
      await db.collection('supplement_catalog').insertOne(doc)

      let knowledge = null
      let cycle = null
      let cycle_error = null
      if (knowledgeInput) {
        const invariantError = validateKnowledgeCycleInvariant(knowledgeInput)
        if (invariantError) {
          // Item is already created — do not roll it back over an optional
          // knowledge block being malformed; report the error alongside.
          return res.status(201).json({ item: doc, knowledge: null, cycle: null, cycle_error: invariantError })
        }
        const knowledgeDoc = { ...knowledgeInput, catalog_id: newId }
        knowledge = await db.collection('supplement_knowledge').findOneAndUpdate(
          { catalog_id: newId },
          { $set: knowledgeDoc },
          { returnDocument: 'after', upsert: true }
        )
        const autoCycle = await ensureAutoCycleForSupplement(db, newId, doc.name, knowledgeInput)
        cycle = autoCycle.cycle
        cycle_error = autoCycle.cycle_error
      }

      const responseBody = { item: doc, knowledge, cycle }
      if (cycle_error) responseBody.cycle_error = cycle_error
      res.status(201).json(responseBody)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/catalog/:id
  // #1487 (stage B of #1485, design D6): reactivating an archived item
  // (active:false -> active:true — #1427's own write path from the dashboard's
  // "▶ Повернути" button) creates a NEW auto-cycle from today, mirroring what
  // POST does for a brand-new item, IF the supplement's knowledge doc has a
  // cycle. A plain edit (any other field change, or active already true/false
  // unchanged) never touches cycles. Dedupe (same supplement_id + same day) is
  // handled by ensureAutoCycleForSupplement itself — a double-click reactivate
  // never creates two auto-cycles for one day.
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      const { _id, ...updates } = req.body

      const before = await db.collection('supplement_catalog').findOne({ id })
      const result = await db.collection('supplement_catalog').findOneAndUpdate(
        { id },
        { $set: updates },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })

      const isReactivation = before && before.active === false && updates.active === true
      let cycle = null
      let cycle_error = null
      if (isReactivation) {
        const knowledge = await db.collection('supplement_knowledge').findOne({ catalog_id: id })
        if (knowledge && knowledge.cycle) {
          const autoCycle = await ensureAutoCycleForSupplement(db, id, result.name, knowledge)
          cycle = autoCycle.cycle
          cycle_error = autoCycle.cycle_error
        }
      }

      if (isReactivation) {
        const responseBody = { ...result, cycle }
        if (cycle_error) responseBody.cycle_error = cycle_error
        return res.json(responseBody)
      }
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

  // GET /api/catalog/cycles
  // #1487 (stage B of #1485, design D7): every cycle gets computed_status +
  // active_end + pause_end via lib/cycle-status.js (server-side parity port
  // of the dashboard's own cycleStatus() util — see that file's header for
  // why this is a deliberate duplicate, not a shared import). The dashboard
  // is NOT required to read these fields — it keeps computing its own `st`
  // client-side (#1412/#1420 tests unchanged) — these exist for
  // lib/cycle-notify.js and any future non-dashboard consumer.
  router.get('/cycles', async (req, res) => {
    try {
      const db = getDB()
      await ensureSeed(db)
      const data = await db.collection('supplement_cycles').find({}).sort({ start_date: -1 }).toArray()
      const enriched = data.map(c => ({
        ...c,
        computed_status: cycleStatus(c),
        ...cycleWindow(c),
      }))
      res.json(enriched)
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

  // POST /api/catalog/cycles/:id/restart
  // #1487 (stage B of #1485, design D7): the old cycle is marked
  // status:'completed' (a manual override — it stays "Завершено" forever,
  // never reverts to a date-derived status) and a BRAND NEW cycle is created
  // starting today (Kyiv), same duration/pause as the old one UNLESS the
  // supplement's current knowledge.cycle disagrees — knowledge wins, because
  // it reflects the latest Koliada/owner-confirmed guidance, while the old
  // cycle doc may be stale (e.g. created before a knowledge correction).
  router.post('/cycles/:id/restart', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      const oldCycle = await db.collection('supplement_cycles').findOne({ id })
      if (!oldCycle) return res.status(404).json({ error: 'Not found' })

      await db.collection('supplement_cycles').updateOne({ id }, { $set: { status: 'completed' } })

      const knowledge = await db.collection('supplement_knowledge').findOne({ catalog_id: oldCycle.supplement_id })
      const durationWeeks = knowledge?.cycle?.duration_weeks ?? oldCycle.duration_weeks
      const pauseWeeks = knowledge?.cycle?.pause_weeks ?? oldCycle.pause_weeks ?? 0

      const lastItem = await db.collection('supplement_cycles').findOne({}, { sort: { id: -1 } })
      const newId = (lastItem?.id || 0) + 1
      const newCycle = {
        supplement_id: oldCycle.supplement_id,
        supplement_name: oldCycle.supplement_name,
        start_date: formatDateKyiv(new Date()),
        duration_weeks: durationWeeks,
        pause_weeks: pauseWeeks,
        status: 'active',
        created_by: 'restart',
        id: newId,
      }
      await db.collection('supplement_cycles').insertOne(newCycle)
      res.status(201).json({ old_cycle_id: id, cycle: newCycle })
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

  // PATCH /api/catalog/:id/stock — update stock_remaining
  // #1489 (stage E of #1485, design E2): also anchors the new count to today
  // (Kyiv) — `stock_anchor_date` + `stock_anchor_count` — so
  // lib/stock.js::computeStock can derive `remaining` day-by-day from this
  // point forward instead of needing a decrementing cron. anchor_count takes
  // whichever of stock_remaining/stock_count was actually sent (mirrors the
  // existing "one or the other" contract just above).
  router.patch('/:id/stock', async (req, res) => {
    try {
      const db = getDB()
      const id = Number(req.params.id)
      const updates = {}
      if (req.body.stock_remaining !== undefined) updates.stock_remaining = Number(req.body.stock_remaining)
      if (req.body.stock_count !== undefined) updates.stock_count = Number(req.body.stock_count)
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'stock_remaining or stock_count required' })
      updates.stock_anchor_date = formatDateKyiv(new Date())
      updates.stock_anchor_count = updates.stock_remaining !== undefined ? updates.stock_remaining : updates.stock_count
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

  // PUT /api/catalog/knowledge/:catalog_id — update knowledge entry
  // #1487 (stage B of #1485, design D3/B3): validateSupplementKnowledgeCycle
  // rejects a continuous/cycle contradiction BEFORE the upsert.
  router.put('/knowledge/:id', validateSupplementKnowledgeCycle, async (req, res) => {
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

  // #1488 (stage C of #1485): LLM-generated recommendations. Gathers the
  // active stack + knowledge + fresh labs + recent WHOOP + the Koliada
  // corpus, calls Gemini, then runs the result through
  // lib/recs-postprocess.js (Rule 6: any failure below — no API key, empty
  // corpus, a Gemini error, unparseable JSON — degrades to 200 with
  // `recommendations:[]` + `errors:[...]`, never a 500, and the doc is NOT
  // cached on error so the next GET retries instead of freezing a failure).
  async function generateRecommendationsPayload(db) {
    const [activeStack, knowledgeDocs, latestLabs, whoopDocs] = await Promise.all([
      db.collection('supplement_catalog').find({ active: { $ne: false } }).toArray(),
      db.collection('supplement_knowledge').find({}).toArray(),
      fetchLatestLabs(db),
      db.collection('daily_metrics').find({}).sort({ date: -1 }).limit(1).toArray(),
    ])
    const knowledgeByCatalogId = new Map(knowledgeDocs.map(k => [k.catalog_id, k]))
    const whoopLatest = whoopDocs[0] || null

    const { text: corpusText } = loadCorpus()
    const apiKey = process.env.GOOGLE_AI_API_KEY

    if (!apiKey) {
      return { recommendations: [], warnings: [], errors: ['GOOGLE_AI_API_KEY not configured'], model: null, usage: null }
    }
    if (!corpusText) {
      return { recommendations: [], warnings: [], errors: ['Koliada corpus unavailable (vault dir not found)'], model: null, usage: null }
    }

    const snippets = retrieveKoliadaSnippets(corpusText, termsFromStackAndLabs(activeStack, latestLabs), { contextLines: 3, limit: 16 })
    const evidenceText = formatSnippets(snippets)
    const prompt = buildRecsPrompt({ activeStack, knowledgeByCatalogId, latestLabs, whoopLatest, evidenceText })

    let json, usage
    try {
      ({ json, usage } = await callGemini({ apiKey, prompt, schema: RECS_RESPONSE_SCHEMA }))
    } catch (err) {
      console.error('[recommendations] Gemini call failed:', err.message)
      return { recommendations: [], warnings: [], errors: [err.message], model: GEMINI_MODEL, usage: null }
    }
    if (!json || !Array.isArray(json.items)) {
      return { recommendations: [], warnings: [], errors: ['Gemini returned no parseable recommendations'], model: GEMINI_MODEL, usage }
    }

    const rawCandidates = json.items.map(item => toRawCandidate(item, latestLabs))
    const { recommendations, warnings } = postprocessRecommendations(rawCandidates, { activeStack, knowledgeByCatalogId, corpusText: evidenceText })

    return { recommendations, warnings, errors: [], model: GEMINI_MODEL, usage }
  }

  async function saveRecommendationsCache(db, todayStr, result, refreshCount) {
    const payload = {
      date: todayStr,
      generated_at: new Date().toISOString(),
      model: result.model,
      refresh_count: refreshCount,
      recommendations: result.recommendations,
      warnings: result.warnings,
      errors: result.errors,
    }
    // Rule 6: never cache a failed generation — the next GET must retry, not
    // serve a frozen empty-with-errors doc for the rest of the day.
    if (result.errors.length === 0) {
      await db.collection('supplement_recommendations').updateOne(
        { date: todayStr },
        { $set: { date: todayStr, generated_at: payload.generated_at, model: result.model, payload, refresh_count: refreshCount } },
        { upsert: true }
      )
    }
    return payload
  }

  // GET /api/catalog/recommendations — generates once per Kyiv day, cached.
  router.get('/recommendations', async (req, res) => {
    try {
      const db = getDB()
      const todayStr = formatDateKyiv(new Date())
      const cached = await db.collection('supplement_recommendations').findOne({ date: todayStr })
      if (cached) return res.json(cached.payload)

      const result = await generateRecommendationsPayload(db)
      const payload = await saveRecommendationsCache(db, todayStr, result, 0)
      res.json(payload)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/catalog/recommendations/refresh — manual regenerate, capped
  // per Kyiv day. The FIRST generation (via the GET above, refresh_count:0)
  // does not consume this budget — only explicit refresh calls do.
  router.post('/recommendations/refresh', async (req, res) => {
    try {
      const db = getDB()
      const todayStr = formatDateKyiv(new Date())
      const existing = await db.collection('supplement_recommendations').findOne({ date: todayStr })
      const currentCount = existing?.refresh_count || 0
      if (currentCount >= RECS_REFRESH_CAP) {
        return res.status(429).json({ error: `Refresh limit reached for today (${RECS_REFRESH_CAP})` })
      }
      const result = await generateRecommendationsPayload(db)
      const payload = await saveRecommendationsCache(db, todayStr, result, currentCount + 1)
      res.json(payload)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
