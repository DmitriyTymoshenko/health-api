#!/usr/bin/env node
// sync-whoop.js — Syncs last 7 days of WHOOP data into MongoDB
// Run:  node health-api/scripts/sync-whoop.js
// Cron: */30 * * * * . /root/.config/chuttyevo/mongo.env && node /root/chuttyevo-agent/health-api/scripts/sync-whoop.js >> /var/log/whoop-sync.log 2>&1
//
// ── Token-rotation strategy (3rd-time fix, 2026-08-03) ─────────────────────────
// WHOOP refresh tokens are SINGLE-USE (Ory Hydra): the token we send dies the
// moment WHOOP answers, and a new rotated refresh_token comes back in the
// response. A 502 from WHOOP is catastrophic in this model — WHOOP may have
// rotated server-side and lost the response, leaving our stored token already
// spent. The 31.07 fix (scope=offline + blind 3× retry on 5xx) could NOT help:
// retrying the SAME (already-spent) token yields HTTP 400 → ReauthRequiredError
// → ~60 identical failures until a human re-authorizes interactively. This
// version prevents that class of failure with four mechanisms:
//   1. Pre-refresh only when <15min to expiry AND not refreshed in the last hour
//      (was a 2-min threshold). This does NOT reduce the NUMBER of rotations:
//      the WHOOP access_token TTL is exactly 1h and the cron runs */30, so the
//      count is 24/day under both the old and the new logic (measured on the
//      live log + simulated). What it buys is predictability — no needless
//      early rotations, and the refresh lands in a known window instead of at
//      an arbitrary 2-min edge.
//   2. On 5xx / network error: ONE retry after a 60s pause (the Ory reuse
//      window may still return the cached rotation). If it 5xx's again, do NOT
//      burn more attempts — throw TransientRefreshError. The caller then tries
//      to finish the sync on the still-valid access_token; note that with the
//      current TTL(1h) == MIN_REFRESH_INTERVAL_MS(1h) that `!expired` branch is
//      a RESERVE for a future cron-cadence change and is unreachable in prod
//      today — a double 502 ends the run at exit 0 with no data and the next
//      cron run retries fresh (freshness-check 12h is the safety net).
//   3. On 4xx: try `refresh_token_prev` (stashed on every clean rotation) once
//      — Ory has a short reuse window where a recently-rotated token may still
//      return the cached response. Success → log "recovered via prev token".
//   4. A definitive re-auth crisis (current+prev both rejected) raises a
//      greppable WHOOP_REAUTH_REQUIRED and sends ONE dedup'd Telegram alert per
//      24h (was ~48 identical failures/incident). WHOOP is also in
//      scripts/data-freshness-check.ts (12h threshold) as a safety net.
// Net effect of the fix: the blind retry of an already-spent token is gone, a
// prev-token fallback recovers the Ory reuse window, a re-auth crisis alerts
// once per 24h instead of ~48 times, and WHOOP data is under freshness
// monitoring (12h) for the first time.
// The token functions are exported with injectable deps so each branch is
// unit-tested against a mocked HTTP layer (see src/tests/whoop-token.test.ts).

const https = require('https')
const fs = require('fs')
const { MongoClient } = require('mongodb')

const CREDS_PATH = '/root/.config/whoop/whoop.json'
const ENV_PATH = '/root/chuttyevo-agent/.env' // cron only sources mongo.env; read Telegram creds here
const REAUTH_DEDUP_PATH = '/root/.config/whoop/reauth-alert.json'
const DB_NAME = 'health_tracker'
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token'
const WHOOP_API = 'https://api.prod.whoop.com/developer/v1'
const WHOOP_API_V2 = 'https://api.prod.whoop.com/developer/v2'

// Tunables (env-overridable — never bare literals in I/O paths, lesson 2026-07-30)
const REFRESH_THRESHOLD_MS = Math.max(60_000, Number(process.env.WHOOP_REFRESH_THRESHOLD_MS) || 15 * 60 * 1000) // pre-refresh window
const MIN_REFRESH_INTERVAL_MS = Math.max(0, Number(process.env.WHOOP_MIN_REFRESH_INTERVAL_MS) || 60 * 60 * 1000) // anti-churn guard
// #904/C2: was 60s — a guaranteed miss of Ory's reuse window (rotation already settled by then).
// 5s gives the retry a chance to land inside the window for a pure-gateway 502 (token still alive).
// Env-overridable; the value is a hypothesis (no live rotation while token is dead), proof = unit tests.
const RETRY_5XX_PAUSE_MS = Math.max(0, Number(process.env.WHOOP_RETRY_5XX_PAUSE_MS) || 5 * 1000) // single 5xx retry pause
const REAUTH_DEDUP_HOURS = 24

// ── Transport: User-Agent + __cf_bm cookie jar (#904/C3) ─────────────────────
// Cloudflare fronts api.prod.whoop.com. The pre-fix client sent Node's default UA
// and never persisted the __cf_bm cookie Cloudflare sets to mark a "good client"
// session — so every request looked like a fresh bot from a datacenter IP, which is
// part of why the token endpoint returns CF 502/challenge. Default UA + a process-
// lifetime cookie jar make us look like one continuous client across the run.
const DEFAULT_UA = 'chuttyevo-health/1.0 (+https://srv1532186.hstgr.cloud)'
const _cookieJar = new Map() // host -> { __cf_bm }; process-lifetime (fresh each cron run)

function resetCookieJar() { _cookieJar.clear() }

// Pure: pull __cf_bm out of a set-cookie header (string or array) and store per host.
// Exported so the transport contract is unit-tested with no network.
function captureSetCookie(host, setCookieHeader) {
  if (!host || !setCookieHeader) return
  const lines = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]
  let jar = _cookieJar.get(host) || {}
  let changed = false
  for (const line of lines) {
    const m = /__cf_bm=([^;]+)/i.exec(String(line))
    if (m) { jar.__cf_bm = m[1]; changed = true }
  }
  if (changed) _cookieJar.set(host, jar)
}

// Pure: build the Cookie header for a host from the jar (null if none captured).
function cookieHeaderFor(host) {
  const c = _cookieJar.get(host)
  return c && c.__cf_bm ? `__cf_bm=${c.__cf_bm}` : null
}

// Pure: merge default UA + stored cookie with the caller's headers (caller wins, so a
// caller may override UA if ever needed). Exported for unit testing.
function buildRequestHeaders(opts, host) {
  const cookie = cookieHeaderFor(host)
  return Object.assign(
    { 'User-Agent': DEFAULT_UA },
    cookie ? { Cookie: cookie } : {},
    opts.headers || {}
  )
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function readCreds() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))
}

function writeCreds(creds) {
  // self-heal: ensure the stable creds dir exists before writing (guards against
  // the recurring workspace-vanish class of bug — see docs/handoffs/whoop-sync-fix)
  fs.mkdirSync(require('path').dirname(CREDS_PATH), { recursive: true })
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2))
}

function httpRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const host = u.hostname
    const options = {
      hostname: host,
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      headers: buildRequestHeaders(opts, host), // #904/C3: default UA + __cf_bm cookie
    }
    const req = https.request(options, (res) => {
      // Capture __cf_bm BEFORE the status check — even a 502 response sets it, and the
      // single retry then resends it, which is the "warm client" signal Cloudflare wants.
      captureSetCookie(host, res.headers['set-cookie'])
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

// Read a value from the dotenv file (cron env doesn't include Telegram creds).
function readEnvVar(key) {
  if (process.env[key]) return process.env[key]
  try {
    const txt = fs.readFileSync(ENV_PATH, 'utf8')
    const m = new RegExp(`^\\s*${key}=(.+)$`, 'm').exec(txt)
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : null
  } catch {
    return null
  }
}

async function sendTelegram(text) {
  const bot = readEnvVar('TELEGRAM_BOT_NOTIFY')
  const chat = readEnvVar('OWNER_TELEGRAM_ID')
  if (!bot || !chat) {
    log('WHOOP alert: TELEGRAM_BOT_NOTIFY / OWNER_TELEGRAM_ID unavailable — alert skipped')
    return false
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: chat, text }),
    })
    if (!res.ok) {
      log(`WHOOP alert: Telegram HTTP ${res.status} ${await res.text()}`)
      return false
    }
    return true
  } catch (e) {
    log(`WHOOP alert: Telegram error ${e.message}`)
    return false
  }
}

// ── Token errors ─────────────────────────────────────────────────────────────
const REAUTH_MARKER = 'WHOOP_REAUTH_REQUIRED'

class ReauthRequiredError extends Error {
  constructor(detail) {
    super(`${REAUTH_MARKER}: refresh_token rejected by WHOOP (${detail}). ` +
      `Interactive re-auth needed: node ${__filename.replace('sync-whoop.js', 'whoop-reauth.js')}`)
    this.name = 'ReauthRequiredError'
  }
}

// Transient (5xx/network after the single retry): NOT fatal. The caller finishes
// the sync on the still-valid access_token when possible and retries next cron.
class TransientRefreshError extends Error {
  constructor(detail) {
    super(`WHOOP_REFRESH_TRANSIENT: ${detail}`)
    this.name = 'TransientRefreshError'
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Dedup'd re-auth alert. Fires at most once per REAUTH_DEDUP_HOURS so an incident
// produces ONE Telegram message, not ~48 (lesson 2026-07-31: 66 silent failures).
// Writes {last_alerted_at} to REAUTH_DEDUP_PATH. Returns true if it actually sent.
// `deps` (all optional, default to real fs/fetch): now, readFile, writeFile,
// sendTelegram — injected so the dedup logic is unit-tested with no fs/network.
async function alertReauthIfDue(detail, deps) {
  const d = Object.assign({
    now: Date.now,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    sendTelegram,
  }, deps || {})
  let lastAlert = 0
  try {
    const f = JSON.parse(d.readFile(REAUTH_DEDUP_PATH))
    lastAlert = new Date(f.last_alerted_at).getTime() || 0
  } catch {
    /* no prior alert — fire */
  }
  const sinceHours = (d.now() - lastAlert) / 3_600_000
  if (sinceHours < REAUTH_DEDUP_HOURS) {
    log(`${REAUTH_MARKER}: ${detail} (alert suppressed — last ${sinceHours.toFixed(1)}h ago, dedup ${REAUTH_DEDUP_HOURS}h)`)
    return false
  }
  const ts = new Date(d.now()).toISOString()
  log(`${REAUTH_MARKER}: ${detail} — alerting owner (first in 24h)`)
  const sent = await d.sendTelegram(
    `🚨 WHOOP sync requires re-authorization\n` +
    `Server ${ts}\n` +
    `Reason: ${detail}\n` +
    `Action: interactive re-auth needed (owner/Lisa).\n` +
    `(dedup — next reminder in 24h)`
  )
  try {
    d.writeFile(REAUTH_DEDUP_PATH, JSON.stringify({ last_alerted_at: ts }, null, 2))
  } catch (e) {
    log(`WHOOP alert: could not persist dedup file (${e.message})`)
  }
  return sent
}

// Apply a successful token response: update access/refresh tokens, stash the
// just-used refresh_token as `refresh_token_prev` (fallback), set expiry +
// refreshed-at timestamps, persist FIRST (lesson: persist the rotated token
// before anything else can throw).
function applyRotation(creds, resp, sentRefreshToken, deps) {
  const write = (deps && deps.writeCreds) || writeCreds
  const now = (deps && deps.now) || Date.now
  creds.access_token = resp.access_token
  if (resp.refresh_token) {
    // Stash the token that just worked as the fallback for a future 4xx. It is
    // already consumed by this rotation, but Ory's reuse window may still honour
    // it briefly — best-effort recovery, not a guarantee.
    creds.refresh_token_prev = sentRefreshToken
    creds.refresh_token = resp.refresh_token
  }
  const expiresIn = resp.expires_in || 3600
  creds.token_expires_at = new Date(now() + expiresIn * 1000).toISOString()
  creds.token_refreshed_at = new Date(now()).toISOString()
  write(creds)
  return creds
}

function buildRefreshBody(refreshToken, creds) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    scope: 'offline',
  }).toString()
}

function postRefresh(body, deps) {
  const httpReq = (deps && deps.httpRequest) || httpRequest
  return httpReq(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)
}

// ── Core: refresh with single-5xx-retry + prev-token fallback + dedup alert ──
// Exported for unit testing. `deps` injects httpRequest/readCreds/writeCreds/log/
// sleep/alertReauthIfDue/now so tests are deterministic with no network or fs.
async function refreshToken(credsIn, deps) {
  const d = Object.assign({ httpRequest, readCreds, writeCreds, log, sleep, alertReauthIfDue, now: Date.now }, deps || {})
  const creds = { ...credsIn }
  const sentToken = creds.refresh_token

  // At most two attempts on the SAME refresh_token: the first, and one retry
  // after a 60s pause if it was a 5xx / network error (Ory may still return the
  // cached rotation within its reuse window). A 4xx never retries the same token.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = buildRefreshBody(creds.refresh_token, creds)
    let resp
    try {
      resp = await postRefresh(body, d)
    } catch (err) {
      const status = Number((/^HTTP (\d+)/.exec(err.message) || [])[1])
      const transient = Number.isNaN(status) || status >= 500
      if (transient) {
        if (attempt === 1) {
          d.log(`Refresh attempt 1 transient (${err.message.slice(0, 80)}) — pausing ${Math.round(RETRY_5XX_PAUSE_MS / 1000)}s for one retry`)
          await d.sleep(RETRY_5XX_PAUSE_MS)
          continue // attempt 2, SAME refresh_token
        }
        throw new TransientRefreshError(`persistent ${err.message.slice(0, 80)} after retry`)
      }
      // 4xx: token rejected — fall through to prev-token fallback (no retry of the same token)
      return await recoverViaPrev(creds, sentToken, `HTTP ${status}`, d)
    }
    // success
    applyRotation(creds, resp, sentToken, d)
    d.log(`Token refreshed, expires at ${creds.token_expires_at}`)
    return creds
  }
  // Unreachable: the loop returns or throws on both paths above.
  throw new TransientRefreshError('exhausted retry loop unexpectedly')
}

// 4xx handler: the current refresh_token was rejected (likely already spent by a
// lost 502). Try `refresh_token_prev` once — Ory's reuse window may still return
// the cached rotation. If prev also fails (or there is no prev), this is a
// definitive re-auth crisis: alert (dedup'd) + throw ReauthRequiredError.
async function recoverViaPrev(creds, sentToken, reason, d) {
  const prev = creds.refresh_token_prev
  if (!prev || prev === sentToken) {
    await d.alertReauthIfDue(`${reason}; no prev token to fall back to`, d)
    throw new ReauthRequiredError(`${reason}; no prev token`)
  }
  d.log(`Current refresh_token rejected (${reason}) — trying refresh_token_prev`)
  const body = buildRefreshBody(prev, creds)
  try {
    const resp = await postRefresh(body, d)
    applyRotation(creds, resp, prev, d)
    d.log(`recovered via prev token, expires at ${creds.token_expires_at}`)
    return creds
  } catch (err) {
    const prevStatus = Number((/^HTTP (\d+)/.exec(err.message) || [])[1])
    const prevDesc = Number.isNaN(prevStatus) ? err.message.slice(0, 60) : `HTTP ${prevStatus}`
    await d.alertReauthIfDue(`current ${reason}; prev ${prevDesc}`, d)
    throw new ReauthRequiredError(`current ${reason}; prev ${prevDesc}`)
  }
}

// Decide whether to refresh, then return a usable access_token.
//   - token expired                       → must refresh (ignore anti-churn guard)
//   - within REFRESH_THRESHOLD_MS + not churn → pre-refresh
//   - transient refresh failure + token still valid → continue on current token
//   - transient refresh failure + token expired    → propagate (main exits gracefully)
async function getToken(deps) {
  const d = Object.assign({ readCreds, refreshToken, log, now: Date.now }, deps || {})
  const creds = d.readCreds()
  const now = d.now()
  const expiresAt = new Date(creds.token_expires_at).getTime()
  const lastRefresh = creds.token_refreshed_at ? new Date(creds.token_refreshed_at).getTime() : 0
  const expired = now >= expiresAt
  const withinThreshold = now > expiresAt - REFRESH_THRESHOLD_MS
  const tooSoon = (now - lastRefresh) < MIN_REFRESH_INTERVAL_MS

  if (expired || (withinThreshold && !tooSoon)) {
    try {
      return (await d.refreshToken(creds, d)).access_token
    } catch (e) {
      if (e instanceof TransientRefreshError) {
        if (!expired) {
          const minsLeft = Math.max(0, Math.round((expiresAt - now) / 60000))
          d.log(`${e.message} — continuing sync on current access_token (valid ~${minsLeft}min); retry next cron`)
          return creds.access_token
        }
        // expired + transient: cannot continue. Propagate; main() exits 0 (retry next cron).
      }
      throw e
    }
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
        start: c.start ?? null,
        end: c.end ?? null,
        timezone_offset: c.timezone_offset ?? null,
        score_state: c.score_state ?? null,
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
        recovery_score: r.score?.recovery_score ?? null,
        resting_heart_rate: r.score?.resting_heart_rate ?? null,
        hrv_rmssd: r.score?.hrv_rmssd_milli ?? null,
        spo2_percentage: r.score?.spo2_percentage ?? null,
        skin_temp_celsius: r.score?.skin_temp_celsius ?? null,
        synced_at: now,
      }
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
        total_in_bed_ms: totalInBedMs,
        total_awake_ms: stages.total_awake_time_milli ?? null,
        total_light_sleep_ms: stages.total_light_sleep_time_milli ?? null,
        total_sws_ms: stages.total_slow_wave_sleep_time_milli ?? null,
        total_rem_ms: stages.total_rem_sleep_time_milli ?? null,
        sleep_cycle_count: stages.sleep_cycle_count ?? null,
        disturbance_count: stages.disturbance_count ?? null,
        total_sleep_ms: totalSleepMs,
        sleep_hours: sleepHours,
        sleep_needed_ms: sleepNeededMs,
        sleep_needed_hours: sleepNeededMs ? Math.round((sleepNeededMs / 3600000) * 10) / 10 : null,
        respiratory_rate: s.score?.respiratory_rate ?? null,
        sleep_performance: s.score?.sleep_performance_percentage ?? null,
        sleep_consistency: s.score?.sleep_consistency_percentage ?? null,
        sleep_efficiency: s.score?.sleep_efficiency_percentage ?? null,
        synced_at: now,
      }
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
      const kcal = w.score?.kilojoule ? Math.round(w.score?.kilojoule / 4.184) : null
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
        strain: w.score?.strain ?? null,
        kilojoule: w.score?.kilojoule ?? null,
        calories_burned: kcal,
        avg_heart_rate: w.score?.average_heart_rate ?? null,
        max_heart_rate: w.score?.max_heart_rate ?? null,
        percent_recorded: w.score?.percent_recorded ?? null,
        distance_meter: w.score?.distance_meter ?? null,
        altitude_gain_meter: w.score?.altitude_gain_meter ?? null,
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
  const mongoUrl = process.env.MONGO_URL
  if (!mongoUrl) throw new Error('MONGO_URL env var required (source /root/.config/chuttyevo/mongo.env)')
  const client = new MongoClient(mongoUrl)
  await client.connect()
  const db = client.db(DB_NAME)
  log('Connected to MongoDB')

  await db.collection('whoop_cycles').createIndex({ date: 1 }, { unique: true }).catch(() => {})
  await db.collection('whoop_recovery').createIndex({ date: 1 }, { unique: true }).catch(() => {})
  await db.collection('whoop_sleep').createIndex({ sleep_id: 1 }, { unique: true, sparse: true }).catch(() => {})
  await db.collection('whoop_sleep').createIndex({ date: 1 }).catch(() => {})
  await db.collection('whoop_workouts').createIndex({ workout_id: 1 }, { unique: true }).catch(() => {})

  const token = await getToken()

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

// Export the token layer for unit tests (see src/tests/whoop-token.test.ts).
module.exports = { refreshToken, getToken, alertReauthIfDue, ReauthRequiredError, TransientRefreshError,
  REFRESH_THRESHOLD_MS, MIN_REFRESH_INTERVAL_MS, REAUTH_DEDUP_HOURS, RETRY_5XX_PAUSE_MS,
  DEFAULT_UA, buildRequestHeaders, captureSetCookie, cookieHeaderFor, resetCookieJar }

// Run only when invoked directly, not when required by a test.
if (require.main === module) {
  main().catch(err => {
    if (err.name === 'ReauthRequiredError') {
      log(err.message)
      process.exit(2)
    }
    if (err.name === 'TransientRefreshError') {
      log(`${err.message} — token expired and refresh transient; will retry next cron run (freshness-check 12h safety net).`)
      process.exit(0) // not an error state — next cron retries, freshness-monitor catches prolonged outages
    }
    console.error('Sync failed:', err.message)
    process.exit(1)
  })
}
