const { Router } = require('express')
const { validateBody } = require('../lib/life-contracts')
const { todayKyiv, toKyivDay, isValidKyivDayFormat, addDaysToKyivDay } = require('../lib/kyiv-day')
const trackers = require('../lib/life-trackers')
const { habitDoneToday } = require('../lib/life-rules')

function ratingValue(value) {
  if (value === undefined) return { present: false, value: null }
  if (value === null) return { present: true, value: null }
  if (!Number.isInteger(value) || value < 1 || value > 5) return { error: 'rating axes must be integer 1..5 or null' }
  return { present: true, value }
}

function isRuleOpen(habit, rule) {
  const check = rule.check || {}
  if (habit.type === 'break') return check.done === false
  return check.done !== true && check.two_minute_version !== true
}

function goalOut(goal) {
  return { _id: String(goal._id), text: goal.text, day: goal.day, done: !!goal.done }
}

function ruleOut(habit, rule) {
  return {
    habit_id: String(habit._id),
    habit_name: habit.name,
    habit_type: habit.type,
    rule_id: String(rule._id),
    rule_text: rule.text,
    status: habit.type === 'break' && rule.check?.done === false ? 'slipped' : 'unchecked',
  }
}

module.exports = function (getDB) {
  const router = Router()
  let ratingTail = Promise.resolve()
  router.use(async (req, res, next) => {
    if (req.method !== 'PUT' || req.path !== '/day-rating') return next()
    const previous = ratingTail
    let release
    ratingTail = new Promise((resolve) => { release = resolve })
    await previous
    if (res.destroyed) { release(); return }
    res.once('finish', release); res.once('close', release)
    next()
  })

  // PUT /api/life/day-rating — partial upsert. Missing axes stay null; never coerced to 0.
  router.put('/day-rating', validateBody('DayRatingRequest'), async (req, res) => {
    try {
      const day = req.body.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      const set = { day, source: req.body.source === 'dashboard' ? 'dashboard' : 'lisa', rated_at: new Date() }
      for (const axis of ['energy', 'focus', 'mood']) {
        const v = ratingValue(req.body[axis])
        if (v.error) return res.status(400).json({ error: v.error })
        if (v.present) set[axis] = v.value
      }
      for (const key of ['went_well', 'got_in_way', 'change_tomorrow']) {
        if (req.body[key] !== undefined) {
          if (req.body[key] !== null && (typeof req.body[key] !== 'string' || req.body[key].length > 2000)) return res.status(400).json({ error: 'Reflection fields must be text up to 2000 characters or null' })
          set[key] = req.body[key]
        }
      }
      const defaults = { energy: null, focus: null, mood: null, went_well: null, got_in_way: null, change_tomorrow: null }
      for (const key of Object.keys(set)) delete defaults[key]
      const db = getDB()
      const doc = await db.collection('life_day_ratings').findOneAndUpdate(
        { day },
        { $set: set, $setOnInsert: defaults },
        { upsert: true, returnDocument: 'after' }
      )
      res.json(doc)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/day-rating', async (req, res) => {
    try {
      const day = req.query.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      const doc = await getDB().collection('life_day_ratings').findOne({ day })
      res.json(doc || { day, energy: null, focus: null, mood: null, went_well: null, got_in_way: null, change_tomorrow: null, source: null, rated_at: null })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/life/evening?day= — Lisa's single read. Empty arrays mean "skip the message".
  router.get('/evening', async (req, res) => {
    try {
      const day = req.query.day || todayKyiv()
      if (!isValidKyivDayFormat(day)) return res.status(400).json({ error: 'Invalid day format. Use YYYY-MM-DD' })
      const db = getDB()
      const [habits, rules, checks, dayGoals, rating] = await Promise.all([
        db.collection('life_habits').find({ archived_at: null }).sort({ created_at: 1 }).toArray(),
        db.collection('life_habit_rules').find({ active: true }).sort({ order: 1 }).toArray(),
        db.collection('life_rule_checks').find({ day }).toArray(),
        db.collection('life_day_goals').find({ day }).toArray(),
        db.collection('life_day_ratings').findOne({ day }),
      ])
      const checksByRule = Object.fromEntries(checks.map((c) => [String(c.rule_id), c]))
      const rulesByHabit = {}
      for (const r of rules) (rulesByHabit[String(r.habit_id)] = rulesByHabit[String(r.habit_id)] || []).push(r)
      const habitsOut = habits.map((h) => ({
        ...h,
        rules: (rulesByHabit[String(h._id)] || []).map((r) => ({
          ...r,
          check: checksByRule[String(r._id)]
            ? { done: checksByRule[String(r._id)].done, two_minute_version: checksByRule[String(r._id)].two_minute_version }
            : { done: null, two_minute_version: null },
        })),
      }))
      const eligibleHabits = []
      for (const h of habitsOut) {
        const f = h.frequency || { kind: 'daily' }
        if (f.kind === 'weekdays' && !f.days.includes(trackers.isoWeekday(day))) continue
        if (f.kind === 'weekly_n') {
          const weekChecks = await db.collection('life_rule_checks').find({ habit_id: h._id, day: { $gte: trackers.weekStart(day), $lte: day } }).toArray()
          const days = [...new Set(weekChecks.map((c) => c.day))]
          const count = days.filter((d) => h.rules.length && h.rules.every((r) => weekChecks.some((c) => c.day === d && String(c.rule_id) === String(r._id) && (c.done === true && c.two_minute_version !== true)))).length
          if (count >= f.n) continue
        }
        eligibleHabits.push(h)
      }
      const openRules = eligibleHabits.flatMap((h) => h.rules.filter((r) => isRuleOpen(h, r)).map((r) => ruleOut(h, r)))
      const openGoals = dayGoals.filter((g) => !g.done).map(goalOut)
      const risks = await dontMissTwiceRisks(db, habits, day)
      res.json({ day, open_rules: openRules, open_goals: openGoals, dont_miss_twice: risks, rating_present: !!rating })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}

async function dontMissTwiceRisks(db, habits, day) {
  const out = []
  const yesterday = addDaysToKyivDay(day, -1)
  for (const habit of habits) {
    if (habit.tracker || habit.type !== 'build') continue
    const frequency = habit.frequency && habit.frequency.kind ? habit.frequency : { kind: 'daily' }
    const scheduledToday = frequency.kind !== 'weekdays' || frequency.days.includes(trackers.isoWeekday(day))
    if (!scheduledToday) continue
    const createdDay = habit.created_at ? toKyivDay(habit.created_at) : day
    const rules = await db.collection('life_habit_rules').find({ habit_id: habit._id, active: true }).toArray()
    if (!rules.length) continue
    const checks = await db.collection('life_rule_checks').find({ habit_id: habit._id, day: { $gte: createdDay, $lte: day } }).toArray()
    const byDay = {}
    for (const c of checks) (byDay[c.day] = byDay[c.day] || {})[String(c.rule_id)] = c
    const doneByDay = {}
    for (let d = createdDay; d <= day; d = addDaysToKyivDay(d, 1)) {
      const map = byDay[d] || {}
      doneByDay[d] = habitDoneToday(rules, map)
    }
    const evald = trackers.evaluatePeriods(frequency, createdDay, day, doneByDay)
    if (trackers.dontMissTwice(evald.past, evald.current) === 'at_risk') {
      out.push({ habit_id: String(habit._id), habit_name: habit.name, previous_day: yesterday, reason: 'missed previous scheduled period; today is still open' })
    }
  }
  return out
}
