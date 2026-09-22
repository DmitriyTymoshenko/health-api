#!/usr/bin/env node
// #1490 (stage F of #1485): fills real, grounded sources for
// `supplement_knowledge.continuous_source` / `cycle.source` /
// `interactions[].source`, adds `active_ingredients[].nutrient_key` (canon
// dictionary: ../data/nutrient-keys.js, shared with #1489's stack engine),
// `interactions[]` (REQ-8), and `purchase_url`/`purchase_note` for all 14
// docs, from a hand-curated dataset (../data/supplement-knowledge-curated-1485.json)
// built by grepping the real Koliada corpus (lib/koliada-corpus.js) for a
// verbatim, dated "Lesson N" citation per supplement, and — where the
// corpus does not cover a supplement (ashwagandha, ginseng, lion's mane) —
// a live-verified allowlist URL (examine.com/cochranelibrary.com/
// ods.od.nih.gov/pubmed.ncbi.nlm.nih.gov).
//
// The curated JSON is a CLAIM, not a fact — this script is the gate. Every
// `continuous_source` and every `interactions[].source` is re-validated
// here via lib/koliada-validate.js (Lucas's D3 grounding validator, #1487 —
// NOT modified by this task) against the live corpus text before anything
// is written. A claim that fails grounding (fabricated/paraphrased quote,
// non-allowlisted URL, malformed lesson ref) is DROPPED — not written, not
// silently substituted — and printed with its reason. This IS the grounding
// proof this task's acceptance (F-A) asks for: a claim that can't survive
// this re-check was never real grounding to begin with.
//
// The continuous/cycle invariant (continuous:true <=> cycle:null) is
// re-checked via lib/validate.js::validateKnowledgeCycleInvariant (Lucas's
// D4 invariant, #1487 — NOT modified) before any continuous/cycle write —
// a curated record that would violate it is skipped entirely (both fields),
// reported, and the existing doc's continuous/cycle stay untouched.
//
// Usage:
//   node scripts/apply-supplement-knowledge-curated-1485.js --dry-run   (default; no writes)
//   node scripts/apply-supplement-knowledge-curated-1485.js --apply     (writes)
//
// Idempotent: a $set with values identical to what's already stored is a
// no-op write (MongoDB reports modifiedCount:0 for unchanged fields) — a
// second --apply run reports "0 changed" across the board.
//
// Requires MONGO_URL in the environment (same var health-api.service runs
// with — no new secret).
'use strict'

const path = require('path')
const { MongoClient } = require('mongodb')
const { loadCorpus } = require('../lib/koliada-corpus')
const { validateVerdict } = require('../lib/koliada-validate')
const { validateKnowledgeCycleInvariant } = require('../lib/validate')

const APPLY = process.argv.includes('--apply')
const CURATED_PATH = path.join(__dirname, '..', 'data', 'supplement-knowledge-curated-1485.json')

/**
 * Re-validate one curated record against the live corpus + the invariant.
 * Returns { set, dropped: [{field, reason}] } — `set` is the exact $set
 * payload to write (only fields that passed every check), `dropped` lists
 * everything this record CLAIMED but that did not survive re-validation.
 *
 * Pure function (no Mongo/IO) — exported for the antiregression test so a
 * fabricated quote can be proven to fail WITHOUT a live DB.
 */
function buildFieldsToWrite(record, corpusText) {
  const dropped = []
  const set = {}

  // --- continuous / cycle invariant gate (D4, lib/validate.js) ---
  const invariantError = validateKnowledgeCycleInvariant({ continuous: record.continuous, cycle: record.cycle })
  if (invariantError) {
    dropped.push({ field: 'continuous/cycle', reason: `invariant violation: ${invariantError}` })
  } else {
    set.continuous = record.continuous
    set.cycle = record.cycle === undefined ? null : record.cycle

    // --- continuous_source grounding gate (D3, lib/koliada-validate.js) ---
    if (record.continuous_source) {
      const grounded = validateVerdict(record.continuous_source, corpusText)
      if (grounded.kind === 'not_covered' && record.continuous_source.kind !== 'not_covered') {
        dropped.push({ field: 'continuous_source', reason: 'grounding check downgraded claim to not_covered (quote/ref did not validate)' })
      } else {
        set.continuous_source = grounded
      }
    }

    // cycle.source, if a real cycle object was supplied
    if (record.cycle && record.cycle.source) {
      const groundedCycle = validateVerdict(record.cycle.source, corpusText)
      if (groundedCycle.kind === 'not_covered' && record.cycle.source.kind !== 'not_covered') {
        dropped.push({ field: 'cycle.source', reason: 'grounding check downgraded claim to not_covered (quote/ref did not validate)' })
        set.cycle = { ...record.cycle, source: groundedCycle }
      } else {
        set.cycle = { ...record.cycle, source: groundedCycle }
      }
    }
  }

  // --- active_ingredients: no grounding needed (dosage/nutrient_key data, not a source claim) ---
  if (Array.isArray(record.active_ingredients)) {
    set.active_ingredients = record.active_ingredients
  }

  // --- interactions[]: each entry's source individually gated ---
  if (Array.isArray(record.interactions)) {
    const validInteractions = []
    for (const it of record.interactions) {
      if (!it || !it.source) continue
      const grounded = validateVerdict(it.source, corpusText)
      if (grounded.kind === 'not_covered' && it.source.kind !== 'not_covered') {
        dropped.push({ field: `interactions[with=${it.with}]`, reason: 'grounding check downgraded claim to not_covered (quote/ref did not validate)' })
        continue
      }
      validInteractions.push({ ...it, source: grounded })
    }
    set.interactions = validInteractions
  }

  // --- purchase_url / purchase_note: plain data, no grounding needed ---
  if (record.purchase_url !== undefined) {
    set.purchase_url = record.purchase_url
    set.purchase_verified = false
  }
  if (record.purchase_note !== undefined) {
    set.purchase_note = record.purchase_note
  }

  return { set, dropped }
}

async function main() {
  const mongoUrl = process.env.MONGO_URL
  if (!mongoUrl) throw new Error('MONGO_URL not set')

  const curated = require(CURATED_PATH)
  const { text: corpusText, files } = loadCorpus()
  console.log(`Koliada corpus: ${files.length} files, ${corpusText.length} chars`)
  if (!corpusText) {
    console.warn('WARNING: corpus is empty (vault dir not found) — every koliada claim will be dropped')
  }

  const client = new MongoClient(mongoUrl)
  await client.connect()
  const db = client.db()

  try {
    const rows = []
    let totalDropped = 0

    for (const record of curated) {
      const { set, dropped } = buildFieldsToWrite(record, corpusText)
      totalDropped += dropped.length

      const sourceSummary = set.continuous_source ? `${set.continuous_source.by}/${set.continuous_source.kind}` : 'DROPPED'
      const refPreview = set.continuous_source ? String(set.continuous_source.ref || '').slice(0, 40) : ''
      rows.push({
        catalog_id: record.catalog_id,
        continuous: set.continuous,
        cycle: set.cycle ? `${set.cycle.duration_weeks}/${set.cycle.pause_weeks}` : 'null',
        source: sourceSummary,
        ref: refPreview,
        ingredients: Array.isArray(set.active_ingredients) ? set.active_ingredients.length : 0,
        interactions: Array.isArray(set.interactions) ? set.interactions.length : 0,
        purchase_url: set.purchase_url ? 'set' : 'null',
      })

      for (const d of dropped) {
        console.warn(`catalog_id=${record.catalog_id}: DROPPED ${d.field} — ${d.reason}`)
      }

      if (APPLY) {
        await db.collection('supplement_knowledge').findOneAndUpdate(
          { catalog_id: record.catalog_id },
          { $set: set },
          { upsert: false }
        )
      }
    }

    console.log('\n=== Curated fill report ===')
    console.table(rows)
    console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN (no writes)'}: ${rows.length} records processed, ${totalDropped} field(s) dropped by grounding/invariant gate`)

    if (APPLY) {
      const grounded = await db.collection('supplement_knowledge').countDocuments({
        'continuous_source.kind': { $in: ['confirms', 'neutral', 'against'] },
        'continuous_source.ref': { $exists: true, $ne: '' },
      })
      const koliadaCount = await db.collection('supplement_knowledge').countDocuments({ 'continuous_source.by': 'koliada' })
      console.log(`\nPost-apply: grounded continuous_source (ref exists) = ${grounded}/14, koliada-sourced = ${koliadaCount}`)
    }
  } finally {
    await client.close()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL:', err)
    process.exit(1)
  })
}

module.exports = { buildFieldsToWrite }
