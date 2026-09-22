'use strict'

// #1487 (stage B of #1485, design D5): pure logic for
// scripts/fill-supplement-knowledge-1485.js, split out so it's unit-testable
// without a live Gemini call or a Mongo connection (same rationale as every
// other lib/ file in this repo — #966/#988 lesson, one definition, imported
// by both the script and its test).

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    continuous: { type: 'BOOLEAN' },
    cycle: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        duration_weeks: { type: 'INTEGER' },
        pause_weeks: { type: 'INTEGER' },
      },
      required: ['duration_weeks', 'pause_weeks'],
    },
    verdict: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', enum: ['confirms', 'neutral', 'against', 'not_covered'] },
        by: { type: 'STRING', enum: ['koliada', 'external'] },
        ref: { type: 'STRING' },
        quote: { type: 'STRING' },
      },
      required: ['kind', 'by', 'ref'],
    },
    purchase_url: { type: 'STRING', nullable: true },
  },
  required: ['continuous', 'cycle', 'verdict'],
}

function buildPrompt(supplementLabel, corpusText) {
  return `You are assisting a supplement-tracking app. You are given (1) a nutrition-course corpus (Ukrainian, distilled from Oleksandr Koliada's course) and (2) the name of a dietary supplement.

Determine whether this supplement is safe to take CONTINUOUSLY (no scheduled breaks) or whether it should be taken in CYCLES (a period of daily use followed by a rest/pause period). If the corpus discusses this supplement or its active ingredient directly, cite it precisely (a real "Lesson N" or "урок N" reference AND a verbatim quote copied character-for-character from the corpus below — do not paraphrase). If the corpus does not cover it, you may cite a reputable external source (examine.com, cochranelibrary.com, ods.od.nih.gov, or pubmed.ncbi.nlm.nih.gov) by URL, or set verdict.kind to "not_covered" if you are not confident.

Supplement: ${supplementLabel}

Respond with ONLY the JSON object matching the schema. Do not fabricate a quote — an ungrounded citation is worse than admitting "not_covered".

=== CORPUS START ===
${corpusText}
=== CORPUS END ===`
}

// #1487 bug found + fixed during the live --apply dry-run (this same task):
// the Gemini RESPONSE_SCHEMA marks `cycle` `nullable:true` UNCONDITIONALLY
// (Gemini's structured-output schema has no way to express "nullable only
// when continuous=false"), so the model CAN legally return
// `{continuous:false, cycle:null}` — a self-contradiction. The first version
// of this function trusted `llmResult.cycle` blindly and wrote
// `{cycle:{source:...}}` with NO `duration_weeks`/`pause_weeks` for
// catalog_id 12 (Beta-Alanine) on the live DB — silently violating the exact
// `continuous:false requires cycle.duration_weeks>=1` invariant
// `lib/validate.js::validateKnowledgeCycleInvariant` enforces at the HTTP
// layer (this script writes to Mongo directly, so that middleware never saw
// it). Caught by a live-verify `mongosh` read after --apply, not by any
// test — the deterministic-input unit tests below all passed because none
// of them exercised the "LLM asked for continuous:false but returned an
// unusable cycle" combination. Fixed live data with a follow-up run after
// this fix (see closing comment). Now enforced: `continuous:false` with an
// invalid/missing cycle throws instead of writing a broken doc; the caller
// (scripts/fill-supplement-knowledge-1485.js) catches it and reports the
// row as an exception, exactly like a Gemini/network failure — the item
// stays unfilled and is retried on the next run, never left half-written.
function isValidCycleObject(cycle) {
  return !!cycle && typeof cycle === 'object' && Number.isInteger(cycle.duration_weeks) && cycle.duration_weeks >= 1
}

/**
 * Decide which top-level (or single-level nested `cycle.source`) fields are
 * actually MISSING on the existing knowledge doc and therefore safe to
 * write — never overwrites a field an owner (or a prior run) already set.
 * `llmResult` = { continuous, cycle } (already schema-validated by the
 * caller); `groundedSource` = the OUTPUT of lib/koliada-validate.js's
 * validateVerdict() (already downgraded to not_covered if ungrounded).
 *
 * Returns a flat object of dot-path keys suitable for a single Mongo `$set`
 * (e.g. `{ continuous: false, cycle: {...}, 'cycle.source': {...} }`), or
 * `{}` if there is nothing new to write (every relevant field already set).
 * Throws if the LLM claimed `continuous:false` but returned no usable cycle
 * — see the bug note above; this is a genuine "retry needed", not a case
 * to silently paper over.
 */
function computeFieldsToWrite(existing, llmResult, groundedSource, purchaseUrl) {
  const set = {}
  const doc = existing || {}

  // #1488 bug found + fixed live (GET /catalog/recommendations verification,
  // same session): catalog_id 3 already had a real PRE-EXISTING cycle
  // ({duration_weeks:8, pause_weeks:4}, seeded long before this stage —
  // `doc.continuous` was undefined) — the first version of this branch only
  // checked `doc.continuous === undefined` and then trusted the LLM's
  // `continuous` verdict outright, writing `continuous:true` while leaving
  // the pre-existing non-null `cycle` object untouched (only nulled `cycle`
  // when `doc.cycle === undefined`, which was false here). Result: a live
  // doc with `continuous:true` AND a real `cycle` object — the EXACT
  // invariant `lib/validate.js::validateKnowledgeCycleInvariant` forbids at
  // the HTTP layer, same bug class as the cycle:null one already documented
  // above, just the mirror-image direction. A pre-existing real cycle
  // object is stronger evidence than a fresh LLM classification (it's
  // either owner-entered or an established D4-seeded fact) — it wins
  // outright, `continuous` is forced to `false` regardless of what the LLM
  // said, and only the missing `cycle.source` sub-field is added.
  const hasPreexistingCycle = doc.continuous === undefined && isValidCycleObject(doc.cycle)

  if (hasPreexistingCycle) {
    set.continuous = false
    if (doc.cycle.source === undefined) set['cycle.source'] = groundedSource
  } else if (doc.continuous === undefined) {
    if (llmResult.continuous) {
      set.continuous = true
      if (doc.cycle === undefined) set.cycle = null
      if (doc.continuous_source === undefined) set.continuous_source = groundedSource
    } else {
      if (!isValidCycleObject(llmResult.cycle)) {
        throw new Error(`continuous:false requires a valid cycle {duration_weeks>=1} — LLM returned ${JSON.stringify(llmResult.cycle)}`)
      }
      set.continuous = false
      if (doc.cycle === undefined) set.cycle = { ...llmResult.cycle, source: groundedSource }
    }
  } else if (doc.continuous === false && !isValidCycleObject(doc.cycle)) {
    // REPAIR path: continuous is already set to false, but the stored cycle
    // is malformed (missing/invalid duration_weeks) — this state can only
    // come from a prior buggy write (the #1487 bug this file's header
    // documents) or an incomplete manual edit; the HTTP validator
    // (lib/validate.js::validateKnowledgeCycleInvariant) forbids a NEW write
    // in this shape, so it is never a legitimate "owner chose no cycle"
    // state worth preserving. Safe to replace the whole cycle object — this
    // is fixing a bug artifact, not overwriting real data.
    if (!isValidCycleObject(llmResult.cycle)) {
      throw new Error(`continuous:false requires a valid cycle {duration_weeks>=1} — LLM returned ${JSON.stringify(llmResult.cycle)}`)
    }
    set.cycle = { ...llmResult.cycle, source: groundedSource }
  } else if (isValidCycleObject(doc.cycle) && doc.cycle.source === undefined) {
    // Existing real cycle (e.g. catalog_id 3's pre-existing {duration_weeks,
    // pause_weeks} with no `source`, per D4) — patch ONLY the missing
    // sub-field, never touch duration_weeks/pause_weeks that are already set.
    set['cycle.source'] = groundedSource
  }

  if (doc.purchase_url === undefined && purchaseUrl) {
    set.purchase_url = purchaseUrl
    set.purchase_verified = false
  }

  return set
}

module.exports = { RESPONSE_SCHEMA, buildPrompt, computeFieldsToWrite, isValidCycleObject }
