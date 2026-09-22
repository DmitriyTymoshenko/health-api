#!/usr/bin/env node
// #1487 (stage B of #1485, design D5): fills `supplement_knowledge.continuous`/
// `cycle`/`continuous_source`/`cycle.source`/`purchase_url` for every catalog
// item (and every existing knowledge doc whose catalog_id has no live catalog
// row, per D4 — ids 4/5/14 measured by Apex 22.09) that is missing them.
//
// Uses Gemini (lib/gemini-text.js) grounded against the Koliada vault corpus
// (lib/koliada-corpus.js), validated deterministically (lib/koliada-validate.js)
// before anything is trusted, and writes ONLY fields that are genuinely
// missing on the existing document (lib/supplement-knowledge-fill.js) — never
// overwrites an owner-set or prior-run value.
//
// Usage:
//   node scripts/fill-supplement-knowledge-1485.js --dry-run   (default; no writes, no Gemini spend beyond the read-only classification calls — still calls the LLM to SHOW what would be written, but performs 0 Mongo writes)
//   node scripts/fill-supplement-knowledge-1485.js --apply     (writes)
//
// Requires MONGO_URL + GOOGLE_AI_API_KEY in the environment (same vars
// health-api.service already runs with — no new secret, D1).
'use strict'

const { MongoClient } = require('mongodb')
const { loadCorpus } = require('../lib/koliada-corpus')
const { callGemini } = require('../lib/gemini-text')
const { validateVerdict } = require('../lib/koliada-validate')
const { retrieveKoliadaSnippets, formatSnippets } = require('../lib/koliada-retrieve')
const { RESPONSE_SCHEMA, buildPrompt, computeFieldsToWrite, isValidCycleObject } = require('../lib/supplement-knowledge-fill')

const APPLY = process.argv.includes('--apply')

function supplementLabel(catalogDoc, knowledgeDoc) {
  if (catalogDoc) return [catalogDoc.brand, catalogDoc.short_name || catalogDoc.name].filter(Boolean).join(' ')
  return knowledgeDoc?.name || knowledgeDoc?.short_name || `catalog_id ${knowledgeDoc?.catalog_id}`
}

/**
 * Build the target set: every catalog item (active or archived — D4) PLUS
 * every knowledge doc whose catalog_id has no matching catalog row at all
 * (orphaned, e.g. ids 4/5/14 per D4's measurement). Each target only needs
 * an LLM call if it is genuinely missing `continuous` (already-filled items
 * are skipped entirely — 0 spend on them).
 */
function buildTargets(catalogDocs, knowledgeDocs) {
  const knowledgeByCatalogId = new Map(knowledgeDocs.map(k => [k.catalog_id, k]))
  const catalogIds = new Set(catalogDocs.map(c => c.id))
  const targets = []

  for (const c of catalogDocs) {
    targets.push({ catalog_id: c.id, catalogDoc: c, knowledgeDoc: knowledgeByCatalogId.get(c.id) || null })
  }
  for (const k of knowledgeDocs) {
    if (!catalogIds.has(k.catalog_id)) {
      targets.push({ catalog_id: k.catalog_id, catalogDoc: null, knowledgeDoc: k })
    }
  }
  return targets
}

// #1487 (bug found + fixed live 22.09, see lib/supplement-knowledge-fill.js
// header comment): a doc with `continuous:false` but an INVALID/missing
// cycle is a data-integrity bug, not a "complete" state — it must be
// re-offered to the next run so it self-heals instead of being silently
// skipped forever.
//
// #1487 QA FAIL round 1 (Max/codex 22.09 13:24, Apex triage 13:35): the
// MIRROR-IMAGE invalid state — `continuous:true` alongside a real, non-null
// `cycle` object — was NOT detected here. If such a doc happened to already
// have `cycle.source` set, `--dry-run` reported it as complete ("0 need
// filling") even though it violates D4, hiding the broken state instead of
// surfacing it. Detected unconditionally on `cycle != null` (not gated on
// `isValidCycleObject`/`.source`) — ANY non-null cycle alongside
// `continuous:true` is itself the violation, regardless of the cycle's own
// shape or whether its `source` sub-field happens to be filled.
function needsFill(target) {
  const k = target.knowledgeDoc
  if (!k) return true
  if (k.continuous === undefined) return true
  if (k.continuous === false && !isValidCycleObject(k.cycle)) return true
  if (k.continuous === true && k.cycle != null) return true
  if (isValidCycleObject(k.cycle) && k.cycle.source === undefined) return true
  return false
}

// #1487 QA FAIL round 1 (Max/codex 22.09 13:24): "0 need filling" alone is
// not proof the D4 invariant holds — a doc that would need re-filling for a
// COMPLETENESS reason (missing continuous, missing cycle.source, ...) shows
// up in `toFill`, but a doc could in principle sit in an invalid shape that
// a future needsFill() blind spot fails to catch. This is a DIRECT,
// standalone re-derivation of the same D4 check the live `GET
// /api/catalog/knowledge` invariant scan and `lib/validate.js` HTTP
// middleware both enforce — independent of `needsFill()` so a bug in one
// does not hide a violation from the other. Always printed, even when
// `toFill` is empty, so `--dry-run` never goes silent on an invalid state.
function findInvariantViolations(knowledgeDocs) {
  return knowledgeDocs
    .filter(k => (k.continuous === true && k.cycle != null) || (k.continuous === false && !isValidCycleObject(k.cycle)))
    .map(k => ({ catalog_id: k.catalog_id, continuous: k.continuous, cycle: k.cycle }))
}

async function classifyOne(target, corpusText, apiKey) {
  const label = supplementLabel(target.catalogDoc, target.knowledgeDoc)
  const snippets = retrieveKoliadaSnippets(corpusText, [label, target.catalogDoc?.short_name, target.catalogDoc?.name, target.knowledgeDoc?.name], { contextLines: 3, limit: 8 })
  const evidenceText = formatSnippets(snippets)
  const prompt = buildPrompt(label, evidenceText)
  const { json, usage } = await callGemini({ apiKey, prompt, schema: RESPONSE_SCHEMA })
  if (!json) return { label, usage, error: 'Gemini returned no parseable JSON' }

  const groundedSource = validateVerdict(json.verdict, evidenceText)
  const fieldsToWrite = computeFieldsToWrite(
    target.knowledgeDoc || {},
    { continuous: !!json.continuous, cycle: json.cycle || null },
    groundedSource,
    json.purchase_url || null
  )
  return { label, json, groundedSource, fieldsToWrite, usage }
}

async function main() {
  const mongoUrl = process.env.MONGO_URL
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!mongoUrl) throw new Error('MONGO_URL not set')
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not set')

  const { text: corpusText, files } = loadCorpus()
  console.log(`Koliada corpus: ${files.length} files, ${corpusText.length} chars`)
  if (!corpusText) {
    console.warn('WARNING: corpus is empty (vault dir not found) — every verdict will be not_covered')
  }

  const client = new MongoClient(mongoUrl)
  await client.connect()
  const db = client.db()

  try {
    const [catalogDocs, knowledgeDocs] = await Promise.all([
      db.collection('supplement_catalog').find({}).toArray(),
      db.collection('supplement_knowledge').find({}).toArray(),
    ])

    const targets = buildTargets(catalogDocs, knowledgeDocs)
    const toFill = targets.filter(needsFill)
    console.log(`Targets: ${targets.length} total, ${toFill.length} need filling (${targets.length - toFill.length} already complete, 0 spend on those)`)

    const violations = findInvariantViolations(knowledgeDocs)
    console.log(`Invariant scan (D4: continuous===true&&cycle!=null OR continuous===false&&invalid-cycle) — invalid: ${JSON.stringify(violations.map(v => v.catalog_id))}`)
    if (violations.length > 0) {
      console.log(violations)
    }

    let totalPromptTokens = 0
    let totalCandidateTokens = 0
    const rows = []
    let exceptions = 0

    for (const target of toFill) {
      let outcome
      try {
        outcome = await classifyOne(target, corpusText, apiKey)
      } catch (err) {
        exceptions++
        rows.push({ catalog_id: target.catalog_id, label: supplementLabel(target.catalogDoc, target.knowledgeDoc), error: err.message })
        console.error(`catalog_id=${target.catalog_id}: EXCEPTION — ${err.message}`)
        continue
      }
      if (outcome.usage) {
        totalPromptTokens += outcome.usage.promptTokenCount || 0
        totalCandidateTokens += outcome.usage.candidatesTokenCount || 0
      }
      if (outcome.error) {
        exceptions++
        rows.push({ catalog_id: target.catalog_id, label: outcome.label, error: outcome.error })
        console.error(`catalog_id=${target.catalog_id} (${outcome.label}): ${outcome.error}`)
        continue
      }

      const { json, groundedSource, fieldsToWrite, label } = outcome
      rows.push({
        catalog_id: target.catalog_id,
        label,
        continuous: json.continuous,
        source_kind: groundedSource.kind,
        source_by: groundedSource.by,
        ref: groundedSource.ref || '',
        fields: Object.keys(fieldsToWrite).join(',') || '(nothing new)',
      })

      if (APPLY && Object.keys(fieldsToWrite).length > 0) {
        await db.collection('supplement_knowledge').findOneAndUpdate(
          { catalog_id: target.catalog_id },
          { $set: fieldsToWrite },
          { upsert: true }
        )
      }
    }

    console.log('\n=== Fill report ===')
    console.table(rows)
    console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN (no writes)'}: ${rows.length - exceptions}/${toFill.length} classified, ${exceptions} exceptions`)
    console.log(`Gemini usage this run: prompt=${totalPromptTokens} candidates=${totalCandidateTokens} (per-call usage logged above if available)`)

    if (APPLY) {
      const finalCount = await db.collection('supplement_knowledge').countDocuments({ continuous: { $exists: true } })
      console.log(`\nPost-apply: db.supplement_knowledge.countDocuments({continuous:{$exists:true}}) = ${finalCount}`)
    }
  } finally {
    await client.close()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err)
    process.exit(1)
  })
}

module.exports = { buildTargets, needsFill, findInvariantViolations, supplementLabel, classifyOne }
