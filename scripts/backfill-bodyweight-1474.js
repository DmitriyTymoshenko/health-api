#!/usr/bin/env node
// #1474 backfill: existing `workouts` sessions written BEFORE this ticket's fix left
// bodyweight sets (reps only — planks, push-ups, mountain climbers, leg raises — no
// weight_kg/weight_input on any set) at weight_kg:null forever, invisible to
// GET /volume-by-muscle (#1410) and /exercise-trends (#1417).
//
// Live remeasure (21.09.2026, this session): 2 workout docs / 20 sets match
// `weight_kg IS NULL AND weight_input IS NULL` — 2026-08-23 (5 sets) and 2026-09-15
// (15 sets). Both dates resolve to a real weight_log entry (weight_log earliest
// 2026-03-27, well before both) — 2026-08-23 -> 2026-08-20/95.8kg,
// 2026-09-15 -> 2026-09-11/94.4kg. No "today" bodyweight-only session exists yet.
//
// Owner approval: Dmytro 21.09.2026 ~19:05 "Ок" (via Phil, on Phil's proposal) — the
// approved package for #1474 explicitly names this backfill as acceptance criterion 3/4
// (Apex triage comment #8481 on #1474), same shape as #1473's "1473 запусти" covering
// code fix + backfill together in one approval.
//
// Usage: node backfill-bodyweight-1474.js --dry-run   (default; no writes)
//        node backfill-bodyweight-1474.js --apply     (real writes)
//
// Reuses (by name, not re-derived): fillBodyweightSets()/resolveBodyweightForDate() from
// lib/bodyweight-fill.js — the SAME logic the live routes (POST /, PUT /:id, log-text)
// now run at write time, so a set this script fills is byte-for-byte what a live write
// would have produced. Never guesses a bodyweight value (#1474 acceptance: no weight_log
// entry -> stays null, no hardcode) and never overwrites an explicit weight_kg/weight_input
// (fillBodyweightSets' own precondition).
'use strict'
const { execSync } = require('child_process')
const { MongoClient } = require('mongodb')
const { fillBodyweightSets, resolveBodyweightForDate } = require('../lib/bodyweight-fill')

const TARGET_DOC_COUNT = 2 // approved 21.09.2026 (Apex triage #8481) — recomputed below; mismatch is reported, not silently applied
const TARGET_SET_COUNT = 20

const APPLY = process.argv.includes('--apply')

// Same guard pattern as backfill-exercises-library-1473.js (#1473 lesson, personas/lucas.md
// #1473 entry): match ONLY real `node ... backfill-bodyweight-1474.js` processes
// (comm=="node"), excluding our OWN pid — a plain `grep -f` on the script name also
// matches the invoking shell wrapper's own argv.
function assertNoSync() {
  const ps = execSync(
    `ps -eo pid,comm,args | awk -v me=${process.pid} '$2=="node" && $1!=me' | grep '[b]ackfill-bodyweight-1474.js' || true`
  ).toString().trim()
  if (ps) throw new Error('another backfill-bodyweight-1474.js is running RIGHT NOW — aborting: ' + ps)
}

// Live recount — never trust a number written earlier in a comment/ticket (lessons-learned:
// "A queue handoff is a snapshot — reconcile against live state"). Candidate = a set with
// NEITHER weight_kg NOR weight_input set — the exact precondition fillBodyweightSets()
// itself checks, so this script's candidate set is definitionally identical to what the
// live routes would have filled had this fix existed at write time.
async function findCandidates(db) {
  const workoutsCol = db.collection('workouts')
  const workouts = await workoutsCol.find({}).toArray()

  const candidateDocs = []
  let setCount = 0
  for (const w of workouts) {
    const hasCandidate = (w.exercises || []).some(ex =>
      (ex.sets || []).some(s => s.weight_kg == null && s.weight_input == null)
    )
    if (!hasCandidate) continue
    const docSetCount = (w.exercises || []).reduce(
      (sum, ex) => sum + (ex.sets || []).filter(s => s.weight_kg == null && s.weight_input == null).length,
      0
    )
    setCount += docSetCount
    candidateDocs.push({ _id: w._id, date: w.date, source: w.source, setCount: docSetCount })
  }
  return { candidateDocs, setCount }
}

async function main() {
  assertNoSync()
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()

  const { candidateDocs, setCount } = await findCandidates(db)
  console.log(`Live recount: ${candidateDocs.length} workout doc(s) / ${setCount} set(s) match weight_kg==null && weight_input==null.`)
  console.log('Candidate docs:', JSON.stringify(candidateDocs.map(d => ({ date: d.date, source: d.source, setCount: d.setCount }))))

  if (candidateDocs.length !== TARGET_DOC_COUNT || setCount !== TARGET_SET_COUNT) {
    console.log(`⚠️  MISMATCH vs approved target (${TARGET_DOC_COUNT} docs / ${TARGET_SET_COUNT} sets) — new numbers are ${candidateDocs.length} docs / ${setCount} sets. Naming it here, not silently applying.`)
  }

  if (!APPLY) {
    console.log('--dry-run: no writes performed. Re-run with --apply to update.')
    // Show what EACH candidate doc would resolve to, without writing.
    for (const d of candidateDocs) {
      const bodyweightKg = await resolveBodyweightForDate(db.collection('weight_log'), d.date)
      console.log(`  would resolve ${d.date} (${d.setCount} set(s)) -> weight_kg=${bodyweightKg}`)
    }
    await client.close()
    return
  }

  if (candidateDocs.length === 0) {
    console.log('0 candidates — nothing to update (idempotent no-op).')
    await client.close()
    return
  }

  if (candidateDocs.length !== TARGET_DOC_COUNT || setCount !== TARGET_SET_COUNT) {
    await client.close()
    throw new Error(
      `Refusing to --apply: measured (${candidateDocs.length} docs / ${setCount} sets) != approved target (${TARGET_DOC_COUNT} docs / ${TARGET_SET_COUNT} sets). Re-approve before proceeding.`
    )
  }

  const workoutsCol = db.collection('workouts')
  const weightCol = db.collection('weight_log')
  let updatedDocs = 0
  let filledSets = 0
  const resolutions = []

  for (const d of candidateDocs) {
    const doc = await workoutsCol.findOne({ _id: d._id })
    if (!doc) continue // vanished between measure and write — do not fabricate
    const bodyweightKg = await resolveBodyweightForDate(weightCol, doc.date)
    const { exercises, filledCount } = fillBodyweightSets(doc.exercises, bodyweightKg)
    if (filledCount === 0) continue
    await workoutsCol.updateOne({ _id: d._id }, { $set: { exercises, updated_at: new Date() } })
    updatedDocs += 1
    filledSets += filledCount
    resolutions.push({ date: doc.date, source: doc.source, filledCount, bodyweightKg })
  }

  const { setCount: afterSetCount } = await findCandidates(db)
  console.log(`Apply complete: ${updatedDocs} doc(s) updated, ${filledSets} set(s) filled.`)
  console.log('Resolutions:', JSON.stringify(resolutions))
  console.log(`Post-state: ${afterSetCount} set(s) still match weight_kg==null && weight_input==null (expected 0).`)
  if (afterSetCount !== 0) {
    console.log('⚠️  Non-zero remainder — a candidate resolved to null (no weight_log entry that early). Reported, not hidden.')
  }

  await client.close()
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1) })
}

module.exports = { findCandidates }
