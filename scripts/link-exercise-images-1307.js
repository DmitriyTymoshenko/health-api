/**
 * #1307 — link exercises_library -> exercises_catalog (catalog_id) and image_url.
 * Idempotent. image_url is written ONLY via the existing HTTP route
 * PATCH /api/workouts/exercises/:name (whitelist). catalog_id has no HTTP write path
 * (same as #1332 migration), so it is $set directly, and only for the 13 explicit
 * mappings below. Junk docs (0 sessions, 0 program refs) are deleted only with --apply.
 * Usage: MONGO_URL=... node scripts/link-exercise-images-1307.js [--apply]
 */
const { MongoClient } = require('mongodb')
const API = process.env.HEALTH_API || 'http://localhost:3001'
const APPLY = process.argv.includes('--apply')
const DB = process.env.MONGO_DB || 'health_tracker'

const NEW_MAP = {
  'Mountain climbers (на ногу)': 'Mountain_Climbers',
  'Відтискання вузький хват (трицепс)': 'Push-Ups_-_Close_Triceps_Position',
  'Планка (сек)': 'Plank',
  'Підйом ніг лежачи': 'Flat_Bench_Lying_Leg_Raise',
  'Горизонтальна тяга блока': 'Seated_Cable_Rows',
  'Тяга блока широким хватом': 'Wide-Grip_Lat_Pulldown',
  'Тяга блоку широким хватом': 'Wide-Grip_Lat_Pulldown',
  'Біцепс скота': 'Preacher_Curl',
  'Молотки на біцепс': 'Hammer_Curls',
  'Відтискання широкий хват (груди)': 'Push-Up_Wide',
  'Розводка в тренажері': 'Butterfly',
  'Розводка в тренажері на груди': 'Butterfly',
  'Тяга на верх грудних в тренажері': 'Wide-Grip_Lat_Pulldown',
  'Трицепс в блоці': 'Triceps_Pushdown',
  'Жим в тренажері під нахилом вниз': 'Leverage_Decline_Chest_Press',
  'Махи гантелей стоячи на плечі': 'Side_Lateral_Raise',
  'Розводка в блоці': 'Flat_Bench_Cable_Flyes',
}
const JUNK = ['Тест2', 'Жим лежачи QA1474', 'Планка (сек) QA1474']

;(async () => {
  const c = new MongoClient(process.env.MONGO_URL); await c.connect()
  const db = c.db(DB)
  const lib = db.collection('exercises_library'), cat = db.collection('exercises_catalog')
  for (const n of JUNK) {
    const s = await db.collection('workouts').countDocuments({ 'exercises.name': n })
    const p = await db.collection('training_programs').countDocuments({ 'days.exercises.name': n })
    console.log('JUNK', n, 'sessions', s, 'programs', p)
    if (APPLY && s === 0 && p === 0) console.log('  deleted', (await lib.deleteOne({ name: n })).deletedCount)
  }
  const docs = await lib.find({ name: { $nin: JUNK } }).toArray()
  for (const d of docs) {
    const cid = d.catalog_id || NEW_MAP[d.name]
    if (!cid) { console.log('NOPAIR', d.name); continue }
    const cd = await cat.findOne({ source_id: cid })
    if (!cd || !cd.images || !cd.images[0]) { console.log('NOIMG', d.name, cid); continue }
    console.log(d.catalog_id ? 'KEEP ' : 'MAP  ', d.name, '->', cid, cd.images[0])
    if (!APPLY) continue
    if (!d.catalog_id) await lib.updateOne({ name: d.name }, { $set: { catalog_id: cid } })
    if (d.image_url !== cd.images[0]) {
      const r = await fetch(`${API}/api/workouts/exercises/${encodeURIComponent(d.name)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_url: cd.images[0] }) })
      if (r.status !== 200) console.log('PATCH FAIL', d.name, r.status)
    }
  }
  await c.close()
})()
