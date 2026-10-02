#!/usr/bin/env node
// #1692 п.3: fix muscle_group on exercises_library. Dry-run default; --apply writes. Needs MONGO_URL.
const { MongoClient } = require('mongodb')
const FIX = {
  'Тяга на верх грудних в тренажері': 'back',
  'Mountain climbers (на ногу)': 'core',
  'Відтискання вузький хват (трицепс)': 'triceps',
  'Планка (сек)': 'core',
  'Підйом ніг лежачи': 'core',
}
;(async () => {
  const apply = process.argv.includes('--apply')
  const c = new MongoClient(process.env.MONGO_URL); await c.connect()
  const col = c.db().collection('exercises_library')
  let changed = 0
  for (const [name, mg] of Object.entries(FIX)) {
    const doc = await col.findOne({ name })
    if (!doc) { console.log('MISSING', name); continue }
    if (doc.muscle_group === mg) { console.log('ok', name); continue }
    console.log(apply ? 'SET' : 'WOULD SET', name, doc.muscle_group, '->', mg)
    if (apply) await col.updateOne({ _id: doc._id }, { $set: { muscle_group: mg, updated_at: new Date() } })
    changed++
  }
  console.log({ apply, changed }); await c.close()
})()
