#!/usr/bin/env node
'use strict'

/**
 * scripts/migrate-exercises-catalog-1332.js — #1332 (Ф1 of #1331 umbrella).
 *
 * Builds the NEW `exercises_catalog` collection (876 reference docs from
 * free-exercise-db, Unlicense — see file-level license note below) and separately
 * maps our 32 existing `exercises_library` documents onto it via `catalog_id`,
 * applying the equipment/muscle_group correction ONLY through Dictionary B
 * (lib/exercise-dictionaries.js) and ONLY through its null-overwrite guard.
 *
 * `exercises_library` stays the OPERATIONAL collection (32 docs + workout-log
 * autocreates) — untouched in shape, key (`name`), and every reader except the new
 * fields this script adds (`catalog_id`, `equipment_src`, `primary_muscles_src`,
 * `secondary_muscles_src`, and a corrected `equipment`/`muscle_group` where the guard
 * allows it). See #1331 comment #7551 (Apex, architectural decision) for the full
 * rationale — this script is its literal implementation, not a re-derivation.
 *
 * LICENSE / PROVENANCE (verified live, #1331 comments #7549/#7551):
 *   - github.com/yuhonas/free-exercise-db — Unlicense (public domain), confirmed via
 *     GitHub API `license.spdx_id == "Unlicense"`.
 *   - Upstream github.com/wrkout/exercises.json (images originate here) — ALSO
 *     Unlicense, confirmed the same way. No third tier of attribution exists upstream
 *     of that repo. The README's link to the commercial wrkout.xyz product is a
 *     DIFFERENT, paid dataset — NOT used here. source_url on every doc points at
 *     yuhonas/free-exercise-db specifically, never wrkout.xyz.
 *   - Images are downloaded to OUR host (uploads/exercises/<source_id>/N.jpg) rather
 *     than hotlinked from raw.githubusercontent.com — that host is not a production
 *     CDN (rate limits, no uptime guarantee for a live app asset).
 *
 * Usage:
 *   node scripts/migrate-exercises-catalog-1332.js --dry-run              # no writes, full report
 *   node scripts/migrate-exercises-catalog-1332.js --dry-run --skip-images
 *   node scripts/migrate-exercises-catalog-1332.js                        # real run (catalog + library + images)
 *   node scripts/migrate-exercises-catalog-1332.js --skip-images          # real run, catalog+library only, no image fetch
 *
 * Env:
 *   MONGO_URL (default mongodb://localhost:27017)
 *
 * Idempotent: catalog upserts key on `source_id` (unique index created here); library
 * updates key on `name` (exact match, same convention as the existing content-PATCH
 * route). Safe to re-run.
 */

const { MongoClient } = require('mongodb')
const fs = require('fs')
const path = require('path')

const {
  mapEquipmentToOurs,
  resolvePrimaryMuscleGroup,
  resolveLibraryEquipmentOverwrite,
} = require('../lib/exercise-dictionaries')

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017'
const DB_NAME = 'health_tracker'
const DRY_RUN = process.argv.includes('--dry-run')
const SKIP_IMAGES = process.argv.includes('--skip-images')

const SOURCE_JSON_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json'
const CACHED_SOURCE_PATH = '/tmp/fedb.json'
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'exercises')
const RAW_IMAGE_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises'
const SOURCE_URL = 'https://github.com/yuhonas/free-exercise-db'
const SOURCE_LICENSE = 'Unlicense'
const MIN_IMAGE_BYTES = 5000 // real jpgs here run 38-63KB; anything under 5KB is almost certainly a GitHub error page, not a photo

// -----------------------------------------------------------------------------------
// Curated mapping: our 32 exercises_library.name -> free-exercise-db `id` (source_id).
// One entry per name, hand-picked (#1332). `equipmentOverride: false` means: link for
// content/instructions/images only, do NOT let the (non-null) source equipment value
// overwrite ours even though the guard would normally allow it — see the Dips note.
// -----------------------------------------------------------------------------------
const LIBRARY_MAPPING = [
  { name: 'Горизонтальна тяга', sourceId: 'Seated_Cable_Rows' },
  { name: 'Підтягування', sourceId: 'Pullups' },
  { name: 'Тяга верхнього блоку', sourceId: 'Wide-Grip_Lat_Pulldown' },
  { name: 'Тяга гантелі', sourceId: 'One-Arm_Dumbbell_Row' },
  { name: 'Тяга штанги в нахилі', sourceId: 'Bent_Over_Barbell_Row' },
  { name: 'Згинання на біцепс', sourceId: 'Barbell_Curl' },
  { name: 'Молоткові згинання', sourceId: 'Hammer_Curls' },
  {
    name: 'Молоткові згинання на лаві Скотта',
    sourceId: 'Machine_Preacher_Curls',
    note: '#1310 fix — owner does this "на стеку" (weight-stack machine). No hammer-grip+preacher+machine combo exists in source; Machine_Preacher_Curls matches the VERIFIED equipment fact (dumbbell -> machine), trading the "hammer" grip nuance in the matched name/instructions (translation is Ф2 scope, not this task).',
  },
  {
    name: 'Віджимання на брусах',
    sourceId: 'Dips_-_Chest_Version',
    equipmentOverride: false,
    note: 'Only chest-primary dip variant in source; its equipment is "other" (dataset quirk — parallel-bar dips are bodyweight in reality). Content/image linked via catalog_id; equipment/muscle_group intentionally NOT overwritten (kept "bodyweight" — ours is more accurate here than the source).',
  },
  {
    name: 'Жим в нахилі',
    sourceId: 'Leverage_Incline_Chest_Press',
    note: '#1310 fix — owner does this in a machine ("тренажері"). Source confirms equipment=machine (barbell -> machine).',
  },
  { name: 'Жим гантелей лежачи', sourceId: 'Dumbbell_Bench_Press' },
  { name: 'Жим лежачи', sourceId: 'Barbell_Bench_Press_-_Medium_Grip' },
  { name: 'Пуловер', sourceId: 'Bent-Arm_Dumbbell_Pullover' },
  { name: 'Розведення гантелей', sourceId: 'Dumbbell_Flyes' },
  { name: 'Планка', sourceId: 'Plank' },
  { name: 'Підйом ніг', sourceId: 'Hanging_Leg_Raise' },
  { name: 'Скручування', sourceId: 'Crunches' },
  { name: 'Жим ногами', sourceId: 'Leg_Press' },
  { name: 'Згинання ніг', sourceId: 'Lying_Leg_Curls' },
  { name: 'Присідання', sourceId: 'Barbell_Squat' },
  { name: 'Підйом на носки', sourceId: 'Standing_Calf_Raises' },
  { name: 'Розгинання ніг', sourceId: 'Leg_Extensions' },
  { name: 'Румунська тяга', sourceId: 'Romanian_Deadlift' },
  { name: 'Жим гантелей сидячи', sourceId: 'Seated_Dumbbell_Press' },
  { name: 'Жим гантелей стоячи', sourceId: 'Standing_Dumbbell_Press' },
  { name: 'Жим штанги стоячи', sourceId: 'Standing_Military_Press' },
  { name: 'Розведення в сторони', sourceId: 'Side_Lateral_Raise' },
  { name: 'Розведення на задню дельту', sourceId: 'Seated_Bent-Over_Rear_Delt_Raise' },
  { name: 'Тяга до підборіддя', sourceId: 'Upright_Barbell_Row' },
  { name: 'Канат на трицепс', sourceId: 'Triceps_Pushdown_-_Rope_Attachment' },
  { name: 'Розгинання трицепса', sourceId: 'Triceps_Pushdown' },
  { name: 'Французький жим', sourceId: 'Lying_Close-Grip_Barbell_Triceps_Extension_Behind_The_Head' },
]

// -----------------------------------------------------------------------------------

async function loadSourceData() {
  try {
    const res = await fetch(SOURCE_JSON_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const data = JSON.parse(text)
    console.log(`[source] fetched ${data.length} exercises live from ${SOURCE_JSON_URL}`)
    return data
  } catch (err) {
    console.warn(`[source] live fetch failed (${err.message}), falling back to cache ${CACHED_SOURCE_PATH}`)
    if (!fs.existsSync(CACHED_SOURCE_PATH)) {
      throw new Error(`No live source and no cache at ${CACHED_SOURCE_PATH} — cannot proceed`)
    }
    const data = JSON.parse(fs.readFileSync(CACHED_SOURCE_PATH, 'utf8'))
    console.log(`[source] loaded ${data.length} exercises from cache`)
    return data
  }
}

async function downloadImage(sourceId, imageRelPath, index) {
  const destDir = path.join(UPLOADS_DIR, sourceId)
  const destPath = path.join(destDir, `${index}.jpg`)
  const localUrlPath = `/uploads/exercises/${sourceId}/${index}.jpg`

  if (fs.existsSync(destPath) && fs.statSync(destPath).size >= MIN_IMAGE_BYTES) {
    return { ok: true, path: localUrlPath, skipped: 'already-downloaded' }
  }

  const remoteUrl = `${RAW_IMAGE_BASE}/${imageRelPath}`
  try {
    const res = await fetch(remoteUrl)
    if (!res.ok) return { ok: false, path: null, error: `HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < MIN_IMAGE_BYTES) {
      return { ok: false, path: null, error: `too small (${buf.length}b) — likely not a real image` }
    }
    fs.mkdirSync(destDir, { recursive: true })
    fs.writeFileSync(destPath, buf)
    return { ok: true, path: localUrlPath, bytes: buf.length }
  } catch (err) {
    return { ok: false, path: null, error: err.message }
  }
}

async function migrateCatalog(db, sourceData) {
  const col = db.collection('exercises_catalog')
  if (!DRY_RUN) {
    await col.createIndex({ source_id: 1 }, { unique: true })
  }

  let inserted = 0
  let updated = 0
  let imagesOk = 0
  let imagesFail = 0
  const dictionaryErrors = []
  const imageFailures = []

  for (const ex of sourceData) {
    let equipment
    let muscleGroup
    try {
      equipment = mapEquipmentToOurs(ex.equipment)
      muscleGroup = resolvePrimaryMuscleGroup(ex.primaryMuscles)
    } catch (err) {
      dictionaryErrors.push({ id: ex.id, error: err.message })
      continue
    }

    let imageUrls = []
    if (!SKIP_IMAGES) {
      for (let i = 0; i < (ex.images || []).length; i++) {
        const result = await downloadImage(ex.id, ex.images[i], i)
        if (result.ok) {
          imageUrls.push(result.path)
          imagesOk++
        } else {
          imagesFail++
          imageFailures.push({ id: ex.id, index: i, error: result.error })
        }
      }
    }

    const doc = {
      source_id: ex.id,
      name_en: ex.name,
      name_ua: null, // Ф2 (#1333) fills this in — out of scope here
      equipment,
      equipment_src: ex.equipment ?? null,
      muscle_group: muscleGroup,
      primary_muscles_src: ex.primaryMuscles || [],
      secondary_muscles_src: ex.secondaryMuscles || [],
      category: ex.category,
      level: ex.level,
      force: ex.force ?? null,
      mechanic: ex.mechanic ?? null,
      instructions_en: ex.instructions || [],
      instructions_ua: null, // Ф2 (#1333)
      images: imageUrls,
      source: 'free-exercise-db',
      source_id_images: ex.id,
      source_url: SOURCE_URL,
      source_license: SOURCE_LICENSE,
      verified_at: new Date(),
    }

    if (DRY_RUN) {
      inserted++ // count-as-would-insert for the report; no distinction needed in dry-run
      continue
    }

    const result = await col.updateOne(
      { source_id: ex.id },
      { $set: doc },
      { upsert: true }
    )
    if (result.upsertedCount > 0) inserted++
    else updated++
  }

  return { inserted, updated, imagesOk, imagesFail, dictionaryErrors, imageFailures, total: sourceData.length }
}

async function migrateLibraryMapping(db, sourceById) {
  const col = db.collection('exercises_library')
  const rows = []

  for (const mapping of LIBRARY_MAPPING) {
    const srcEx = sourceById.get(mapping.sourceId)
    if (!srcEx) {
      rows.push({ name: mapping.name, sourceId: mapping.sourceId, status: 'SOURCE_ID_NOT_FOUND' })
      continue
    }

    const current = await col.findOne({ name: mapping.name })
    if (!current) {
      rows.push({ name: mapping.name, sourceId: mapping.sourceId, status: 'LIBRARY_DOC_NOT_FOUND' })
      continue
    }

    const mappedEquipment = mapEquipmentToOurs(srcEx.equipment)
    const applyEquipment = mapping.equipmentOverride === false
    const finalEquipment = applyEquipment
      ? current.equipment
      : resolveLibraryEquipmentOverwrite(current.equipment, mappedEquipment)

    const mappedMuscleGroup = resolvePrimaryMuscleGroup(srcEx.primaryMuscles)
    // Same guard logic applies to muscle_group — never erase with an unknown source value.
    const finalMuscleGroup = mappedMuscleGroup === null
      ? current.muscle_group
      : mappedMuscleGroup

    const update = {
      catalog_id: mapping.sourceId,
      equipment_src: srcEx.equipment ?? null,
      primary_muscles_src: srcEx.primaryMuscles || [],
      secondary_muscles_src: srcEx.secondaryMuscles || [],
      equipment: finalEquipment,
      muscle_group: finalMuscleGroup,
      updated_at: new Date(),
    }

    const equipmentChanged = current.equipment !== finalEquipment
    const muscleGroupChanged = current.muscle_group !== finalMuscleGroup

    rows.push({
      name: mapping.name,
      sourceId: mapping.sourceId,
      status: 'MAPPED',
      equipmentBefore: current.equipment,
      equipmentAfter: finalEquipment,
      equipmentChanged,
      muscleGroupBefore: current.muscle_group,
      muscleGroupAfter: finalMuscleGroup,
      muscleGroupChanged,
      note: mapping.note || null,
    })

    if (!DRY_RUN) {
      await col.updateOne({ name: mapping.name }, { $set: update })
    }
  }

  return rows
}

async function main() {
  console.log(`[migrate-1332] ${DRY_RUN ? 'DRY RUN — no writes' : 'LIVE RUN — writing to Mongo'}${SKIP_IMAGES ? ' (images skipped)' : ''}`)

  const sourceData = await loadSourceData()
  const sourceById = new Map(sourceData.map(ex => [ex.id, ex]))

  const client = new MongoClient(MONGO_URL)
  await client.connect()
  const db = client.db(DB_NAME)

  try {
    const catalogReport = await migrateCatalog(db, sourceData)
    console.log('\n=== CATALOG REPORT ===')
    console.log(`source rows:        ${catalogReport.total}`)
    console.log(`inserted/upserted:  ${catalogReport.inserted}`)
    console.log(`updated (existing): ${catalogReport.updated}`)
    console.log(`images ok:          ${catalogReport.imagesOk}`)
    console.log(`images failed:      ${catalogReport.imagesFail}`)
    if (catalogReport.dictionaryErrors.length > 0) {
      console.log(`DICTIONARY ERRORS (${catalogReport.dictionaryErrors.length}):`)
      for (const e of catalogReport.dictionaryErrors) console.log(`  ${e.id}: ${e.error}`)
    }
    if (catalogReport.imageFailures.length > 0) {
      console.log(`IMAGE FAILURES (${catalogReport.imageFailures.length}):`)
      for (const f of catalogReport.imageFailures.slice(0, 20)) console.log(`  ${f.id}[${f.index}]: ${f.error}`)
    }

    const libraryRows = await migrateLibraryMapping(db, sourceById)
    console.log('\n=== LIBRARY MAPPING REPORT (32 our exercises) ===')
    let mapped = 0
    let unmapped = 0
    let equipmentChanges = 0
    for (const r of libraryRows) {
      if (r.status !== 'MAPPED') {
        unmapped++
        console.log(`UNMAPPED  ${r.name} (${r.sourceId}) -> ${r.status}`)
        continue
      }
      mapped++
      const eqFlag = r.equipmentChanged ? `CHANGED ${r.equipmentBefore} -> ${r.equipmentAfter}` : `unchanged (${r.equipmentAfter})`
      if (r.equipmentChanged) equipmentChanges++
      console.log(`MAPPED    ${r.name} -> ${r.sourceId} | equipment: ${eqFlag}${r.note ? ` | NOTE: ${r.note}` : ''}`)
    }
    console.log(`\nmapped: ${mapped}/${LIBRARY_MAPPING.length} | unmapped: ${unmapped} | equipment changed: ${equipmentChanges}`)

    if (!DRY_RUN) {
      const libCount = await db.collection('exercises_library').countDocuments({})
      const nullEquipment = await db.collection('exercises_library').countDocuments({ equipment: null })
      const catalogCount = await db.collection('exercises_catalog').countDocuments({})
      console.log('\n=== POST-WRITE VERIFICATION ===')
      console.log(`exercises_library total: ${libCount} (must stay 32)`)
      console.log(`exercises_library equipment:null: ${nullEquipment} (must be 0)`)
      console.log(`exercises_catalog total: ${catalogCount} (must be 876)`)
    }
  } finally {
    await client.close()
  }
}

main().catch(err => {
  console.error('[migrate-1332] FATAL:', err)
  process.exit(1)
})
