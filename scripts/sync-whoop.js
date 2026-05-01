#!/usr/bin/env node
// sync-whoop.js — Syncs last 7 days of WHOOP data into MongoDB
// Run:  node /tmp/health-api/scripts/sync-whoop.js
// Cron: node /tmp/health-api/scripts/sync-whoop.js >> /tmp/whoop-sync.log 2>&1  (every 30 min)

const https = require('https')
const fs = require('fs')
const { MongoClient } = require('mongodb')

const CREDS_PATH = '/root/.openclaw/workspace/integrations/whoop.json'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017'
const DB_NAME = 'health_tracker'
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token'
const WHOOP_API = 'https://api.prod.whoop.com/developer/v1'
const WHOOP_API_V2 = 'https://api.prod.whoop.com/developer/v2'

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function readCreds() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))
}

function writeCreds(creds) {
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2))
}

function httpRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const options = {
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`))
        } else {
          try { resolve(JSON.parse(data)) } catch (e) { resolve(data) }
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function refreshToken(creds) {
  log('Refreshing WHOOP token...')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
  }).toString()

  const data = await httpRequest(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)

  creds.access_token = data.access_token
  creds.refresh_token = data.refresh_token || creds.refresh_token
  const expiresIn = data.expires_in || 3600
  creds.token_expires_at = new Date(Date.now() + expiresIn * 1000).toISOString()
  writeCreds(creds)
  log(`Token refreshed, expires at ${creds.token_expires_at}`)
  return creds
}

async function getToken() {
  let creds = readCreds()
  const expiresAt = new Date(creds.token_expires_at).getTime()
  if (Date.now() > expiresAt - 120000) {
    creds = await refreshToken(creds)
  }
  return creds.access_token
}

async function whoopGet(token, path, v2 = false) {
  const base = v2 ? WHOOP_API_V2 : WHOOP_API
  return httpRequest(`${base}${path}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  })
}

function dateRange(dateStr) {
  // start = DATE 00:00:00Z, end = DATE+1 00:00:00Z
  const start = `${dateStr}T00:00:00.000Z`
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const end = next.toISOString().split('.')[0] + '.000Z'
  return { start, end }
}

function toDateStr(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function syncDate(db, token, dateStr) {
  const { start, end } = dateRange(dateStr)
  const now = new Date().toISOString()

  let cycleResult = null
  let cycleId = null
  let recoveryResult = null
  let sleepResult = null
  let workoutCount = 0

  // ── Cycles ──
  try {
    const cyclesResp = await whoopGet(token,
      `/cycle?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
    const cycles = cyclesResp?.records || []
    for (const c of cycles) {
      const kcal = c.score?.kilojoule ? Math.round(c.score.kilojoule / 4.184) : null
      const doc = {
        date: dateStr,
        cycle_id: String(c.id),
        // timestamps
        start: c.start ?? null,
        end: c.end ?? null,
        timezone_offset: c.timezone_offset ?? null,
        score_state: c.score_state ?? null,
        // scores
        strain: c.score?.strain ?? null,
        kilojoule: c.score?.kilojoule ?? null,
        calories_burned: kcal,
        avg_heart_rate: c.score?.average_heart_rate ?? null,
        max_heart_rate: c.score?.max_heart_rate ?? null,
        synced_at: now,
      }
      await db.collection('whoop_cycles').updateOne(
        { date: dateStr },
        { $set: doc },
        { upsert: true }
      )
      cycleResult = doc
      cycleId = String(c.id)
    }
  } catch (e) {
    log(`  [cycles] ${dateStr} error: ${e.message}`)
  }

  // ── Recovery (v2) ──
  try {
    const recResp = await whoopGet(token,
      `/recovery?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, true)
    const recs = recResp?.records || []
    const r = recs[0]
    if (r) {
      const doc = {
        date: dateStr,
        cycle_id: String(r.cycle_id ?? cycleId),
        sleep_id: r.sleep_id ?? null,
        score_state: r.score_state ?? null,
        user_calibrating: r.score?.user_calibrating ?? null,
        // all score fields
        recovery_score: r.score?.recovery_score ?? null,
        resting_heart_rate: r.score?.resting_heart_rate ?? null,
        hrv_rmssd: r.score?.hrv_rmssd_milli ?? null,
        spo2_percentage: r.score?.spo2_percentage ?? null,
        skin_temp_celsius: r.score?.skin_temp_celsius ?? null,
        synced_at: now,
      }
      // Only overwrite score fields if we have actual score data.
      // Prevents a PENDING_SLEEP sync from nulling out previously valid recovery scores.
      const RECOVERY_SCORE_FIELDS = ['recovery_score', 'resting_heart_rate', 'hrv_rmssd', 'spo2_percentage', 'skin_temp_celsius']
      const hasRecoveryScores = RECOVERY_SCORE_FIELDS.some(f => doc[f] !== null)
      const recoverySetDoc = hasRecoveryScores
        ? { ...doc }
        : Object.fromEntries(Object.entries(doc).filter(([k]) => !RECOVERY_SCORE_FIELDS.includes(k)))
      await db.collection('whoop_recovery').updateOne(
        { date: dateStr },
        { $set: recoverySetDoc },
        { upsert: true }
      )
      recoveryResult = doc
    }
  } catch (e) {
    log(`  [recovery] ${dateStr} error: ${e.message}`)
  }

  // ── Sleep (v2) ──
  try {
    const sleepResp = await whoopGet(token,
      `/activity/sleep?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, true)
    const sleeps = (sleepResp?.records || []).filter(s => !s.nap)
    for (const s of sleeps) {
      const stages = s.score?.stage_summary ?? {}
      const totalInBedMs = stages.total_in_bed_time_milli ?? null
      const totalSleepMs = totalInBedMs != null
        ? totalInBedMs - (stages.total_awake_time_milli ?? 0) : null
      const sleepHours = totalSleepMs ? Math.round((totalSleepMs / 3600000) * 10) / 10 : null
      const sleepNeededMs = s.score?.sleep_needed
        ? (s.score.sleep_needed.baseline_milli ?? 0)
          + (s.score.sleep_needed.need_from_sleep_debt_milli ?? 0)
          + (s.score.sleep_needed.need_from_recent_strain_milli ?? 0)
        : null
      const doc = {
        date: dateStr,
        sleep_id: String(s.id),
        cycle_id: String(s.cycle_id ?? ''),
        start: s.start ?? null,
        end: s.end ?? null,
        timezone_offset: s.timezone_offset ?? null,
        score_state: s.score_state ?? null,
        nap: s.nap ?? false,
        // stage breakdown (ms)
        total_in_bed_ms: totalInBedMs,
        total_awake_ms: stages.total_awake_time_milli ?? null,
        total_light_sleep_ms: stages.total_light_sleep_time_milli ?? null,
        total_sws_ms: stages.total_slow_wave_sleep_time_milli ?? null,
        total_rem_ms: stages.total_rem_sleep_time_milli ?? null,
        sleep_cycle_count: stages.sleep_cycle_count ?? null,
        disturbance_count: stages.disturbance_count ?? null,
        // computed
        total_sleep_ms: totalSleepMs,
        sleep_hours: sleepHours,
        sleep_needed_ms: sleepNeededMs,
        sleep_needed_hours: sleepNeededMs ? Math.round((sleepNeededMs / 3600000) * 10) / 10 : null,
        // scores
        respiratory_rate: s.score?.respiratory_rate ?? null,
        sleep_performance: s.score?.sleep_performance_percentage ?? null,
        sleep_consistency: s.score?.sleep_consistency_percentage ?? null,
        sleep_efficiency: s.score?.sleep_efficiency_percentage ?? null,
        synced_at: now,
      }
      // Only overwrite score fields if we have actual score data.
      // Prevents an incomplete sleep sync from nulling out valid stage/score data.
      const SLEEP_SCORE_FIELDS = ['sleep_hours', 'sleep_needed_hours', 'sleep_needed_ms', 'total_sleep_ms',
        'total_in_bed_ms', 'total_awake_ms', 'total_light_sleep_ms', 'total_sws_ms', 'total_rem_ms',
        'disturbance_count', 'respiratory_rate', 'sleep_performance', 'sleep_consistency', 'sleep_efficiency']
      const hasSleepScores = SLEEP_SCORE_FIELDS.some(f => doc[f] !== null)
      const sleepSetDoc = hasSleepScores
        ? { ...doc }
        : Object.fromEntries(Object.entries(doc).filter(([k]) => !SLEEP_SCORE_FIELDS.includes(k)))
      await db.collection('whoop_sleep').updateOne(
        { sleep_id: String(s.id) },
        { $set: sleepSetDoc },
        { upsert: true }
      )
      sleepResult = doc
    }
  } catch (e) {
    log(`  [sleep] ${dateStr} error: ${e.message}`)
  }

  // ── Workouts (v2) ──
  try {
    const wResp = await whoopGet(token,
      `/activity/workout?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, true)
    const wkts = wResp?.records || []
    for (const w of wkts) {
      const kcal = w.score?.kilojoule ? Math.round(w.score.kilojoule / 4.184) : null
      const durationMin = w.end && w.start
        ? Math.round((new Date(w.end) - new Date(w.start)) / 60000) : null
      const zones = w.score?.zone_durations ?? {}
      const doc = {
        date: dateStr,
        workout_id: String(w.id),
        sport_id: w.sport_id ?? null,
        sport_name: w.sport_name ?? null,
        start_time: w.start ?? null,
        end_time: w.end ?? null,
        timezone_offset: w.timezone_offset ?? null,
        score_state: w.score_state ?? null,
        duration_min: durationMin,
        // scores
        strain: w.score?.strain ?? null,
        kilojoule: w.score?.kilojoule ?? null,
        calories_burned: kcal,
        avg_heart_rate: w.score?.average_heart_rate ?? null,
        max_heart_rate: w.score?.max_heart_rate ?? null,
        percent_recorded: w.score?.percent_recorded ?? null,
        distance_meter: w.score?.distance_meter ?? null,
        altitude_gain_meter: w.score?.altitude_gain_meter ?? null,
        // heart rate zones (ms)
        zone_zero_ms: zones.zone_zero_milli ?? null,
        zone_one_ms: zones.zone_one_milli ?? null,
        zone_two_ms: zones.zone_two_milli ?? null,
        zone_three_ms: zones.zone_three_milli ?? null,
        zone_four_ms: zones.zone_four_milli ?? null,
        zone_five_ms: zones.zone_five_milli ?? null,
        synced_at: now,
      }
      await db.collection('whoop_workouts').updateOne(
        { workout_id: String(w.id) },
        { $set: doc },
        { upsert: true }
      )
      workoutCount++
    }
  } catch (e) {
    log(`  [workouts] ${dateStr} error: ${e.message}`)
  }

  // ── Upsert daily_metrics (denormalized view for /api/metrics) ──
  try {
    const metricsDoc = { date: dateStr, synced_at: now }
    if (cycleResult) {
      if (cycleResult.strain !== null) metricsDoc.strain = cycleResult.strain
      if (cycleResult.calories_burned !== null) metricsDoc.calories_burned = cycleResult.calories_burned
      if (cycleResult.avg_heart_rate !== null) metricsDoc.avg_heart_rate = cycleResult.avg_heart_rate
      if (cycleResult.max_heart_rate !== null) metricsDoc.max_heart_rate = cycleResult.max_heart_rate
    }
    if (recoveryResult) {
      if (recoveryResult.recovery_score !== null) metricsDoc.recovery_score = recoveryResult.recovery_score
      if (recoveryResult.hrv_rmssd !== null) metricsDoc.hrv_rmssd = recoveryResult.hrv_rmssd
      if (recoveryResult.resting_heart_rate !== null) metricsDoc.resting_heart_rate = recoveryResult.resting_heart_rate
      if (recoveryResult.spo2_percentage !== null) metricsDoc.spo2_percentage = recoveryResult.spo2_percentage
      if (recoveryResult.skin_temp_celsius !== null) metricsDoc.skin_temp_celsius = recoveryResult.skin_temp_celsius
    }
    if (sleepResult) {
      if (sleepResult.sleep_hours !== null) metricsDoc.sleep_hours = sleepResult.sleep_hours
      if (sleepResult.sleep_performance !== null) metricsDoc.sleep_performance = sleepResult.sleep_performance
      if (sleepResult.sleep_needed_hours !== null) metricsDoc.sleep_needed_hours = sleepResult.sleep_needed_hours
      if (sleepResult.sleep_consistency !== null) metricsDoc.sleep_consistency = sleepResult.sleep_consistency
      if (sleepResult.sleep_efficiency !== null) metricsDoc.sleep_efficiency = sleepResult.sleep_efficiency
      if (sleepResult.respiratory_rate !== null) metricsDoc.respiratory_rate = sleepResult.respiratory_rate
    }
    await db.collection('daily_metrics').updateOne(
      { date: dateStr },
      { $set: metricsDoc },
      { upsert: true }
    )
  } catch (e) {
    log(`  [daily_metrics] ${dateStr} error: ${e.message}`)
  }

  log(
    `Synced WHOOP data for ${dateStr}: ` +
    `strain=${cycleResult?.strain ?? 'n/a'}, ` +
    `calories=${cycleResult?.calories_burned ?? 'n/a'}, ` +
    `recovery=${recoveryResult?.recovery_score ?? 'n/a'}%, ` +
    `sleep=${sleepResult?.sleep_hours ?? 'n/a'}h, ` +
    `workouts=${workoutCount}`
  )
}

async function main() {
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  const db = client.db(DB_NAME)
  log('Connected to MongoDB')

  // Ensure indexes
  await db.collection('whoop_cycles').createIndex({ date: 1 }, { unique: true }).catch(() => {})
  await db.collection('whoop_recovery').createIndex({ date: 1 }, { unique: true }).catch(() => {})
  await db.collection('whoop_sleep').createIndex({ sleep_id: 1 }, { unique: true, sparse: true }).catch(() => {})
  await db.collection('whoop_sleep').createIndex({ date: 1 }).catch(() => {})
  await db.collection('whoop_workouts').createIndex({ workout_id: 1 }, { unique: true }).catch(() => {})

  const token = await getToken()

  // Sync last N days (default 7, override with --days=30 arg)
  const daysArg = process.argv.find(a => a.startsWith('--days='))
  const DAYS = daysArg ? parseInt(daysArg.split('=')[1]) : 7
  const today = new Date()
  const dates = []
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    dates.push(toDateStr(d))
  }

  log(`Syncing dates: ${dates.join(', ')}`)
  for (const date of dates) {
    await syncDate(db, token, date)
    await new Promise(r => setTimeout(r, 1000)) // 1s between dates to avoid 429
  }

  // Recalculate activity stats
  try {
    const workouts = await db.collection('whoop_workouts').find({ strain: { $ne: null } }).toArray()
    const bySport = {}
    workouts.forEach(w => {
      const sport = w.sport_name || 'unknown'
      if (!bySport[sport]) bySport[sport] = []
      bySport[sport].push({ strain: w.strain, duration: w.duration_min || 0, kcal: w.calories_burned || 0 })
    })
    const stats = {}
    Object.entries(bySport).forEach(([sport, arr]) => {
      stats[sport] = {
        count: arr.length,
        avg_strain: Math.round((arr.reduce((s, w) => s + w.strain, 0) / arr.length) * 10) / 10,
        avg_duration_min: Math.round(arr.reduce((s, w) => s + w.duration, 0) / arr.length),
        avg_calories: Math.round(arr.reduce((s, w) => s + w.kcal, 0) / arr.length),
        avg_kcal_per_min: Math.round((arr.reduce((s, w) => s + w.kcal, 0) / arr.reduce((s, w) => s + (w.duration || 1), 0)) * 10) / 10,
      }
    })
    await db.collection('user_settings').updateOne(
      { key: 'default' },
      { $set: { activity_stats: stats, activity_stats_updated: new Date().toISOString() } },
      { upsert: true }
    )
    log(`Activity stats recalculated: ${Object.keys(stats).length} sports from ${workouts.length} workouts`)
  } catch (err) {
    log(`Activity stats recalc failed: ${err.message}`)
  }

  await client.close()
  log('WHOOP sync complete.')
}

main().catch(err => {
  console.error('Sync failed:', err.message)
  process.exit(1)
})
