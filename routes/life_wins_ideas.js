const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { validateBody } = require('../lib/life-contracts')
const { todayKyiv, toKyivDay, addDaysToKyivDay, isValidKyivDayFormat } = require('../lib/kyiv-day')
const trackers = require('../lib/life-trackers')
const { loadDoneByDay } = require('./life_habits')

// #1605 (/me v2 stage 5, SPEC §11.7–§11.8): wins journal (`life_wins`) and personal
// "ideas from sources" (`life_ideas`).
//  * Wins: manual / Lisa (`POST /wins`) + AUTO entries materialised idempotently from
//    closed plans (`life_plans.status=done`) and habit-streak milestones. An auto win is
//    keyed by `auto_key` so a re-read never duplicates it.
//  * Ideas: owner rule «без видумок» — an idea is stored ONLY with a verbatim quote +
//    source title + source date + source URL + knowledge_ref; otherwise 400. Accepting an
//    idea creates a real habit or goal in /me; status moves only new → accepted|dismissed.

const STREAK_MILESTONES = [7, 14, 30, 60, 100, 200, 365]
const MIN_QUOTE_CHARS = 20
const idOf = v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) ? new ObjectId(v) : null
const validDay = day => isValidKyivDayFormat(day) && addDaysToKyivDay(day, 0) === day
const fail = (res, error, status = 400) => res.status(status).json({ error })
const KIND_LABEL = { goal: 'Ціль', project: 'Проєкт', skill: 'Навичку' }

module.exports = function (getDB) {
  const router = Router()
  let tail = Promise.resolve()
  router.use(async (req, res, next) => {
    if (!['POST', 'PUT'].includes(req.method)) return next()
    const prior = tail; let release; tail = new Promise(r => { release = r }); await prior
    if (res.destroyed) { release(); return } res.once('finish', release); res.once('close', release); next()
  })
  const safe = fn => async (req, res) => { try { await fn(req, res, getDB()) } catch (e) { res.status(500).json({ error: e.message }) } }

  async function insertAuto(db, doc) {
    if (await db.collection('life_wins').findOne({ auto_key: doc.auto_key })) return
    try { await db.collection('life_wins').insertOne({ goal_id: null, habit_id: null, ...doc, source: 'auto', created_at: new Date() }) }
    catch (e) { if (e && e.code !== 11000) throw e } // unique auto_key: a concurrent sync won the race
  }

  // Idempotent: closed plans + the highest reached streak milestone per active habit.
  let syncing = null
  function syncAutoWins(db) {
    if (!syncing) syncing = doSync(db).finally(() => { syncing = null })
    return syncing
  }
  async function doSync(db) {
    const today = todayKyiv()
    const plans = await db.collection('life_plans').find({ status: 'done' }).toArray()
    for (const p of plans) {
      if (!p.completed_at) continue
      await insertAuto(db, { auto_key: `plan:${p._id}`, day: toKyivDay(p.completed_at), goal_id: p._id,
        text: `${KIND_LABEL[p.kind] || 'План'} закрито: ${p.title}` })
    }
    const habits = await db.collection('life_habits').find({ active: true }).toArray()
    for (const h of habits) {
      const created = toKyivDay(h.created_at)
      let start = h.type === 'break' ? addDaysToKyivDay(created, 1) : created
      const cap = addDaysToKyivDay(today, -(trackers.MAX_STATS_DAYS - 1))
      if (start < cap) start = cap
      if (start > today) continue
      const frequency = h.frequency && h.frequency.kind ? h.frequency : { kind: 'daily' }
      const { doneByDay } = await loadDoneByDay(db, h, start, today)
      const daysClean = h.type === 'break' ? trackers.confirmedCleanDays(frequency, start, today, doneByDay) : null
      const stats = trackers.computeStats({ habit: { ...h, frequency, created_day: start }, today, doneByDay, windowDays: 30, daysClean })
      const run = h.type === 'break' ? (stats.clean_days || 0) : stats.streak
      const reached = STREAK_MILESTONES.filter(m => run >= m).pop()
      if (!reached) continue
      const unit = h.type === 'break' ? 'днів без зриву' : (frequency.kind === 'weekly_n' ? 'тижнів поспіль' : 'днів поспіль')
      await insertAuto(db, { auto_key: `streak:${h._id}:${reached}`, day: today, habit_id: h._id,
        text: `Серія ${reached} ${unit}: ${h.name}` })
    }
  }

  router.get('/wins', safe(async (req, res, db) => {
    const today = todayKyiv()
    const to = req.query.to || today, from = req.query.from || addDaysToKyivDay(to, -6)
    if (!validDay(from) || !validDay(to) || from > to) return fail(res, 'Некоректний період')
    await syncAutoWins(db)
    const wins = (await db.collection('life_wins').find({ day: { $gte: from, $lte: to } }).toArray())
      .sort((a, b) => b.day.localeCompare(a.day) || new Date(b.created_at) - new Date(a.created_at))
    const by_source = { manual: 0, lisa: 0, auto: 0 }
    for (const w of wins) by_source[w.source] = (by_source[w.source] || 0) + 1
    res.json({ from, to, wins, summary: { total: wins.length, by_source, days_with_wins: new Set(wins.map(w => w.day)).size } })
  }))

  router.post('/wins', validateBody('WinCreateRequest'), safe(async (req, res, db) => {
    const text = req.body.text.trim()
    if (!text) return fail(res, 'Запис порожній')
    const day = req.body.day || todayKyiv()
    if (!validDay(day) || day > todayKyiv()) return fail(res, 'Некоректна дата перемоги')
    const goalId = req.body.goal_id ? idOf(req.body.goal_id) : null, habitId = req.body.habit_id ? idOf(req.body.habit_id) : null
    if (req.body.goal_id && !(goalId && await db.collection('life_plans').findOne({ _id: goalId }))) return fail(res, 'Ціль не знайдено')
    if (req.body.habit_id && !(habitId && await db.collection('life_habits').findOne({ _id: habitId }))) return fail(res, 'Звичку не знайдено')
    const source = req.body.source || 'manual'
    const dup = await db.collection('life_wins').findOne({ day, text, source })
    if (dup) return res.status(200).json(dup)
    const doc = { day, text, goal_id: goalId, habit_id: habitId, source, auto_key: null, created_at: new Date() }
    const r = await db.collection('life_wins').insertOne(doc)
    res.status(201).json({ ...doc, _id: r.insertedId })
  }))

  // ---- ideas ------------------------------------------------------------
  router.get('/ideas', safe(async (req, res, db) => {
    const filter = {}
    if (req.query.status !== undefined) {
      if (!['new', 'accepted', 'dismissed'].includes(req.query.status)) return fail(res, 'Некоректний статус')
      filter.status = req.query.status
    }
    const ideas = (await db.collection('life_ideas').find(filter).toArray()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100)
    res.json({ ideas })
  }))

  router.post('/ideas', validateBody('IdeaCreateRequest'), safe(async (req, res, db) => {
    const b = req.body, trim = k => b[k].trim()
    if (!validDay(b.source_date) || b.source_date > todayKyiv()) return fail(res, 'Некоректна дата джерела')
    if (trim('quote').length < MIN_QUOTE_CHARS) return fail(res, `Цитата має бути дослівною і містити щонайменше ${MIN_QUOTE_CHARS} символів`)
    for (const k of ['knowledge_ref', 'source_title', 'proposal']) if (!trim(k)) return fail(res, `Поле ${k} порожнє`)
    const dup = await db.collection('life_ideas').findOne({ knowledge_ref: trim('knowledge_ref') })
    if (dup) return res.status(200).json(dup) // one idea per knowledge unit; a dismissed one is never resurrected
    const doc = { knowledge_ref: trim('knowledge_ref'), source_title: trim('source_title'), source_date: b.source_date, source_url: trim('source_url'),
      quote: trim('quote'), proposal: trim('proposal'), area: b.area, status: 'new', accepted_as: null, decided_at: null, created_at: new Date() }
    const r = await db.collection('life_ideas').insertOne(doc)
    res.status(201).json({ ...doc, _id: r.insertedId })
  }))

  router.put('/ideas/:id', validateBody('IdeaUpdateRequest'), safe(async (req, res, db) => {
    const id = idOf(req.params.id), idea = id && await db.collection('life_ideas').findOne({ _id: id })
    if (!idea) return fail(res, 'Ідею не знайдено', 404)
    if (idea.status !== 'new') return fail(res, 'Ідею вже опрацьовано')
    const { status, accept_as, name, outcome } = req.body
    const now = new Date()
    let accepted_as = null
    if (status === 'accepted') {
      if (!accept_as) return fail(res, 'Оберіть, чим стає ідея: звичкою (habit) чи ціллю (goal)')
      const title = (name || idea.proposal).trim().slice(0, 160)
      if (!title) return fail(res, 'Назва порожня')
      const why = `Ідея з джерела: ${idea.source_title} (${idea.source_date})`
      if (accept_as === 'goal') {
        const doc = { title, kind: 'goal', outcome: (outcome || idea.proposal).trim().slice(0, 1000), why, next_action: '', practice: '', evidence: '',
          target_date: null, priority: 2, status: 'active', parent_id: null, source_idea_id: idea._id, completed_at: null, created_at: now }
        const r = await db.collection('life_plans').insertOne(doc)
        accepted_as = { kind: 'goal', id: String(r.insertedId) }
      } else {
        const freq = trackers.validateFrequency(undefined), trg = trackers.validateTriggers(undefined)
        const doc = { type: 'build', name: title, sphere: null, identity: null, design: null, purpose: idea.proposal.slice(0, 1000), implementation: null,
          two_minute: null, frequency: freq.value, tracker: null, triggers: trg.value, active: true, source_idea_id: idea._id, created_at: now, archived_at: null }
        const r = await db.collection('life_habits').insertOne(doc)
        await db.collection('life_habit_rules').insertOne({ habit_id: r.insertedId, text: title, order: 1, active: true, created_at: now, archived_at: null })
        accepted_as = { kind: 'habit', id: String(r.insertedId) }
      }
    } else if (accept_as) return fail(res, 'accept_as доречне лише для status=accepted')
    res.json(await db.collection('life_ideas').findOneAndUpdate({ _id: id }, { $set: { status, accepted_as, decided_at: now } }, { returnDocument: 'after' }))
  }))
  return router
}
