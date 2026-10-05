#!/usr/bin/env node
/**
 * #1718 (#1614-H) — e2e smoke for the /me "life" surface against the REAL health-api
 * routers + REAL MongoDB, on a THROWAWAY test database (never `health_tracker`).
 *
 * Scenario: create habit → check rule → change type → archive/restore → day-goal
 * create/move. Every response body is validated against the shared #1530 contract
 * (contracts/life-contracts.schema.json, additionalProperties:false).
 *
 * Usage:  bash scripts/e2e-life-smoke-1718.sh   (spins a disposable mongo:7 container on an
 * ephemeral 127.0.0.1 port, runs this script with E2E_MONGO_URL, removes the container).
 * Prod mongo (:27017 / credentials) is refused outright. Prod user has no rights on other DBs,
 * hence the throwaway container instead of a second DB on the prod server.
 * Does NOT start server.js (no cron/Telegram/seed side effects) — it mounts the same
 * route modules server.js mounts at /api/life, on an ephemeral 127.0.0.1 port.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const assert = require('assert')
const express = require('express')
const { MongoClient } = require('mongodb')
const Ajv = require('ajv')

const PROD_DB = 'health_tracker'
const dbName = `health_e2e_${Date.now()}_${process.pid}`
if (dbName === PROD_DB) throw new Error('refusing to run on prod DB')
const MONGO_URL = process.env.E2E_MONGO_URL
if (!MONGO_URL) { console.error('E2E_MONGO_URL required (use scripts/e2e-life-smoke-1718.sh)'); process.exit(2) }
if (/:27017(\/|$|\?)/.test(MONGO_URL) || /@/.test(MONGO_URL)) { console.error('refusing: E2E_MONGO_URL looks like the prod mongo (:27017 / credentials)'); process.exit(2) }

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts/life-contracts.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: false })
ajv.addSchema(schema, 'lc')
function contract(def, data, label) {
  const v = ajv.getSchema(`lc#/definitions/${def}`)
  if (!v) throw new Error(`unknown definition ${def}`)
  if (!v(data)) throw new Error(`CONTRACT ${def} violated at ${label}: ${JSON.stringify(v.errors)}\n${JSON.stringify(data).slice(0, 600)}`)
}

let step = 0
function ok(msg) { console.log(`  ✓ ${String(++step).padStart(2)} ${msg}`) }

async function main() {
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  const db = client.db(dbName)
  await db.collection('life_rule_checks').createIndex({ rule_id: 1, day: 1 }, { unique: true })
  await db.collection('life_nudges').createIndex({ habit_id: 1, key: 1 }, { unique: true })
  const app = express()
  app.use(express.json())
  app.use('/api/life', require('../routes/life_habits')(() => db))
  app.use('/api/life', require('../routes/life_day_goals')(() => db))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/life`
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request(base + p, { method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let buf = ''
      res.on('data', c => (buf += c))
      res.on('end', () => { try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
  const { todayKyiv, addDaysToKyivDay } = require('../lib/kyiv-day')
  const DAY = todayKyiv() // habit created_at = now, so stats/streak must be asked for today
  const DAY2 = addDaysToKyivDay(DAY, 1)
  console.log(`e2e #1718 on test DB ${dbName}`)
  try {
    // 1. create habit (with a rule, no implementation → regression guard for #1587 P0-2)
    let r = await call('POST', '/habits', { type: 'build', name: 'E2E ранкова розтяжка', identity: 'Я людина, що рухається', rules: [{ text: '5 хв розтяжки' }] })
    assert.strictEqual(r.status, 201, JSON.stringify(r.body))
    const habitId = r.body._id
    const ruleId = r.body.rules[0]._id
    assert.strictEqual(r.body.rules.length, 1)
    ok('POST /habits → 201 з правилом, без implementation')

    r = await call('GET', '/habits')
    assert.strictEqual(r.status, 200)
    contract('HabitsListResponse', r.body, 'GET /habits')
    assert.ok(JSON.stringify(r.body).includes(habitId))
    ok('GET /habits відповідає контракту HabitsListResponse і містить звичку')

    // 2. check rule
    r = await call('POST', `/rules/${ruleId}/check`, { done: true, source: 'e2e', day: DAY })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    assert.strictEqual(r.body.done, true)
    ok('POST /rules/:id/check done=true → 200')
    r = await call('GET', `/today?day=${DAY}`)
    assert.strictEqual(r.status, 200)
    contract('TodayResponse', r.body, 'GET /today after check')
    ok('GET /today після відмітки відповідає TodayResponse')
    r = await call('GET', `/habits/${habitId}/stats?day=${DAY}`)
    assert.strictEqual(r.status, 200)
    contract('HabitStatsResponse', r.body, 'stats')
    assert.ok(r.body.streak >= 1, 'streak must be >=1 after a done check')
    ok(`stats відповідає контракту, streak=${r.body.streak}`)
    r = await call('DELETE', `/rules/${ruleId}/check?day=${DAY}`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(await db.collection('life_rule_checks').countDocuments({}), 0)
    ok('DELETE /rules/:id/check повертає у нейтральний стан (0 check-доків)')

    // 3. change type build → break
    r = await call('PUT', `/habits/${habitId}`, { type: 'break' })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.type, 'break')
    r = await call('PUT', `/habits/${habitId}`, { type: 'nonsense' })
    assert.strictEqual(r.status, 400)
    ok('PUT type build→break = 200; невалідний type = 400')
    r = await call('GET', `/habits/${habitId}`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.type, 'break')
    ok('GET /habits/:id підтверджує type=break')

    // 4. archive / restore
    r = await call('DELETE', `/habits/${habitId}`)
    assert.strictEqual(r.status, 200)
    let doc = await db.collection('life_habits').findOne({ name: 'E2E ранкова розтяжка' })
    assert.strictEqual(doc.active, false)
    assert.ok(doc.archived_at)
    ok('DELETE /habits/:id → soft-archive (active=false, archived_at)')
    r = await call('PUT', `/habits/${habitId}`, { active: true })
    assert.strictEqual(r.status, 200)
    doc = await db.collection('life_habits').findOne({ name: 'E2E ранкова розтяжка' })
    assert.strictEqual(doc.active, true)
    assert.strictEqual(doc.archived_at, null)
    ok('PUT active=true → відновлено (archived_at=null)')

    // 5. day goals create / move
    r = await call('POST', '/day-goals', { day: DAY, text: 'E2E ціль дня' })
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
    const goalId = r.body._id
    contract('DayGoal', r.body, 'POST /day-goals')
    ok('POST /day-goals відповідає DayGoal')
    r = await call('POST', `/day-goals/${goalId}/move`, { to_day: DAY2 })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.day, DAY2)
    r = await call('GET', `/day-goals?day=${DAY2}`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.length, 1)
    r = await call('GET', `/day-goals?day=${DAY}`)
    assert.strictEqual(r.body.length, 0)
    ok('move day→day+1: ціль на новому дні, старий день порожній')
    r = await call('PUT', `/day-goals/${goalId}`, { done: true })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.done, true)
    ok('PUT day-goal done=true')
    r = await call('GET', `/today?day=${DAY2}`)
    contract('TodayResponse', r.body, 'GET /today day2')
    ok('GET /today (день з ціллю) відповідає TodayResponse')
    console.log(`PASS: ${step} assertions`)
  } finally {
    await new Promise(r => server.close(r))
    await db.dropDatabase()
    const names = (await client.db().admin().listDatabases()).databases.map(d => d.name)
    assert.ok(!names.includes(dbName), 'test DB must be dropped')
    console.log(`cleanup: test DB ${dbName} dropped; prod DB untouched`)
    await client.close()
  }
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
