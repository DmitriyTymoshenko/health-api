const https = require('https')
const fs = require('fs')
const { MongoClient } = require('mongodb')

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'Authorization': `Bearer ${token}` } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)))
    })
    req.on('error', reject); req.end()
  })
}

async function main() {
  const token = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/integrations/whoop.json')).access_token
  const client = new MongoClient('mongodb://localhost:27017')
  await client.connect()
  const db = client.db('health_tracker')

  // Fetch all recovery from API
  let allApi = [], nextToken = null
  do {
    let url = `https://api.prod.whoop.com/developer/v2/recovery?limit=25`
    if (nextToken) url += `&nextToken=${encodeURIComponent(nextToken)}`
    const data = await httpGet(url, token)
    allApi.push(...(data.records || []))
    nextToken = data.next_token || null
    await new Promise(r => setTimeout(r, 400))
  } while (nextToken)

  console.log(`Fetched ${allApi.length} records from API`)

  // Clear all recovery and re-insert with correct data from API
  await db.collection('whoop_recovery').deleteMany({})
  
  let inserted = 0
  for (const r of allApi) {
    if (r.score_state !== 'SCORED') continue
    const date = r.created_at.split('T')[0]
    await db.collection('whoop_recovery').insertOne({
      date,
      cycle_id: String(r.cycle_id),
      recovery_score: r.score.recovery_score,
      hrv_rmssd: r.score.hrv_rmssd_milli,
      resting_heart_rate: r.score.resting_heart_rate,
      spo2_percentage: r.score.spo2_percentage,
      skin_temp_celsius: r.score.skin_temp_celsius,
      score_state: r.score_state,
      user_calibrating: r.user_calibrating || false,
      synced_at: new Date().toISOString(),
    }).catch(e => console.log(`Skip ${date}: ${e.message}`))
    inserted++
  }
  
  console.log(`Inserted: ${inserted}`)
  
  // Verify last 5
  const docs = await db.collection('whoop_recovery').find({}).sort({ date: -1 }).limit(5).toArray()
  docs.forEach(d => console.log(`${d.date} recovery: ${d.recovery_score} hrv: ${d.hrv_rmssd}`))
  
  await client.close()
}
main().catch(console.error)
