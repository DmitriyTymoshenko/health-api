const { MongoClient } = require('mongodb')
async function main() {
  const client = new MongoClient('mongodb://localhost:27017')
  await client.connect()
  const db = client.db('health_tracker')
  
  // Restore 31.03 record (98% from WHOOP API data we fetched earlier)
  const r = await db.collection('whoop_recovery').insertOne({
    date: '2026-03-31',
    cycle_id: '1399069015',
    recovery_score: 98,
    hrv_rmssd: 71.01713,
    resting_heart_rate: 53,
    spo2_percentage: 94.7,
    skin_temp_celsius: 34.0,
    score_state: 'SCORED',
    user_calibrating: false,
    synced_at: new Date().toISOString(),
  })
  console.log('Restored 31.03:', r.insertedId)
  
  // Verify both
  const docs = await db.collection('whoop_recovery').find({ date: { $in: ['2026-03-31','2026-04-01'] } }).toArray()
  docs.forEach(d => console.log(d.date, 'recovery:', d.recovery_score))
  
  await client.close()
}
main()
