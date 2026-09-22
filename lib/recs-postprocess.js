'use strict'

// #1488 (stage C of #1485): deterministic postprocessing of the LLM's raw
// recommendation candidates — same canon lesson as lib/koliada-validate.js
// ("make the LLM fill a declarative contract, validate it deterministically,
// never trust the model's own claim"). This is where the design rules 1-6
// from the ticket are enforced regardless of what the LLM actually said.

const { validateVerdict } = require('./koliada-validate')

// #1487/#1426/#1427 lesson: normalize both sides to a comparable token set
// before matching supplement names across sources (LLM-suggested name vs
// stored short_name/name). Ported VERBATIM from
// health-dashboard/src/pages/Supplements.jsx's own `normalizeForMatch`
// (cross-repo — no shared package, same reasoning as lib/cycle-status.js's
// documented duplicate) so a name that matches on the dashboard side matches
// here too. Do not fork the algorithm if it changes on one side.
function normalizeForMatch(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/g, '_').replace(/^_+|_+$/g, '')
}

function findStackMatch(name, activeStack) {
  const needle = normalizeForMatch(name)
  if (!needle) return null
  return activeStack.find(s => normalizeForMatch(s.short_name || s.name) === needle) || null
}

const STALE_LAB_MAX_AGE_DAYS = 30

/**
 * Process ONE raw LLM candidate item into either a kept recommendation or a
 * warning (or neither, for silent drops). Never throws.
 *
 * rawItem: { key, name, reason, source: 'lab'|'whoop'|'koliada'|'external',
 *            lab: {marker,value,unit,test_date,age_days}|null, verdict: {...},
 *            suggested: {...} }
 */
function postprocessOne(rawItem, { activeStack, corpusText }) {
  const grounded = validateVerdict(rawItem?.verdict, corpusText)
  const stackMatch = findStackMatch(rawItem?.name, activeStack)

  // Rule 2: kind:'against' NEVER appears in recommendations. If it targets a
  // supplement already in the stack, it becomes a warning the owner can act
  // on; negative evidence about something NOT even in the stack has no
  // supplement_id to attach a warning to — nothing to act on, just drop it.
  if (grounded.kind === 'against') {
    if (stackMatch) {
      return { rec: null, warning: { type: 'against', supplement_id: stackMatch.id, name: stackMatch.short_name || stackMatch.name, verdict: grounded } }
    }
    return { rec: null, warning: null }
  }

  // Rule 3: a lab-sourced candidate is allowed ONLY when its OWN age_days is
  // fresh — regardless of what the LLM itself claimed about freshness. A
  // missing/non-numeric age_days is treated as stale (fail closed).
  if (rawItem?.source === 'lab') {
    const ageDays = rawItem?.lab?.age_days
    const isFresh = typeof ageDays === 'number' && ageDays <= STALE_LAB_MAX_AGE_DAYS
    if (!isFresh) {
      return {
        rec: null,
        warning: { type: 'stale_lab', marker: rawItem?.lab?.marker || rawItem?.key, age_days: ageDays, test_date: rawItem?.lab?.test_date || null },
      }
    }
  }

  // Rule 5: dedupe against the active stack — already taking it, don't
  // suggest it again. No warning; this is not an error condition.
  if (stackMatch) {
    return { rec: null, warning: null }
  }

  // `suggested.knowledge.continuous_source` must reflect the GROUNDED
  // verdict (post-validateVerdict), not whatever the LLM claimed — the
  // whole point of grounding is that a fabricated koliada citation never
  // survives into a stored knowledge doc, including via this path (D6/D9's
  // `POST /catalog {knowledge}` autocycle wiring writes this field verbatim).
  const rec = { ...rawItem, verdict: grounded }
  if (rec.suggested) {
    rec.suggested = { ...rec.suggested, knowledge: { ...rec.suggested.knowledge, continuous_source: grounded } }
  }
  return { rec, warning: null }
}

/**
 * Process a full batch of raw LLM candidates into the final
 * {recommendations, warnings} shape of the GET /recommendations contract.
 *
 * knowledgeByCatalogId: Map<catalog_id, knowledgeDoc> — used ONLY to compute
 * `stale_lab.affects` (Rule 4: only continuous:false stack items are listed
 * as affected by a stale marker — a continuous supplement's dose doesn't
 * hinge on a specific lab re-check the way a cycle-scheduling decision does).
 */
function postprocessRecommendations(rawItems, { activeStack, knowledgeByCatalogId, corpusText }) {
  const recommendations = []
  const staleLabByMarker = new Map()
  const againstWarnings = []

  for (const rawItem of Array.isArray(rawItems) ? rawItems : []) {
    const { rec, warning } = postprocessOne(rawItem, { activeStack, corpusText })
    if (rec) recommendations.push(rec)
    if (warning?.type === 'stale_lab') {
      const key = warning.marker
      if (!staleLabByMarker.has(key)) {
        staleLabByMarker.set(key, { type: 'stale_lab', marker: warning.marker, age_days: warning.age_days, test_date: warning.test_date, affects: [] })
      }
    } else if (warning?.type === 'against') {
      againstWarnings.push(warning)
    }
  }

  // Rule 4: affects = active, continuous:false stack items — computed once
  // per distinct stale marker, not per dropped candidate.
  for (const staleEntry of staleLabByMarker.values()) {
    staleEntry.affects = activeStack
      .filter(s => knowledgeByCatalogId.get(s.id)?.continuous === false)
      .map(s => s.short_name || s.name)
  }

  return {
    recommendations,
    warnings: [...staleLabByMarker.values(), ...againstWarnings],
  }
}

module.exports = { normalizeForMatch, findStackMatch, postprocessOne, postprocessRecommendations, STALE_LAB_MAX_AGE_DAYS }
