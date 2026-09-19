#!/usr/bin/env node
// #1326 backfill: 64 `whoop_recovery` rows whose `cycle_id` has NO document in
// `whoop_cycles` (backfill gap, not a date-semantics bug — #1322 fixed the
// writer; this ticket fills the pre-existing hole so ALL closed cycles resolve
// under the SAME Rule B). Root-cause triage (Apex, #1326 comments 19.09):
// WHOOP's `GET /cycle/{id}` returns 200 for all 64 (no retention gap), and
// `whoop_recovery.date` for those 64 rows is ALREADY the canonical Rule-B date
// (KyivDay(start+12h)) — so ONLY `whoop_cycles` needs the 64 missing INSERTs;
// `whoop_recovery` itself is never touched by this script.
//
// Owner approval: Dmytro 2026-09-19 14:1x "затверджую" (package incl. #870 +
// #1322 + #1326), executor Lucas→Noah (14:2x). Target = 64 INSERT (matches the
// live recount below and the ticket title).
//
// Usage: node backfill-cycles-1326.js --dry-run   (default; no writes, no
//                                                   WHOOP API calls unless a
//                                                   fresh access_token exists)
//        node backfill-cycles-1326.js --apply     (real writes — requires a
//                                                   fresh, non-self-refreshed
//                                                   access_token)
//
// Token constraint (MANDATORY, do not "fix" by adding a refresh call here):
// the WHOOP refresh_token is ONE-SHOT (see sync-whoop.js `refreshToken()`
// comments). This script NEVER calls refreshToken()/getToken() — it only
// reads the current access_token from CREDS_PATH and checks its
// `token_expires_at`. If expired, it prints the live DB-only candidate count
// and exits without touching the network. Run --apply only right after the
// scheduled `sync-whoop.js` cron (23 7,13,19 * * * + 41 9, Kyiv) has rotated
// the token — that cron is the ONLY legitimate refresher.
//
// Reuses (by name, not re-derived — #1322 comment "closes the same class of
// gap #1024 fixed for buildSleepMetricFields"): kyivDayPlus12(), buildCycleDoc()
// from sync-whoop.js. Same {cycle_id} upsert key sync-whoop.js now writes with
// (#1322, `health-api@db25ca8`), so a cycle this script inserts and a later
// live sync of the SAME cycle_id converge on the identical document — no
// collision, no dup.
'use strict'
const fs = require('fs')
const https = require('https')
const { execSync } = require('child_process')
const { MongoClient } = require('mongodb')
const { kyivDayPlus12, buildCycleDoc } = require('./sync-whoop.js')

const CREDS_PATH = '/root/.config/whoop/whoop.json'
const WHOOP_API_V2 = 'https://api.prod.whoop.com/developer/v2'
const CALL_DELAY_MS = 120
const TARGET_COUNT = 64 // approved 19.09.2026 — recomputed below; mismatch is reported, not silently applied

const APPLY = process.argv.includes('--apply')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function readCreds() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))
}

// Read-only token freshness check. NEVER calls refreshToken()/getToken() —
// see file header. Returns { fresh, token, expiresAt, minsLeft }.
function checkTokenFreshness(creds, now) {
  const expiresAt = new Date(creds.token_expires_at).getTime()
  const fresh = now < expiresAt
  const minsLeft = Math.round((expiresAt - now) / 60000)
  return { fresh, token: creds.access_token, expiresAt: creds.token_expires_at, minsLeft }
}

// Same guard pattern as migrate-whoop-date-reindex-1296.js: a live sync run
// writing whoop_cycles concurrently with this script's upserts is a race we
// don't need to take, even though both key on {cycle_id} and would converge.
function assertNoSync() {
  const ps = execSync("ps -eo pid,cmd | grep '[s]ync-whoop.js' || true").toString().trim()
  if (ps) throw new Error('sync-whoop.js is running RIGHT NOW — aborting: ' + ps)
}

function whoopGetCycle(token, cycleId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WHOOP_API_V2}/cycle/${cycleId}`)
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode === 429) {
          resolve({ status: 429, body: null })
        } else if (res.statusCode >= 400) {
          resolve({ status: res.statusCode, body: data })
        } else {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
          catch (e) { resolve({ status: res.statusCode, body: data }) }
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Live recount of the candidate set — NEVER trust a stale file (lessons-learned:
// "A queue handoff is a snapshot — tasks_get first, reconcile against live
// state"). Predicate exactly as specified in the #1326 handoff: whoop_recovery
// cycle_ids with no whoop_cycles document, excluding any currently-open cycle
// (end: null) — an open cycle self-heals via the normal sync once it closes,
// it is not a backfill target.
async function findCandidates(db) {
  const recCol = db.collection('whoop_recovery')
  const cycCol = db.collection('whoop_cycles')
  const recCycleIds = (await recCol.distinct('cycle_id')).map(String)
  const existing = new Set((await cycCol.distinct('cycle_id')).map(String))
  const openIds = new Set((await cycCol.find({ end: null }).project({ cycle_id: 1 }).toArray()).map(c => String(c.cycle_id)))
  return recCycleIds.filter(id => !existing.has(id) && !openIds.has(id)).sort()
}

async function postState(db) {
  const cycCol = db.collection('whoop_cycles')
  const all = await cycCol.find({}).toArray()
  const dupGroups = new Map()
  for (const doc of all) {
    const k = String(doc.cycle_id)
    dupGroups.set(k, (dupGroups.get(k) || 0) + 1)
  }
  const dupCount = [...dupGroups.values()].filter(n => n > 1).length
  const closed = all.filter(d => d.end != null)
  const offsetHist = {}
  for (const d of closed) {
    const expected = kyivDayPlus12(d.start)
    const offset = expected === d.date ? 0 : 'mismatch'
    offsetHist[offset] = (offsetHist[offset] || 0) + 1
  }
  const candidates = await findCandidates(db)
  return { total: all.length, closed: closed.length, open: all.length - closed.length, dupGroups: dupCount, offsetHist, remainingNoCycleDoc: candidates.length }
}

async function main() {
  assertNoSync()
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()

  const candidates = await findCandidates(db)
  console.log(`Live recount: ${candidates.length} whoop_recovery cycle_id(s) with no whoop_cycles document (open cycle excluded).`)
  if (candidates.length !== TARGET_COUNT) {
    console.log(`⚠️  MISMATCH vs approved target (${TARGET_COUNT}) — new number is ${candidates.length}. Naming it here, not silently applying; re-approve if proceeding with --apply.`)
  }
  console.log('Candidate cycle_ids:', JSON.stringify(candidates))

  const now = Date.now()
  const creds = readCreds()
  const { fresh, token, expiresAt, minsLeft } = checkTokenFreshness(creds, now)

  if (!fresh) {
    console.log(`Token NOT fresh — token_expires_at=${expiresAt} (expired ${-minsLeft}min ago). This script NEVER self-refreshes (one-shot refresh_token — see sync-whoop.js). Skipping WHOOP API probe/apply. Re-run right after the next scheduled sync-whoop.js cron.`)
    await client.close()
    process.exit(0)
  }
  console.log(`Token fresh — expires_at=${expiresAt} (~${minsLeft}min left).`)

  let ok200 = 0
  const results = [] // { cycle_id, status, doc }
  for (const cycleId of candidates) {
    const resp = await whoopGetCycle(token, cycleId)
    if (resp.status === 429) {
      console.log(`429 rate-limited on cycle_id=${cycleId} — stopping (processed ${results.length}/${candidates.length}).`)
      break
    }
    if (resp.status === 200 && resp.body && resp.body.id != null) {
      ok200++
      results.push({ cycle_id: cycleId, status: 200, doc: buildCycleDoc(resp.body, new Date().toISOString()) })
    } else {
      results.push({ cycle_id: cycleId, status: resp.status, doc: null })
    }
    await sleep(CALL_DELAY_MS)
  }
  console.log(`WHOOP API probe: ${ok200}/${candidates.length} returned 200 with a cycle body.`)
  const nonOk = results.filter(r => r.status !== 200)
  if (nonOk.length) console.log('Non-200:', JSON.stringify(nonOk.map(r => ({ cycle_id: r.cycle_id, status: r.status }))))

  if (!APPLY) {
    console.log('--dry-run: no writes performed. Re-run with --apply to insert.')
    await client.close()
    return
  }

  let inserted = 0
  let e11000 = 0
  for (const r of results) {
    if (r.status !== 200 || !r.doc) continue
    try {
      const res = await db.collection('whoop_cycles').updateOne(
        { cycle_id: r.cycle_id },
        { $set: r.doc },
        { upsert: true }
      )
      if (res.upsertedCount > 0) inserted++
    } catch (e) {
      if (e.code === 11000) { e11000++; console.log(`E11000 on cycle_id=${r.cycle_id}: ${e.message}`) }
      else throw e
    }
  }
  console.log(`Apply complete: inserted=${inserted}, E11000=${e11000}.`)

  const post = await postState(db)
  console.log('Post-state:', JSON.stringify(post))
  await client.close()
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1) })
}

module.exports = { findCandidates, checkTokenFreshness, postState, whoopGetCycle }
