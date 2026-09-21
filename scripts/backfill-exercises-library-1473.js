#!/usr/bin/env node
// #1473 backfill: existing `workouts` sessions written BEFORE this ticket's fix (any
// write path other than /log-text — POST / and PUT /:id never touched the library) can
// carry exercise names with no `exercises_library` document. Apex triage (18:09, live
// Mongo measure): exercises_library=40, 5 names missing, all from 2026-09-15/lisa
// (bodyweight session, no weight_kg on any set) — «Відтискання широкий хват (груди)»,
// «Відтискання вузький хват (трицепс)», «Планка (сек)», «Mountain climbers (на ногу)»,
// «Підйом ніг лежачи». Target = 5 (40 -> 45).
//
// Owner approval: Dmytro 21.09.2026 "1473 запусти" (Phil #8465), Apex triage #8466.
//
// Usage: node backfill-exercises-library-1473.js --dry-run   (default; no writes)
//        node backfill-exercises-library-1473.js --apply     (real writes)
//
// Reuses (by name, not re-derived — #1473 root fix): ensureExercisesInLibrary() from
// lib/exercise-library-register.js — the SAME case-insensitive match+auto-create the
// live routes now use, so a name this script inserts is byte-for-byte what the routes
// would have inserted at write time. NEVER guesses muscle_group/equipment/weight_unit
// (#1318/#1408) — every backfilled doc starts all-null, same as a live auto-create.
'use strict'
const { execSync } = require('child_process')
const { MongoClient } = require('mongodb')
const { ensureExercisesInLibrary } = require('../lib/exercise-library-register')

const TARGET_COUNT = 5 // approved 21.09.2026 (Apex triage #8466) — recomputed below; mismatch is reported, not silently applied

const APPLY = process.argv.includes('--apply')

// Same guard pattern as backfill-cycles-1326.js: a live write to `workouts` or
// `exercises_library` racing this script's read-then-insert is a race we don't need to
// take, even though the operation itself (auto-create on case-insensitive miss) is the
// same one the live routes already do concurrently in normal operation.
function assertNoSync() {
  // Match ONLY actual `node ... backfill-exercises-library-1473.js` processes (comm ==
  // "node"), excluding our OWN pid (process.pid, not shell $$). A plain `grep -f` on the
  // script name also matches the invoking shell wrapper's own argv (the Bash-tool's
  // `bash -c "... backfill-exercises-library-1473.js ..."` line contains the literal
  // string too) — filtering by comm=="node" excludes that false match, not just self.
  const ps = execSync(
    `ps -eo pid,comm,args | awk -v me=${process.pid} '$2=="node" && $1!=me' | grep '[b]ackfill-exercises-library-1473.js' || true`
  ).toString().trim()
  if (ps) throw new Error('another backfill-exercises-library-1473.js is running RIGHT NOW — aborting: ' + ps)
}

// Live recount — NEVER trust the ticket's named number (lessons-learned: "A queue
// handoff is a snapshot — reconcile against live state"). Case-insensitive against the
// CURRENT exercises_library content, exactly the same comparison ensureExercisesInLibrary
// itself performs per-name.
async function findCandidates(db) {
  const libCol = db.collection('exercises_library')
  const workoutsCol = db.collection('workouts')

  const workouts = await workoutsCol.find({}, { projection: { exercises: 1 } }).toArray()
  const seenNames = new Set()
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      if (ex && ex.name) seenNames.add(ex.name)
    }
  }

  const libDocs = await libCol.find({}, { projection: { name: 1 } }).toArray()
  const libNamesLower = new Set(libDocs.map(d => String(d.name || '').toLowerCase()))

  return [...seenNames].filter(name => !libNamesLower.has(name.toLowerCase())).sort()
}

async function main() {
  assertNoSync()
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()

  const before = await db.collection('exercises_library').countDocuments()
  const candidates = await findCandidates(db)
  console.log(`Before: exercises_library has ${before} docs.`)
  console.log(`Live recount: ${candidates.length} exercise name(s) in workouts with no exercises_library match.`)
  console.log('Candidate names:', JSON.stringify(candidates))

  if (candidates.length !== TARGET_COUNT) {
    console.log(`⚠️  MISMATCH vs approved target (${TARGET_COUNT}) — new number is ${candidates.length}. Naming it here, not silently applying.`)
  }

  if (!APPLY) {
    console.log('--dry-run: no writes performed. Re-run with --apply to insert.')
    await client.close()
    return
  }

  if (candidates.length === 0) {
    // Idempotency case, not a drift case: a prior --apply already closed the gap (or
    // there never was one). Nothing to write — exit clean, not an error.
    console.log('0 candidates — nothing to insert (idempotent no-op).')
    await client.close()
    return
  }

  if (candidates.length !== TARGET_COUNT) {
    await client.close()
    throw new Error(`Refusing to --apply: measured candidate count (${candidates.length}) != approved target (${TARGET_COUNT}). Re-approve before proceeding.`)
  }

  // NOTE: candidates are deduped by exact string but not by cross-case collision within
  // the batch itself (e.g. two workout docs spelling the same exercise with different
  // casing) — ensureExercisesInLibrary resolves each name in order, so a later name that
  // case-insensitively matches an EARLIER name in this same batch is matched, not
  // inserted twice. The before/after count below is the authoritative number, not
  // candidates.length.
  const libByName = await ensureExercisesInLibrary(db.collection('exercises_library'), candidates)

  const after = await db.collection('exercises_library').countDocuments()
  console.log(`Apply complete: ${candidates.length} name(s) processed, exercises_library ${before} -> ${after}.`)
  console.log('Inserted docs:', JSON.stringify([...libByName.values()].map(d => ({ name: d.name, muscle_group: d.muscle_group, equipment: d.equipment, weight_unit: d.weight_unit }))))

  await client.close()
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1) })
}

module.exports = { findCandidates }
