const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { requireFields } = require('../lib/validate')
const { todayKyiv, toKyivDay, isValidKyivDayFormat, addDaysToKyivDay } = require('../lib/kyiv-day')
const { habitDoneToday, ruleCheckState, computeDaysClean } = require('../lib/life-rules')
const trackers = require('../lib/life-trackers')
const lifeToday = require('../lib/life-today')

// #1519 (SPEC #1518) — `/me` MVP: habits (`life_habits`), rules
// (`life_habit_rules`), rule check-ins (`life_rule_checks`), and the
// aggregate `/today` card. `goals` and `lib/targets-resolver.js` are NOT
// touched by this file (SPEC §3 — separate domain, separate collections).
//
// MAX_ACTIVE_RULES_PER_HABIT — SPEC §1/§3: "1-3 active rules per habit".
const MAX_ACTIVE_RULES_PER_HABIT = 3

function toObjectId(id) {
  if (!ObjectId.isValid(id)) return null
  return new ObjectId(id)
}

// #1524 — embeds each habit's ACTIVE rules (same grouping pattern as
// `/today`'s `rulesByHabit`, routes/life_habits.js below, but without
// day/check since this is not day-scoped). Filters by `habit_id` only (never
// by the habit's own `archived_at`), so it returns the same rule set for an
// archived habit as for a live one — HabitsPage's Archive tab needs this too
// (`/today` can't help there: it hard-filters `archived_at: null`).
async function attachActiveRules(db, habits) {
  const habitIds = habits.map((h) => h._id)
  const activeRules = habitIds.length
    ? await db
        .collection('life_habit_rules')
        .find({ habit_id: { $in: habitIds }, active: true })
        .sort({ order: 1 })
        .toArray()
    : []
  const rulesByHabit = {}
  for (const rule of activeRules) {
    const key = String(rule.habit_id)
    if (!rulesByHabit[key]) rulesByHabit[key] = []
    rulesByHabit[key].push(rule)
  }
  return habits.map((habit) => ({ ...habit, rules: rulesByHabit[String(habit._id)] || [] }))
}


// #1602 — day-by-day "done" map for ONE habit over [fromDay, toDay], used by
// stats and nudges. Tracker habits are DERIVED from their source collection
// (they own no life_rule_checks); rule-based habits from life_rule_checks.
async function loadDoneByDay(db, habit, fromDay, toDay) {
  const doneByDay = {}
  if (habit.tracker) {
    const coll = trackers.SOURCE_COLLECTION[habit.tracker.source]
    const docs = await db.collection(coll).find({ date: { $gte: fromDay, $lte: toDay } }).toArray()
    const states = trackers.trackerStatesByDay(habit.tracker, docs)
    for (const [day, st] of states) doneByDay[day] = st.met
    return { doneByDay, states }
  }
  if (habit.type === 'break') {
    const rules = await db.collection('life_habit_rules').find({ habit_id: habit._id }).toArray()
    const ids = rules.map((r) => r._id)
    const fails = ids.length
      ? await db.collection('life_rule_checks').find({ rule_id: { $in: ids }, done: false }).toArray()
      : []
    const failDays = new Set(fails.map((c) => c.day))
    for (let d = fromDay; d <= toDay; d = addDaysToKyivDay(d, 1)) doneByDay[d] = !failDays.has(d)
    return { doneByDay, failDays }
  }
  const rules = await db.collection('life_habit_rules').find({ habit_id: habit._id, active: true }).toArray()
  if (!rules.length) return { doneByDay }
  const checks = await db.collection('life_rule_checks').find({ habit_id: habit._id, day: { $gte: fromDay, $lte: toDay } }).toArray()
  const byDay = {}
  for (const c of checks) (byDay[c.day] = byDay[c.day] || {})[String(c.rule_id)] = c
  for (const [day, map] of Object.entries(byDay)) doneByDay[day] = habitDoneToday(rules, map) === true
  return { doneByDay }
}

function hhmmKyiv(date) {
  return date.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Kiev', hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5)
}

module.exports = function (getDB, sources) {
  // #1601: external sources for the /today state/food blocks (injectable for tests).
  // Under jest (NODE_ENV=test) the default never calls the live API: blocks degrade to null+reason.
  const offline = async () => { throw new Error('sources unavailable (test env)') }
  const src = sources || (process.env.NODE_ENV === 'test'
    ? { readiness: offline, whoop: offline, nutrition: offline }
    : lifeToday.makeHttpSources(`http://127.0.0.1:${process.env.HEALTH_API_TEST_PORT || 3001}`))
  const router = Router()

  // ---- habits -------------------------------------------------------

  // GET /api/life/habits?type=&active=
  // `active` (optional): 'true' (default) -> only non-archived; 'false' ->
  // only archived; 'all' -> no filter. `type` (optional): 'build'|'break'.
  // #1524: each habit carries its embedded active `rules[]`.
  router.get('/habits', async (req, res) => {
    try {
      const db = getDB()
      const filter = {}
      if (req.query.type) filter.type = req.query.type
      const activeParam = req.query.active
      if (activeParam === 'false') filter.archived_at = { $ne: null }
      else if (activeParam !== 'all') filter.archived_at = null // default
      const data = await db.collection('life_habits').find(filter).sort({ created_at: 1 }).toArray()
      res.json(await attachActiveRules(db, data))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/life/habits/:id — #1524: embedded active `rules[]`.
  router.get('/habits/:id', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const doc = await db.collection('life_habits').findOne({ _id: id })
      if (!doc) return res.status(404).json({ error: 'Not found' })
      const [withRules] = await attachActiveRules(db, [doc])
      res.json(withRules)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/life/habits — SPEC §3: build/break, identity/two_minute are
  // build-only (Q5 default: hide for break, but the API does not enforce
  // that — it just stores what the build/break-aware form sends); MVP
  // frequency is always daily regardless of what the client sends (SPEC §1
  // scope: "тільки щодня").
  //
  // #1587 P0-2: `implementation` is OPTIONAL, not required — the MCP tool
  // (mcp-servers/me/index.ts habit_create) already treats it as optional
  // (`z.string().optional()`, omitted from the body entirely when unset) and
  // the dashboard form sends `null` when the field is left blank
  // (HabitFormModal.jsx: `implementation: implementation.trim() || null`).
  // `requireFields` rejects both `undefined` AND `null` as "missing", so the
  // old `requireFields('type','name','implementation')` 400'd on EVERY habit
  // created without an implementation intention — both from the dashboard
  // and from Lisa via MCP. Mirrors `contracts/life-contracts.schema.json`
  // (`implementation` is `["string","null"]`, not just `"string"`).
  router.post('/habits', requireFields('type', 'name'), async (req, res) => {
    try {
      if (req.body.type !== 'build' && req.body.type !== 'break') {
        return res.status(400).json({ error: "type must be 'build' or 'break'" })
      }
      const db = getDB()
      // #1602: frequency (daily|weekdays|weekly_n), tracker and triggers are validated, not silently dropped.
      const freq = trackers.validateFrequency(req.body.frequency)
      if (freq.error) return res.status(400).json({ error: freq.error })
      const trk = trackers.validateTracker(req.body.tracker, { type: req.body.type })
      if (trk.error) return res.status(400).json({ error: trk.error })
      const trg = trackers.validateTriggers(req.body.triggers)
      if (trg.error) return res.status(400).json({ error: trg.error })
      if (trk.value && Array.isArray(req.body.rules) && req.body.rules.length) {
        return res.status(400).json({ error: 'tracker habits take no rules (state is derived from the source)' })
      }
      const doc = {
        type: req.body.type,
        name: req.body.name,
        sphere: req.body.sphere ?? null,
        identity: req.body.type === 'build' ? req.body.identity ?? null : null,
        implementation: req.body.implementation ?? null,
        two_minute: req.body.type === 'build' ? req.body.two_minute ?? null : null,
        frequency: freq.value,
        tracker: trk.value,
        triggers: trg.value,
        active: true,
        created_at: new Date(),
        archived_at: null,
      }
      const result = await db.collection('life_habits').insertOne(doc)
      const habitId = result.insertedId

      // #1587 P0-2: the dashboard's "create habit" form collects 1-3 rules
      // in the SAME form (HabitFormModal.jsx) and sends them as `rules: [{
      // text }]` inside this SAME POST body (HabitsPage.jsx `handleSubmit` ->
      // `api.createHabit(formState)`, see me-dashboard/src/api/lifeApi.js
      // `createHabit`) — this route used to only read
      // type/name/sphere/identity/implementation/two_minute and silently
      // drop `rules`, so every dashboard-created habit shipped with ZERO
      // rules (live-confirmed 2026-10-01: GET /habits after a dashboard
      // "Зберегти звичку" showed `rules: []`). Insert them here, same
      // text-extraction (`string` or `{text}`) and 3-rule cap as
      // `POST /habits/:habitId/rules` below.
      const rulesIn = Array.isArray(req.body.rules) ? req.body.rules.slice(0, MAX_ACTIVE_RULES_PER_HABIT) : []
      const insertedRules = []
      for (let i = 0; i < rulesIn.length; i++) {
        const text = typeof rulesIn[i] === 'string' ? rulesIn[i] : rulesIn[i]?.text
        if (!text) continue
        const ruleDoc = {
          habit_id: habitId,
          text,
          order: i + 1,
          active: true,
          created_at: new Date(),
          archived_at: null,
        }
        const ruleResult = await db.collection('life_habit_rules').insertOne(ruleDoc)
        insertedRules.push({ ...ruleDoc, _id: ruleResult.insertedId })
      }

      res.status(201).json({ ...doc, _id: habitId, rules: insertedRules })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/life/habits/:id — partial update of the editable fields.
  const HABIT_EDITABLE_FIELDS = ['type', 'name', 'sphere', 'identity', 'implementation', 'two_minute']
  router.put('/habits/:id', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      if (req.body.type !== undefined && req.body.type !== 'build' && req.body.type !== 'break') {
        return res.status(400).json({ error: "type must be 'build' or 'break'" })
      }
      const set = { updated_at: new Date() }
      for (const f of HABIT_EDITABLE_FIELDS) {
        if (req.body[f] !== undefined) set[f] = req.body[f]
      }
      if (req.body.active !== undefined) {
        if (typeof req.body.active !== 'boolean') {
          return res.status(400).json({ error: 'active must be boolean' })
        }
        set.active = req.body.active
        set.archived_at = req.body.active ? null : new Date()
      }
      // #1602: validated editable fields. `tracker: null` detaches the tracker.
      if (req.body.frequency !== undefined) {
        const v = trackers.validateFrequency(req.body.frequency)
        if (v.error) return res.status(400).json({ error: v.error })
        set.frequency = v.value
      }
      if (req.body.tracker !== undefined) {
        const existing = await db.collection('life_habits').findOne({ _id: id })
        if (!existing) return res.status(404).json({ error: 'Not found' })
        const v = trackers.validateTracker(req.body.tracker, { type: set.type || existing.type })
        if (v.error) return res.status(400).json({ error: v.error })
        set.tracker = v.value
      }
      if (req.body.triggers !== undefined) {
        const v = trackers.validateTriggers(req.body.triggers)
        if (v.error) return res.status(400).json({ error: v.error })
        set.triggers = v.value
      }
      const result = await db.collection('life_habits').findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/life/habits/:id — soft delete (archive), per contract.
  router.delete('/habits/:id', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const result = await db.collection('life_habits').findOneAndUpdate(
        { _id: id },
        { $set: { active: false, archived_at: new Date() } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ---- rules ----------------------------------------------------------

  // POST /api/life/habits/:habitId/rules — 400 if the habit already has
  // MAX_ACTIVE_RULES_PER_HABIT active rules (SPEC A3: "4-те активне правило -> 400").
  router.post('/habits/:habitId/rules', requireFields('text'), async (req, res) => {
    try {
      const habitId = toObjectId(req.params.habitId)
      if (!habitId) return res.status(404).json({ error: 'Habit not found' })
      const db = getDB()
      const habit = await db.collection('life_habits').findOne({ _id: habitId })
      if (!habit) return res.status(404).json({ error: 'Habit not found' })
      if (habit.tracker) return res.status(400).json({ error: 'tracker habits take no rules' })

      const activeCount = await db
        .collection('life_habit_rules')
        .countDocuments({ habit_id: habitId, active: true })
      if (activeCount >= MAX_ACTIVE_RULES_PER_HABIT) {
        return res.status(400).json({
          error: `Habit already has ${MAX_ACTIVE_RULES_PER_HABIT} active rules (max)`,
        })
      }

      const order = req.body.order !== undefined ? Number(req.body.order) : activeCount + 1
      const doc = {
        habit_id: habitId,
        text: req.body.text,
        order,
        active: true,
        created_at: new Date(),
        archived_at: null,
      }
      const result = await db.collection('life_habit_rules').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/life/rules/:id — {text?, active?}. Reactivating a rule
  // (active:false -> true) re-checks the 3-active limit (same class of leak
  // the POST guard exists for).
  router.put('/rules/:id', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const rule = await db.collection('life_habit_rules').findOne({ _id: id })
      if (!rule) return res.status(404).json({ error: 'Not found' })

      if (req.body.active === true && rule.active !== true) {
        const activeCount = await db
          .collection('life_habit_rules')
          .countDocuments({ habit_id: rule.habit_id, active: true })
        if (activeCount >= MAX_ACTIVE_RULES_PER_HABIT) {
          return res.status(400).json({
            error: `Habit already has ${MAX_ACTIVE_RULES_PER_HABIT} active rules (max)`,
          })
        }
      }

      const set = {}
      if (req.body.text !== undefined) set.text = req.body.text
      if (req.body.active !== undefined) set.active = !!req.body.active
      const result = await db.collection('life_habit_rules').findOneAndUpdate(
        { _id: id },
        { $set: set },
        { returnDocument: 'after' }
      )
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/life/rules/:id — soft delete (archive).
  router.delete('/rules/:id', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const result = await db.collection('life_habit_rules').findOneAndUpdate(
        { _id: id },
        { $set: { active: false, archived_at: new Date() } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/life/rules/:id/check — upsert by (rule_id, day); repeated
  // calls for the SAME day update in place, never duplicate (life_rule_checks
  // has a unique {rule_id:1,day:1} index as the DB-level backstop — see
  // server.js connectDB()).
  router.post('/rules/:id/check', requireFields('done', 'source'), async (req, res) => {
    try {
      const ruleId = toObjectId(req.params.id)
      if (!ruleId) return res.status(404).json({ error: 'Rule not found' })
      const day = req.body.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const db = getDB()
      const rule = await db.collection('life_habit_rules').findOne({ _id: ruleId })
      if (!rule) return res.status(404).json({ error: 'Rule not found' })

      const result = await db.collection('life_rule_checks').findOneAndUpdate(
        { rule_id: ruleId, day },
        {
          $set: {
            rule_id: ruleId,
            habit_id: rule.habit_id,
            day,
            done: !!req.body.done,
            two_minute_version: !!req.body.two_minute_version,
            source: req.body.source,
            // #1602: optional slip analysis (why / what triggered it) for a missed check-in.
            ...(typeof req.body.slip_reason === 'string' ? { slip_reason: req.body.slip_reason.slice(0, 500) } : {}),
            ...(typeof req.body.slip_trigger === 'string' ? { slip_trigger: req.body.slip_trigger.slice(0, 500) } : {}),
            checked_at: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after' }
      )
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/life/rules/:id/check?day= — clear a rule's check-in for a
  // day, returning it to the neutral "no check-in yet" state
  // (lib/life-rules.js::ruleCheckState treats an absent doc as
  // `{done:null, two_minute_version:null}`). `day` defaults to today (Kyiv).
  //
  // #1587 P0-1: this is the "back to empty" step of HabitRow.jsx's build
  // cycle (empty -> done -> 2-min version -> empty). Before this endpoint
  // existed, the frontend reached "empty" by POSTing
  // `{done:false, two_minute_version:false}` — which LOOKS empty in the UI
  // (no cls/symbol matches) but stores an EXPLICIT "not done" check-in, not
  // an absence of one. Every click after that first "fake empty" state fed
  // `check.done === false` back into `cycle()`, which has no branch for
  // "false -> true" on a build habit — the rule was then stuck rendering
  // empty-but-failed forever, with no way to get back to ✓. Deleting the
  // check doc (not POSTing a false one) is the only way to genuinely return
  // to the neutral state `requireFields('done','source')` on the POST route
  // can never accept (`done:null` is rejected as "missing").
  router.delete('/rules/:id/check', async (req, res) => {
    try {
      const ruleId = toObjectId(req.params.id)
      if (!ruleId) return res.status(404).json({ error: 'Rule not found' })
      const day = req.query.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const db = getDB()
      const rule = await db.collection('life_habit_rules').findOne({ _id: ruleId })
      if (!rule) return res.status(404).json({ error: 'Rule not found' })
      await db.collection('life_rule_checks').deleteOne({ rule_id: ruleId, day })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })


  // ---- #1602: stats + nudges ---------------------------------------------

  // GET /api/life/habits/:id/stats?days=30&day= — streak, best streak, % in
  // window, clean days (break), identity votes, don't-miss-twice. All DERIVED.
  router.get('/habits/:id/stats', async (req, res) => {
    try {
      const id = toObjectId(req.params.id)
      if (!id) return res.status(404).json({ error: 'Not found' })
      const db = getDB()
      const habit = await db.collection('life_habits').findOne({ _id: id })
      if (!habit) return res.status(404).json({ error: 'Not found' })
      const today = req.query.day || todayKyiv()
      if (!isValidKyivDayFormat(today)) return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      const windowDays = req.query.days === undefined ? 30 : Number(req.query.days)
      if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > trackers.MAX_STATS_DAYS) {
        return res.status(400).json({ error: `days must be an integer 1..${trackers.MAX_STATS_DAYS}` })
      }
      const createdDay = toKyivDay(habit.created_at)
      // break habits: the creation day is day 0 (SPEC table), counting starts the next day
      let startDay = habit.type === 'break' ? addDaysToKyivDay(createdDay, 1) : createdDay
      const cap = addDaysToKyivDay(today, -(trackers.MAX_STATS_DAYS - 1))
      if (startDay < cap) startDay = cap
      const frequency = habit.frequency && habit.frequency.kind ? habit.frequency : { kind: 'daily' }
      let stats
      if (startDay > today) {
        stats = trackers.computeStats({ habit: { ...habit, frequency, created_day: today }, today, doneByDay: {}, windowDays })
      } else {
        const { doneByDay, failDays } = await loadDoneByDay(db, habit, startDay, today)
        let daysClean = null
        if (habit.type === 'break') {
          const flags = []
          for (let d = startDay; d <= today; d = addDaysToKyivDay(d, 1)) flags.push(failDays.has(d))
          daysClean = computeDaysClean(flags)
        }
        stats = trackers.computeStats({ habit: { ...habit, frequency, created_day: startDay }, today, doneByDay, windowDays, daysClean })
      }
      res.json({ habit_id: String(habit._id), day: today, type: habit.type, frequency, ...stats })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/life/nudges/due?at=<ISO> — deterministic, read-only: which
  // context nudges are due at instant `at` (default now). Lisa polls this and
  // sends the reminder; POST /nudges/ack records it so it is not repeated.
  router.get('/nudges/due', async (req, res) => {
    try {
      const at = req.query.at ? new Date(req.query.at) : new Date()
      if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Invalid at (ISO datetime expected)' })
      const db = getDB()
      const day = toKyivDay(at)
      const now = { day, hhmm: hhmmKyiv(at), weekday: trackers.isoWeekday(day) }
      const habits = (await db.collection('life_habits').find({ archived_at: null }).sort({ created_at: 1 }).toArray()).filter(
        (h) => Array.isArray(h.triggers) && h.triggers.length
      )
      const ackedDocs = habits.length ? await db.collection('life_nudges').find({ day }).toArray() : []
      const acked = new Set(ackedDocs.map((a) => `${a.habit_id}|${a.key}`))
      const latestCache = {}
      const latestDate = async (metric) => {
        if (metric in latestCache) return latestCache[metric]
        const coll = metric === 'weight' ? 'weight_log' : metric === 'steps' ? 'steps_log' : 'water_log'
        const rows = await db.collection(coll).find({ date: { $lte: day } }).sort({ date: -1 }).limit(1).toArray()
        return (latestCache[metric] = rows[0] ? rows[0].date : null)
      }
      const nudges = []
      for (const habit of habits) {
        const frequency = habit.frequency && habit.frequency.kind ? habit.frequency : { kind: 'daily' }
        const wk = frequency.kind === 'weekly_n' ? trackers.weekStart(day) : day
        const { doneByDay } = await loadDoneByDay(db, habit, wk, day)
        let doneToday = !!doneByDay[day]
        let scheduledToday = frequency.kind !== 'weekdays' || frequency.days.includes(now.weekday)
        if (frequency.kind === 'weekly_n') {
          const cnt = Object.values(doneByDay).filter(Boolean).length
          doneToday = cnt >= frequency.n // week target reached — no more nudges this week
        }
        const latestDates = {}
        for (const t of habit.triggers) if (t.kind === 'stale_metric') latestDates[t.metric] = await latestDate(t.metric)
        nudges.push(...trackers.dueNudgesForHabit({ now, habit, doneToday, scheduledToday, latestDates, acked }))
      }
      res.json({ at: at.toISOString(), day: now.day, hhmm: now.hhmm, nudges })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/life/nudges/ack {habit_id, key} — mark a nudge as delivered (idempotent).
  router.post('/nudges/ack', requireFields('habit_id', 'key'), async (req, res) => {
    try {
      const habitId = toObjectId(req.body.habit_id)
      if (!habitId) return res.status(404).json({ error: 'Habit not found' })
      const db = getDB()
      const habit = await db.collection('life_habits').findOne({ _id: habitId })
      if (!habit) return res.status(404).json({ error: 'Habit not found' })
      // every nudge key ends with the Kyiv day it was due on (lib/life-trackers.js) — the ack is filed under that day
      const day = String(req.body.key).split(':').pop()
      if (!isValidKyivDayFormat(day)) return res.status(400).json({ error: 'key must end with :YYYY-MM-DD' })
      await db.collection('life_nudges').findOneAndUpdate(
        { habit_id: String(habitId), key: String(req.body.key) },
        { $set: { habit_id: String(habitId), key: String(req.body.key), day, acked_at: new Date() } },
        { upsert: true, returnDocument: 'after' }
      )
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ---- today aggregate --------------------------------------------------

  // GET /api/life/today?day= — ONE call for the "Сьогодні" screen: habits +
  // their active rules + that day's checks (per-rule state + habit-level
  // done_today/days_clean) + that day's day goals.
  //
  // Response shape (this endpoint's exact body was NOT fully spelled out by
  // SPEC §6 beyond "aggregate ... in one call" — the shape below is this
  // implementation's contribution, documented here and in the closing
  // tasks_comment so #1520/#1521 code against the SAME fields):
  //   { day, day_goals: [...], habits: [{ ...habit fields, rules: [{...rule,
  //     check:{done,two_minute_version}}], done_today, days_clean }] }
  router.get('/today', async (req, res) => {
    try {
      const day = req.query.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) {
        return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      }
      const db = getDB()

      const yesterday = addDaysToKyivDay(day, -1)
      const [habits, allActiveRules, dayGoals, carryoverGoals] = await Promise.all([
        db.collection('life_habits').find({ archived_at: null }).sort({ created_at: 1 }).toArray(),
        db.collection('life_habit_rules').find({ active: true }).sort({ order: 1 }).toArray(),
        db.collection('life_day_goals').find({ day }).toArray(),
        db.collection('life_day_goals').find({ day: yesterday, done: false }).sort({ created_at: 1 }).toArray(),
      ])

      const rulesByHabit = {}
      for (const rule of allActiveRules) {
        const key = String(rule.habit_id)
        if (!rulesByHabit[key]) rulesByHabit[key] = []
        rulesByHabit[key].push(rule)
      }

      const ruleIds = allActiveRules.map((r) => r._id)
      const todayChecks = ruleIds.length
        ? await db.collection('life_rule_checks').find({ rule_id: { $in: ruleIds }, day }).toArray()
        : []
      const checksByRuleId = {}
      for (const c of todayChecks) checksByRuleId[String(c.rule_id)] = c

      // For break habits: days-clean needs every day strictly AFTER
      // created_at up to (and including) `day`, so pull the full history in
      // one query per habit's rule set rather than N+1 per rule.
      const breakHabits = habits.filter((h) => h.type === 'break')
      // #1614 p.7: failures on ARCHIVED rules still count (else archiving a rule
      // that carried a failure inflates days_clean) -> pull ALL rules of break
      // habits, not only active ones.
      const breakHabitIds = breakHabits.map((h) => h._id)
      const allBreakRules = breakHabitIds.length
        ? await db.collection('life_habit_rules').find({ habit_id: { $in: breakHabitIds } }).toArray()
        : []
      const breakRuleIds = allBreakRules.map((r) => r._id)
      const historyChecks = breakRuleIds.length
        ? await db
            .collection('life_rule_checks')
            .find({ rule_id: { $in: breakRuleIds }, done: false })
            .toArray()
        : []
      const failureDaysByHabit = {}
      for (const c of historyChecks) {
        const rule = allBreakRules.find((r) => String(r._id) === String(c.rule_id))
        if (!rule) continue
        const key = String(rule.habit_id)
        if (!failureDaysByHabit[key]) failureDaysByHabit[key] = new Set()
        failureDaysByHabit[key].add(c.day)
      }

      // #1602: tracker habits — state DERIVED from the source collection for `day`.
      const trackerStateByHabit = {}
      await Promise.all(
        habits
          .filter((h) => h.tracker)
          .map(async (h) => {
            const { states } = await loadDoneByDay(db, h, day, day)
            trackerStateByHabit[String(h._id)] = states.get(day) || null
          })
      )

      const habitsOut = habits.map((habit) => {
        if (habit.tracker) {
          const st = trackerStateByHabit[String(habit._id)]
          return {
            ...habit,
            rules: [],
            // present-but-below-threshold today is still in progress: neutral null, never false
            done_today: st && st.met ? true : null,
            days_clean: null,
            tracker_state: { value: st ? st.value : null, threshold: habit.tracker.threshold, met: st ? st.met : null },
          }
        }
        const habitRules = rulesByHabit[String(habit._id)] || []
        const rulesOut = habitRules.map((rule) => ({
          ...rule,
          check: ruleCheckState(checksByRuleId[String(rule._id)]),
        }))
        const done_today = habitDoneToday(habitRules, checksByRuleId)

        let days_clean = null
        if (habit.type === 'break') {
          const createdDay = toKyivDay(habit.created_at)
          const failureDays = failureDaysByHabit[String(habit._id)] || new Set()
          const flags = []
          for (let d = new Date(createdDay + 'T12:00:00Z'); toKyivDay(d) <= day; d.setUTCDate(d.getUTCDate() + 1)) {
            const kd = toKyivDay(d)
            if (kd === createdDay) continue // creation day itself = 0, not counted (SPEC table)
            flags.push(failureDays.has(kd))
          }
          days_clean = computeDaysClean(flags)
        }

        return { ...habit, rules: rulesOut, done_today, days_clean }
      })

      // #1601: focus + state/calendar/food — each block independently null+reason.
      const focus = dayGoals
        .filter((g) => g.focus === true)
        .sort((a, b) => (a.focus_rank || 9) - (b.focus_rank || 9))
      const [readinessR, whoopR, nutritionR, snapshotR] = await Promise.all([
        lifeToday.settle(() => src.readiness(day)),
        lifeToday.settle(() => src.whoop(day)),
        lifeToday.settle(() => src.nutrition(day)),
        lifeToday.settle(() => db.collection('life_calendar_snapshots').findOne({ day })),
      ])
      const state = readinessR.ok
        ? lifeToday.buildStateBlock(readinessR.value, whoopR.ok ? whoopR.value : null)
        : { block: null, reason: 'readiness недоступний' }
      const food = nutritionR.ok
        ? lifeToday.buildFoodBlock(nutritionR.value, day)
        : { block: null, reason: 'підсумок їжі недоступний' }
      const calendar = snapshotR.ok
        ? lifeToday.buildCalendarBlock(snapshotR.value, { day, todayDay: todayKyiv() })
        : { block: null, reason: 'календар недоступний' }

      res.json({
        day,
        day_goals: dayGoals,
        carryover_goals: carryoverGoals,
        focus,
        habits: habitsOut,
        state: state.block,
        state_reason: state.reason,
        calendar: calendar.block,
        calendar_reason: calendar.reason,
        food: food.block,
        food_reason: food.reason,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
