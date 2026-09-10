#!/usr/bin/env node
// #1296 mutation: dedup + reindex whoop_cycles/whoop_recovery by Rule B
// (KyivDay(start+12h)), then rebuild daily_metrics for affected dates.
// Owner approval: Dmytro 2026-09-10 12:23 "затверджую" — 72+137 whoop_cycles,
// 8+132 whoop_recovery, "64 не чіпаємо", rebuild daily_metrics.
// Usage: node migrate-whoop-date-reindex-1296.js --dry-run   (default; no writes)
//        node migrate-whoop-date-reindex-1296.js --apply     (real writes)
//
// RUN RESULT (2026-09-10, applied 11:33:24–11:33:25 UTC / 14:33 Kyiv):
// whoop_cycles 72 DELETE + 137 UPDATE, whoop_recovery 8 DELETE + 132 UPDATE,
// daily_metrics rebuilt for 424 affected dates (2024-12-13..2026-08-18).
// Pre-mutation backup: docker exec mongo-health mongodump --archive of the
// whole health_tracker DB -> /root/backups/mongo-health-1296/health_tracker_1296_backup.archive
// (sha256 dbac64e0f99f290dbb777310f36f2866dba718380883546b35883bbc7c6ad1f5).
// Post-state, task's own acceptance criterion (offset = KyivDay(sleep.end) -
// recovery.date, on rows where sleep_id resolves): {0: 160} — was {0:31, 1:137}.
// daily_metrics canonical matcher, last 90 days: aligned=88 misaligned=0
// undetermined=3 (undetermined = rows whose recovery lacks sleep_id, out of
// scope per owner decision "64 lishaemo"). Full 64-unresolved-no-sleep_id
// population left untouched, per approved scope; open cycle (cycle_id at
// mutation time 1784118958, end:null) excluded via `end != null` predicate,
// not a date cutoff. #1322 (writer date-label defect) and #1326 (backfill for
// the 64) are separate tickets, not touched by this script.
'use strict'
const { MongoClient } = require('mongodb')
const { execSync } = require('child_process')

const APPLY = process.argv.includes('--apply')

function kyivDayPlus12(startIso) {
  const d = new Date(new Date(startIso).getTime() + 12 * 3600 * 1000)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' })
  return fmt.format(d)
}
function kyivDay(iso) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' })
  return fmt.format(new Date(iso))
}
function assertNoSync() {
  // `ps -eo pid,cmd | grep '[s]ync-whoop.js'` — bracket trick so grep's own
  // argv never self-matches (unlike `pgrep -f sync-whoop.js`, whose own argv
  // contains the search string and always matches itself).
  const ps = execSync("ps -eo pid,cmd | grep '[s]ync-whoop.js' || true").toString().trim()
  if (ps) throw new Error('sync-whoop.js is running RIGHT NOW — aborting: ' + ps)
}

async function main() {
  assertNoSync()
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  const db = client.db()
  const cyclesCol = db.collection('whoop_cycles')
  const recCol = db.collection('whoop_recovery')
  const dmCol = db.collection('daily_metrics')
  const sleepCol = db.collection('whoop_sleep')

  const report = { mode: APPLY ? 'APPLY' : 'DRY-RUN', started_at: new Date().toISOString() }
  const affectedDates = new Set()

  // ============ PHASE 1: whoop_cycles ============
  const cycles = await cyclesCol.find({}).toArray()
  const openCycles = cycles.filter(c => c.end == null)
  const closedCycles = cycles.filter(c => c.end != null)
  const byCycleId = new Map()
  for (const c of cycles) {
    if (!byCycleId.has(c.cycle_id)) byCycleId.set(c.cycle_id, [])
    byCycleId.get(c.cycle_id).push(c)
  }
  const dupGroupsClosed = [...byCycleId.values()].filter(g => g.length > 1 && g.every(c => c.end != null))

  const cyclesDeleteIds = []
  for (const g of dupGroupsClosed) {
    const target = kyivDayPlus12(g[0].start)
    for (const c of g) {
      if (c.date !== target) cyclesDeleteIds.push(c._id)
      affectedDates.add(c.date)
    }
    affectedDates.add(target)
  }

  const singleClosed = closedCycles.filter(c => byCycleId.get(c.cycle_id).length === 1)
  const cyclesUpdates = [] // { _id, from, to }
  for (const c of singleClosed) {
    const target = kyivDayPlus12(c.start)
    if (target !== c.date) {
      cyclesUpdates.push({ _id: c._id, from: c.date, to: target })
      affectedDates.add(c.date)
      affectedDates.add(target)
    }
  }

  report.cycles = { deletes: cyclesDeleteIds.length, updates: cyclesUpdates.length, open_excluded: openCycles.map(c => c.cycle_id) }

  // Hard gate: owner approval (Dmytro 2026-09-10 12:23) named exact numbers.
  // Any drift from them must stop the run before a single write, not be
  // silently absorbed — re-measure and get a fresh approval instead.
  const APPROVED = { cyclesDeletes: 72, cyclesUpdates: 137, recDeletes: 8, recUpdates: 132 }
  if (cyclesDeleteIds.length !== APPROVED.cyclesDeletes || cyclesUpdates.length !== APPROVED.cyclesUpdates) {
    throw new Error(`whoop_cycles scope drift: got ${cyclesDeleteIds.length} deletes / ${cyclesUpdates.length} updates, approved was ${APPROVED.cyclesDeletes}/${APPROVED.cyclesUpdates} — STOP, do not write`)
  }

  if (APPLY) {
    assertNoSync()
    if (cyclesDeleteIds.length) await cyclesCol.deleteMany({ _id: { $in: cyclesDeleteIds } })
    // two-phase TMP to dodge unique index on {date:1}
    for (const u of cyclesUpdates) await cyclesCol.updateOne({ _id: u._id }, { $set: { date: 'TMP:' + u._id.toString() } })
    const tmpLeft1 = await cyclesCol.countDocuments({ date: { $regex: '^TMP:' } })
    if (tmpLeft1 !== cyclesUpdates.length) throw new Error('cycles phase A count mismatch: ' + tmpLeft1 + ' vs ' + cyclesUpdates.length)
    for (const u of cyclesUpdates) await cyclesCol.updateOne({ _id: u._id }, { $set: { date: u.to } })
    const tmpLeft2 = await cyclesCol.countDocuments({ date: { $regex: '^TMP:' } })
    if (tmpLeft2 !== 0) throw new Error('cycles phase B left TMP rows: ' + tmpLeft2)
  }

  // ============ PHASE 2: whoop_recovery ============
  // Join recovery against the CANONICAL target date of each surviving closed
  // cycle, computed straight from Rule B on cycle.start — NOT the raw stored
  // `whoop_cycles.date` field. This must be order-independent (correct whether
  // or not the cycles write has physically happened yet), so both --dry-run
  // (no write) and --apply (post-write) compute the identical join target.
  const cyclesDeleteIdSet = new Set(cyclesDeleteIds.map(String))
  const correctedCycleDateById = new Map()
  for (const c of closedCycles) {
    if (cyclesDeleteIdSet.has(String(c._id))) continue // dup loser, doesn't survive
    correctedCycleDateById.set(c.cycle_id, kyivDayPlus12(c.start))
  }

  const recovery = await recCol.find({}).toArray()
  const recWithDate = recovery.map(r => ({ r, correctedDate: correctedCycleDateById.get(r.cycle_id) ?? null }))
  const recResolved = recWithDate.filter(x => x.correctedDate != null)
  const recUnresolved = recWithDate.filter(x => x.correctedDate == null)
  const recUnresolvedNoSleepId = recUnresolved.filter(x => !x.r.sleep_id)

  const byCycleSleep = new Map()
  for (const x of recResolved) {
    const k = x.r.cycle_id + '::' + (x.r.sleep_id ?? 'null')
    if (!byCycleSleep.has(k)) byCycleSleep.set(k, [])
    byCycleSleep.get(k).push(x)
  }
  const recDupGroups = [...byCycleSleep.values()].filter(g => g.length > 1)
  const recDeleteIds = []
  for (const g of recDupGroups) {
    const keepIdx = g.findIndex(x => x.r.date === x.correctedDate)
    const keep = keepIdx >= 0 ? keepIdx : 0
    g.forEach((x, i) => {
      affectedDates.add(x.r.date)
      if (i !== keep) recDeleteIds.push(x.r._id)
    })
    affectedDates.add(g[keep].correctedDate)
  }

  const recDeleteIdSet = new Set(recDeleteIds.map(String))
  const recUpdates = []
  for (const x of recResolved) {
    if (recDeleteIdSet.has(String(x.r._id))) continue
    if (x.r.date !== x.correctedDate) {
      recUpdates.push({ _id: x.r._id, from: x.r.date, to: x.correctedDate })
      affectedDates.add(x.r.date)
      affectedDates.add(x.correctedDate)
    }
  }

  report.recovery = {
    deletes: recDeleteIds.length, updates: recUpdates.length,
    resolved: recResolved.length, unresolved: recUnresolved.length, unresolved_no_sleep_id: recUnresolvedNoSleepId.length,
  }

  if (recDeleteIds.length !== APPROVED.recDeletes || recUpdates.length !== APPROVED.recUpdates) {
    throw new Error(`whoop_recovery scope drift: got ${recDeleteIds.length} deletes / ${recUpdates.length} updates, approved was ${APPROVED.recDeletes}/${APPROVED.recUpdates} — STOP, do not write`)
  }

  if (APPLY) {
    assertNoSync()
    if (recDeleteIds.length) await recCol.deleteMany({ _id: { $in: recDeleteIds } })
    for (const u of recUpdates) await recCol.updateOne({ _id: u._id }, { $set: { date: 'TMP:' + u._id.toString() } })
    const tmpLeft1 = await recCol.countDocuments({ date: { $regex: '^TMP:' } })
    if (tmpLeft1 !== recUpdates.length) throw new Error('recovery phase A count mismatch: ' + tmpLeft1 + ' vs ' + recUpdates.length)
    for (const u of recUpdates) await recCol.updateOne({ _id: u._id }, { $set: { date: u.to } })
    const tmpLeft2 = await recCol.countDocuments({ date: { $regex: '^TMP:' } })
    if (tmpLeft2 !== 0) throw new Error('recovery phase B left TMP rows: ' + tmpLeft2)
  }

  // ============ PHASE 3: rebuild daily_metrics for affected dates ============
  // Canonical matcher / merge logic mirrors scripts/sync-whoop.js buildMetricsDoc,
  // but reads DB docs instead of live API records, and explicitly nulls fields
  // that no longer resolve (a bare $set of only present keys would leave stale
  // wrong-night values behind for dates whose source doc moved away).
  const CYCLE_FIELDS = ['strain', 'calories_burned', 'avg_heart_rate', 'max_heart_rate']
  const RECOVERY_FIELDS = ['recovery_score', 'hrv_rmssd', 'resting_heart_rate', 'spo2_percentage', 'skin_temp_celsius']
  const SLEEP_FIELDS = ['sleep_hours', 'sleep_light_hours', 'sleep_deep_hours', 'sleep_rem_hours',
    'sleep_disturbance_count', 'sleep_cycle_count', 'sleep_performance', 'sleep_needed_hours',
    'sleep_consistency', 'sleep_efficiency', 'respiratory_rate']

  function pickLongerSleep(current, candidate) {
    if (!current) return candidate
    return (candidate.total_sleep_ms ?? -1) > (current.total_sleep_ms ?? -1) ? candidate : current
  }

  // Final post-mutation state, computed the SAME way in both modes: take the
  // live pre-mutation doc set, drop deletes, remap dates via the update lists
  // already computed above. In --apply this equals what's now actually in the
  // DB (re-reading would give the identical answer); building it in-memory
  // keeps --dry-run and --apply on one code path so they can't silently diverge.
  const cyclesUpdateMap = new Map(cyclesUpdates.map(u => [String(u._id), u.to]))
  const cyclesFinal = closedCycles
    .filter(c => !cyclesDeleteIdSet.has(String(c._id)))
    .map(c => ({ ...c, date: cyclesUpdateMap.get(String(c._id)) ?? c.date }))
    .concat(openCycles)

  const recUpdateMap = new Map(recUpdates.map(u => [String(u._id), u.to]))
  const recFinal = recovery
    .filter(r => !recDeleteIdSet.has(String(r._id)))
    .map(r => ({ ...r, date: recUpdateMap.get(String(r._id)) ?? r.date }))

  const cycleByDate = new Map()
  for (const c of cyclesFinal) cycleByDate.set(c.date, c)
  const recByDate = new Map()
  for (const r of recFinal) recByDate.set(r.date, r)
  const allSleep = await sleepCol.find({}).toArray()
  const sleepByDate = new Map()
  for (const s of allSleep) {
    if (s.nap) continue
    sleepByDate.set(s.date, pickLongerSleep(sleepByDate.get(s.date) ?? null, s))
  }

  const dmUpdates = []
  for (const date of affectedDates) {
    const cycleResult = cycleByDate.get(date) ?? null
    const recoveryResult = recByDate.get(date) ?? null
    const sleepResult = sleepByDate.get(date) ?? null
    const setDoc = { date }
    for (const f of CYCLE_FIELDS) setDoc[f] = cycleResult && cycleResult[f] !== undefined ? cycleResult[f] : null
    for (const f of RECOVERY_FIELDS) setDoc[f] = recoveryResult && recoveryResult[f] !== undefined ? recoveryResult[f] : null
    if (sleepResult) {
      setDoc.sleep_hours = sleepResult.sleep_hours ?? null
      setDoc.sleep_light_hours = sleepResult.total_light_sleep_ms != null ? Math.round((sleepResult.total_light_sleep_ms / 3600000) * 10) / 10 : null
      setDoc.sleep_deep_hours = sleepResult.total_sws_ms != null ? Math.round((sleepResult.total_sws_ms / 3600000) * 10) / 10 : null
      setDoc.sleep_rem_hours = sleepResult.total_rem_ms != null ? Math.round((sleepResult.total_rem_ms / 3600000) * 10) / 10 : null
      setDoc.sleep_disturbance_count = sleepResult.disturbance_count ?? null
      setDoc.sleep_cycle_count = sleepResult.sleep_cycle_count ?? null
      setDoc.sleep_performance = sleepResult.sleep_performance ?? null
      setDoc.sleep_needed_hours = sleepResult.sleep_needed_hours ?? null
      setDoc.sleep_consistency = sleepResult.sleep_consistency ?? null
      setDoc.sleep_efficiency = sleepResult.sleep_efficiency ?? null
      setDoc.respiratory_rate = sleepResult.respiratory_rate ?? null
    } else {
      for (const f of SLEEP_FIELDS) setDoc[f] = null
    }
    dmUpdates.push(setDoc)
  }

  report.daily_metrics = { affected_dates: affectedDates.size, dates: [...affectedDates].sort() }

  if (APPLY) {
    for (const doc of dmUpdates) {
      const { date, ...rest } = doc
      await dmCol.updateOne({ date }, { $set: rest }, { upsert: true })
    }
  }

  // ============ acceptance check (post-state, only meaningful with --apply) ============
  if (APPLY) {
    const finalCycles = await cyclesCol.find({}).toArray()
    const finalClosed = finalCycles.filter(c => c.end != null)
    const finalOpen = finalCycles.filter(c => c.end == null)
    let offCount = 0
    for (const c of finalClosed) if (kyivDayPlus12(c.start) !== c.date) offCount++
    const dupCheck = new Map()
    for (const c of finalCycles) dupCheck.set(c.cycle_id, (dupCheck.get(c.cycle_id) || 0) + 1)
    const remainingDupGroups = [...dupCheck.values()].filter(n => n > 1).length

    const finalRecovery = await recCol.find({}).toArray()
    const finalCycleDateById = new Map(finalClosed.map(c => [c.cycle_id, c.date]))
    let recOff = 0
    for (const r of finalRecovery) {
      const cd = finalCycleDateById.get(r.cycle_id)
      if (cd != null && cd !== r.date) recOff++
    }
    const recDupCheck = new Map()
    for (const r of finalRecovery) {
      const k = r.cycle_id + '::' + (r.sleep_id ?? 'null')
      recDupCheck.set(k, (recDupCheck.get(k) || 0) + 1)
    }
    const remainingRecDupGroups = [...recDupCheck.values()].filter(n => n > 1).length

    report.acceptance = {
      closed_cycles_offset_nonzero: offCount,
      remaining_cycle_dup_groups: remainingDupGroups,
      open_cycles_excluded: finalOpen.map(c => c.cycle_id),
      recovery_offset_nonzero_among_resolved: recOff,
      remaining_recovery_dup_groups: remainingRecDupGroups,
    }
  }

  report.finished_at = new Date().toISOString()
  console.log(JSON.stringify(report, null, 2))
  await client.close()
}
main().catch(e => { console.error('MIGRATION ERROR:', e); process.exit(1) })
