#!/usr/bin/env node
// #873 Частина 3: 5 (approved) foods_library docs carry the wrong nutrition key
// `calories_per_100g` instead of `kcal_per_100g` — every reader (routes/foods.js,
// Nutrition.jsx's submitFood()) reads `kcal_per_100g`, so these docs render 0 kcal
// and create zero-kcal nutrition_log entries whenever picked from the library.
// grep for `calories_per_100g` across health-api's CODE is 0 hits (verified,
// #873 Apex triage) — this is a DATA problem (docs, not writers), one-time rename.
//
// Usage: node normalize-foods-key-873.js --dry-run   (default; no writes)
//        node normalize-foods-key-873.js --apply     (real writes)
//
// Safety per handoff (#873 Apex triage, ⚠️ constraint): if the live recount
// exceeds 10, STOP — do not mutate, report and ask for re-approval. Ticket text
// said "5"; live remeasure (20.09) found 4 real docs (0 have BOTH keys) — the
// mismatch is reported below, not silently applied (same discipline as
// backfill-cycles-1326.js's TARGET_COUNT guard).
'use strict'
const { MongoClient } = require('mongodb')

const TARGET_COUNT = 5 // per #873 ticket text — recomputed below; mismatch reported, not silently applied
const SAFETY_CAP = 10 // per Apex handoff ⚠️: if measured count > 10, STOP + blocked + ping apex

const APPLY = process.argv.includes('--apply')

async function findCandidates(db) {
  const col = db.collection('foods_library')
  return col.find({ calories_per_100g: { $exists: true } }).toArray()
}

async function postState(db) {
  const col = db.collection('foods_library')
  return {
    total: await col.countDocuments({}),
    remaining_calories_per_100g: await col.countDocuments({ calories_per_100g: { $exists: true } }),
    with_kcal_per_100g: await col.countDocuments({ kcal_per_100g: { $exists: true } }),
    both_keys: await col.countDocuments({ calories_per_100g: { $exists: true }, kcal_per_100g: { $exists: true } }),
  }
}

async function main() {
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()

  const candidates = await findCandidates(db)
  console.log(`Live recount: ${candidates.length} foods_library doc(s) with calories_per_100g key.`)
  if (candidates.length !== TARGET_COUNT) {
    console.log(`⚠️  MISMATCH vs ticket text (${TARGET_COUNT}) — live number is ${candidates.length}. Naming it here, not silently applying a different number.`)
  }
  if (candidates.length > SAFETY_CAP) {
    console.log(`🛑 STOP: ${candidates.length} > SAFETY_CAP(${SAFETY_CAP}) — aborting without any write. Re-approve before re-running.`)
    await client.close()
    process.exit(1)
  }
  console.log('Candidates:', JSON.stringify(candidates.map(d => ({ _id: String(d._id), name: d.name, calories_per_100g: d.calories_per_100g }))))

  const bothKeys = candidates.filter(d => d.kcal_per_100g != null)
  if (bothKeys.length > 0) {
    console.log(`⚠️  ${bothKeys.length} doc(s) already have BOTH keys — will NOT overwrite an existing kcal_per_100g, only $unset the stale calories_per_100g on those.`)
  }

  if (!APPLY) {
    console.log('--dry-run: no writes performed. Re-run with --apply to rename the key.')
    await client.close()
    return
  }

  let renamed = 0
  let unsetOnly = 0
  for (const doc of candidates) {
    if (doc.kcal_per_100g == null) {
      // No existing kcal_per_100g — move the value across, single atomic $rename.
      await db.collection('foods_library').updateOne(
        { _id: doc._id },
        { $rename: { calories_per_100g: 'kcal_per_100g' }, $set: { updated_at: new Date() } }
      )
      renamed++
    } else {
      // A kcal_per_100g already exists (shouldn't happen live — both_keys measured
      // 0 pre-mutation — but handled defensively): never overwrite it, just drop
      // the stale duplicate key.
      await db.collection('foods_library').updateOne(
        { _id: doc._id },
        { $unset: { calories_per_100g: '' }, $set: { updated_at: new Date() } }
      )
      unsetOnly++
    }
  }
  console.log(`Apply complete: renamed=${renamed}, unset-only=${unsetOnly}.`)

  const post = await postState(db)
  console.log('Post-state:', JSON.stringify(post))
  await client.close()
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1) })
}

module.exports = { findCandidates, postState }
