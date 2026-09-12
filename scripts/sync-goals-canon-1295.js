#!/usr/bin/env node
// #1295 mutation: fix the `goals` collection's 2 stale seed docs (created
// 2026-03-28, never updated) that were still winning outright over the new
// unified targets resolver in GET /api/goals/streaks:
//   - type: 'weight'   target_value 96 / deadline 2026-10-31
//     -> SYNC to personal_profile canon (90 / 2026-10-15). Trends.jsx reads
//        this doc's target_value/deadline directly for the weight-chart goal
//        line, so it is UPDATED (not nulled) to keep that feature working.
//   - type: 'calories' target_value 1947 (Daily Calories -500 kcal)
//     -> set target_value: null, converting it to the SAME "auto" convention
//        `type: 'protein'` already uses (that doc's target_value was already
//        null, which is exactly why /api/goals/streaks.protein_min already
//        read the live resolver value with no fix needed). null is
//        permanent — it can never drift again the way a second hardcoded
//        snapshot would, because goals.js's fallback (`?? / ||`) always
//        re-reads lib/targets-resolver.js's current kcal.
// `type: 'water'` (target_value 2500) is left untouched — 2500 IS the
// resolver's own static fallback (personal_profile.water_goal_ml), not a
// disagreeing number; #1295 explicitly treats 2500 as "the fallback, not a
// second value" (task description).
//
// Usage: node scripts/sync-goals-canon-1295.js --dry-run   (default; no writes)
//        node scripts/sync-goals-canon-1295.js --apply     (real writes)
'use strict'
const { MongoClient } = require('mongodb')

const APPLY = process.argv.includes('--apply')

async function main() {
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()
  const goalsCol = db.collection('goals')
  const profileCol = db.collection('personal_profile')

  const report = { mode: APPLY ? 'APPLY' : 'DRY-RUN', started_at: new Date().toISOString() }

  const profile = await profileCol.findOne({ _type: 'profile' })
  const canonWeightGoalKg = profile?.weight_goal_kg
  const canonWeightGoalDate = profile?.weight_goal_date
  if (!Number.isFinite(canonWeightGoalKg) || !canonWeightGoalDate) {
    throw new Error(
      `personal_profile is missing weight_goal_kg/weight_goal_date (got ${canonWeightGoalKg}/${canonWeightGoalDate}) — aborting, nothing to sync FROM`
    )
  }

  const weightDoc = await goalsCol.findOne({ type: 'weight' })
  const caloriesDoc = await goalsCol.findOne({ type: 'calories' })

  report.weight = weightDoc
    ? {
        before: { target_value: weightDoc.target_value, deadline: weightDoc.deadline },
        after: { target_value: canonWeightGoalKg, deadline: canonWeightGoalDate },
        changed: weightDoc.target_value !== canonWeightGoalKg || weightDoc.deadline !== canonWeightGoalDate,
      }
    : { before: null, note: 'no type=weight doc found — nothing to sync' }

  report.calories = caloriesDoc
    ? {
        before: { target_value: caloriesDoc.target_value },
        after: { target_value: null },
        changed: caloriesDoc.target_value !== null,
      }
    : { before: null, note: 'no type=calories doc found — nothing to sync' }

  if (APPLY) {
    if (weightDoc && report.weight.changed) {
      await goalsCol.updateOne(
        { _id: weightDoc._id },
        { $set: { target_value: canonWeightGoalKg, deadline: canonWeightGoalDate, updated_at: new Date() } }
      )
    }
    if (caloriesDoc && report.calories.changed) {
      await goalsCol.updateOne({ _id: caloriesDoc._id }, { $set: { target_value: null, updated_at: new Date() } })
    }
    // Verify in the SAME run.
    report.verify = {
      weight: await goalsCol.findOne({ type: 'weight' }, { projection: { target_value: 1, deadline: 1, _id: 0 } }),
      calories: await goalsCol.findOne({ type: 'calories' }, { projection: { target_value: 1, _id: 0 } }),
    }
  }

  console.log(JSON.stringify(report, null, 2))
  await client.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
