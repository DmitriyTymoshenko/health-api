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
  const token = JSON.parse(fs.readFileSync('/root/.config/whoop/whoop.json')).access_token
  const client = new MongoClient('mongodb://localhost:27017')
  await client.connect()
  const db = client.db('health_tracker')

  // Get last 10 from API
  const data = await httpGet('https://api.prod.whoop.com/developer/v2/recovery?limit=10', token)
  const apiMap = {}
  for (const r of data.records) {
    const date = r.created_at.split('T')[0]
    apiMap[date] = r.score.recovery_score
  }

  // Compare with DB
  const dbDocs = await db.collection('whoop_recovery').find({ date: { $gte: '2026-03-20' } }).sort({ date: -1 }).toArray()
  
  let issues = 0
  for (const doc of dbDocs) {
    const apiVal = apiMap[doc.date]
    if (apiVal && apiVal !== doc.recovery_score) {
      console.log(`WRONG: ${doc.date} DB=${doc.recovery_score} API=${apiVal}`)
      issues++
    } else {
      console.log(`OK: ${doc.date} recovery=${doc.recovery_score}`)
    }
  }
  console.log(`\nIssues: ${issues}`)
  await client.close()
}
main().catch(console.error)
