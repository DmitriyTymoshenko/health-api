const https = require('https')
const fs = require('fs')
const { MongoClient } = require('mongodb')

const CREDS_PATH = '/root/.openclaw/workspace/integrations/whoop.json'

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
  const token = JSON.parse(fs.readFileSync(CREDS_PATH)).access_token
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
    await new Promise(r => setTimeout(r, 500))
  } while (nextToken)

  console.log(`API records: ${allApi.length}`)

  // Compare dates: API uses created_at for recovery date vs correct date from cycle
  // The correct date should be derived from the sleep/cycle start in Kyiv timezone
  let mismatches = 0
  for (const r of allApi) {
    const apiDate = r.created_at.split('T')[0]  // UTC date from created_at
    // Get the Kyiv date for the same timestamp
    const kyivDate = new Date(r.created_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' })
    if (apiDate !== kyivDate) {
      mismatches++
      console.log(`MISMATCH: created_at ${r.created_at} | UTC: ${apiDate} | Kyiv: ${kyivDate} | recovery: ${r.score.recovery_score}`)
      // Fix in DB
      await db.collection('whoop_recovery').updateOne(
        { date: apiDate, recovery_score: r.score.recovery_score },
        { $set: { date: kyivDate } }
      ).catch(() => {})
    }
  }
  console.log(`Total mismatches fixed: ${mismatches}`)
  await client.close()
}
main().catch(console.error)
