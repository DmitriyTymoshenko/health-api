#!/usr/bin/env node
// #1297 mutation: `weight_log` has 2 dates with duplicate entries (measured
// live by Apex 09.09 and re-measured 12.09 16:09 — unchanged both times):
//   - 2026-03-28 x3: [102.5, 102, 102]
//   - 2026-07-05 x2: [101, 100.4]
// `GET /api/weight/analysis:51` does `findOne({date: today})` on this
// collection — with duplicates present, Mongo returns an ARBITRARY match, so
// the analysis silently used whichever of the 3/2 values happened to sort
// first, not necessarily the correct one.
//
// Owner-approved rule (Apex triage 12.09 14:45 + 16:10, default per "Запускай
// всі чотири" 09.09 — no separate schema apprv requested): on each duplicated
// date, KEEP the document with the LARGEST `_id` (= the LATEST insert = the
// user's own correction for that day), MOVE every other document on that date
// to `weight_log_dupes_1297` (archive — never delete), THEN create a unique
// index on `date` so this class of duplicate cannot recur silently.
//
// APPROVED TARGET (hard-gated below, per lesson #1296 "gate measured counts
// against approved numbers before the first write"): exactly 3 documents
// moved, `weight_log` 37 -> 34, re-running the duplicate predicate afterward
// returns 0 groups.
//
// Usage: node scripts/dedupe-weight-log-1297.js --dry-run   (default; no writes)
//        node scripts/dedupe-weight-log-1297.js --apply     (real writes + index)
'use strict'
const { MongoClient } = require('mongodb')

const APPLY = process.argv.includes('--apply')
const APPROVED_TOTAL_BEFORE = 37
const APPROVED_TOTAL_AFTER = 34
const APPROVED_MOVED_COUNT = 3

async function main() {
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()
  const weightCol = db.collection('weight_log')
  const dupesCol = db.collection('weight_log_dupes_1297')

  const report = { mode: APPLY ? 'APPLY' : 'DRY-RUN', started_at: new Date().toISOString() }

  const totalBefore = await weightCol.countDocuments()
  report.total_before = totalBefore

  // The literal predicate from the handoff — one group per duplicated date.
  const groups = await weightCol
    .aggregate([
      { $group: { _id: '$date', n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray()

  report.duplicate_groups = groups.map((g) => ({ date: g._id, count: g.n }))

  // Per group: keep the doc with the LARGEST _id (ObjectId sorts chronologically
  // by creation time — "largest" == "most recently inserted"), move the rest.
  const toMove = []
  for (const g of groups) {
    const docs = await weightCol.find({ _id: { $in: g.ids } }).toArray()
    docs.sort((a, b) => (a._id.toString() < b._id.toString() ? 1 : -1)) // largest _id first
    const [keep, ...losers] = docs
    report[`group_${g._id}`] = {
      keep: { _id: keep._id.toString(), weight_kg: keep.weight_kg },
      move: losers.map((d) => ({ _id: d._id.toString(), weight_kg: d.weight_kg })),
    }
    toMove.push(...losers)
  }

  report.planned_move_count = toMove.length

  // Hard gate — do not write anything if live measurement disagrees with the
  // owner-approved numbers (lesson #1296: a stale comment claiming a count is
  // not proof; assert it as code before the first write).
  if (totalBefore !== APPROVED_TOTAL_BEFORE || toMove.length !== APPROVED_MOVED_COUNT) {
    report.gate = 'FAILED — live counts disagree with the approved numbers, aborting before any write'
    report.approved = { total_before: APPROVED_TOTAL_BEFORE, moved_count: APPROVED_MOVED_COUNT }
    report.measured = { total_before: totalBefore, moved_count: toMove.length }
    console.log(JSON.stringify(report, null, 2))
    await client.close()
    process.exit(APPLY ? 1 : 0) // dry-run still reports diff without failing the exit code
    return
  }
  report.gate = 'PASSED — measured counts match the approved numbers'

  if (APPLY) {
    if (toMove.length > 0) {
      await dupesCol.insertMany(
        toMove.map((d) => ({ ...d, _moved_from: 'weight_log', _moved_at: new Date(), _moved_reason: '#1297 dedup' }))
      )
      await weightCol.deleteMany({ _id: { $in: toMove.map((d) => d._id) } })
    }

    // Unique index — created AFTER the dedup so it never fails on the
    // existing duplicates.
    await weightCol.createIndex({ date: 1 }, { unique: true, name: 'date_unique_1297' })

    // Verify in the SAME run.
    const totalAfter = await weightCol.countDocuments()
    const remainingDupeGroups = await weightCol
      .aggregate([
        { $group: { _id: '$date', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray()
    const indexes = await weightCol.indexes()
    const uniqueDateIndex = indexes.find((i) => i.name === 'date_unique_1297')

    report.verify = {
      total_after: totalAfter,
      expected_total_after: APPROVED_TOTAL_AFTER,
      total_after_matches_approved: totalAfter === APPROVED_TOTAL_AFTER,
      remaining_duplicate_groups: remainingDupeGroups,
      dupes_archived_count: await dupesCol.countDocuments({ _moved_reason: '#1297 dedup' }),
      unique_index_present: !!uniqueDateIndex && !!uniqueDateIndex.unique,
    }
  }

  console.log(JSON.stringify(report, null, 2))
  await client.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
