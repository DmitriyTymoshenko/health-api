#!/usr/bin/env node
// #1692 п.1: recompute sets tagged weight_source:'bodyweight' with the corrected rules
// (time/cardio -> weight_kg null, push-ups 0.64xBW). Does NOT delete anything; only rewrites
// weight_kg on tagged sets. Default dry-run; --apply to write. Needs MONGO_URL.
'use strict'
const { MongoClient } = require('mongodb')
const { bodyweightKind, resolveBodyweightForDate } = require('../lib/bodyweight-fill')
const APPLY = process.argv.includes('--apply')
;(async () => {
  const client = new MongoClient(process.env.MONGO_URL); await client.connect()
  const db = client.db(); const col = db.collection('workouts')
  let docs = 0, sets = 0, beforeVol = 0, afterVol = 0
  for (const w of await col.find({}).toArray()) {
    const bw = await resolveBodyweightForDate(db.collection('weight_log'), w.date)
    let changed = false
    const exercises = (w.exercises || []).map(ex => {
      const k = bodyweightKind(ex.name)
      return { ...ex, sets: (ex.sets || []).map(s => {
        if (s.weight_source !== 'bodyweight') return s
        const nw = k === 'time' ? null : (bw != null ? Math.round(bw * k * 10) / 10 : null)
        beforeVol += (s.weight_kg || 0) * (s.reps || 0); afterVol += (nw || 0) * (s.reps || 0)
        if (nw === s.weight_kg) return s
        changed = true; sets++
        return { ...s, weight_kg: nw }
      }) }
    })
    if (!changed) continue
    docs++
    console.log(`${w.date}: would update`)
    if (APPLY) await col.updateOne({ _id: w._id }, { $set: { exercises, updated_at: new Date() } })
  }
  console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${docs} docs / ${sets} sets; bodyweight-tagged tonnage ${Math.round(beforeVol)} -> ${Math.round(afterVol)} kg`)
  await client.close()
})().catch(e => { console.error(e); process.exit(1) })
