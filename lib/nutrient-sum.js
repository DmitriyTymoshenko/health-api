'use strict'

const { UPPER_LIMITS } = require('../data/upper-limits')
const { resolveServingsPerDay } = require('./servings')

// #1489 (stage E of #1485, design E4): synonym map from a live
// active_ingredients[].name string (verified against the actual 12/14
// supplement_knowledge docs that have ingredients today — see
// nutrient-sum.test.ts's live fixture) to the canonical `nutrient_key` used
// by data/upper-limits.js. Matched AFTER stripping any "(...)" qualifier
// ("Zinc (aspartate)" -> "zinc", "Magnesium (aspartate)" -> "magnesium
// supplemental") — the salt/form doesn't change which UL row applies.
const NUTRIENT_SYNONYMS = {
  'vitamin d3': 'vitamin_d',
  'vitamin d': 'vitamin_d',
  'vitamin c': 'vitamin_c',
  'vitamin b6': 'vitamin_b6',
  'vitamin b3': 'niacin',
  niacin: 'niacin',
  'vitamin a': 'vitamin_a',
  'vitamin e': 'vitamin_e',
  zinc: 'zinc',
  magnesium: 'magnesium_supplemental',
  iron: 'iron',
  selenium: 'selenium',
  calcium: 'calcium',
  folate: 'folate_supplemental',
  'folic acid': 'folate_supplemental',
  'vitamin b9': 'folate_supplemental',
  choline: 'choline',
  'choline bitartrate': 'choline',
  'epa+dha': 'omega3_epa_dha',
  epa: 'omega3_epa_dha',
  dha: 'omega3_epa_dha',
  'omega-3': 'omega3_epa_dha',
  'omega 3': 'omega3_epa_dha',
  creatine: 'creatine',
  'creatine hcl': 'creatine',
  'creatine monohydrate': 'creatine',
  'beta-alanine': 'beta_alanine',
  'beta alanine': 'beta_alanine',
  'essential amino acids': 'eaa',
  eaa: 'eaa',
  'psyllium husk': 'psyllium',
  psyllium: 'psyllium',
  'withania somnifera root extract': 'ashwagandha',
  ashwagandha: 'ashwagandha',
  "lion's mane": 'lions_mane',
  'lions mane': 'lions_mane',
  ginseng: 'ginseng',
  'asian ginseng': 'ginseng',
}

/**
 * @param {string} name raw active_ingredients[].name from supplement_knowledge
 * @returns {string} a stable grouping key — a UPPER_LIMITS key when a
 *   synonym matches, otherwise a generic slug (still stable, just has no UL
 *   row — nutrient-sum.js reports `ul: null` for it, per E4 acceptance: "an
 *   unknown ingredient with no UL -> a row with ul:null, no warning").
 */
function normalizeNutrientKey(name) {
  if (!name || typeof name !== 'string') return 'unknown'
  const stripped = name.replace(/\([^)]*\)/g, '').trim().toLowerCase()
  if (NUTRIENT_SYNONYMS[stripped]) return NUTRIENT_SYNONYMS[stripped]
  const slug = stripped.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return slug || 'unknown'
}

// мг/мкг/ME are the Cyrillic units seen in a couple of live docs (e.g.
// catalog id 13's "мг") — normalized to the Latin unit UPPER_LIMITS uses so
// a same-nutrient comparison across a Cyrillic-labeled and Latin-labeled
// source doesn't spuriously trip unit_conflict.
function normalizeUnit(unit) {
  if (!unit) return null
  const u = String(unit).trim().toLowerCase()
  if (u === 'мг') return 'mg'
  if (u === 'мкг') return 'mcg'
  if (u === 'ме' || u === 'iu') return 'IU'
  if (u === 'mg') return 'mg'
  if (u === 'mcg' || u === 'µg' || u === 'ug') return 'mcg'
  return String(unit).trim()
}

// Additive #2038 contract: the reference and arithmetic comparison describe
// this recorded supplement stack, not total dietary exposure or personal safety.
function referenceFor(row) {
  const meta = row && row.reference || {}
  const knownText = (value) => typeof value === 'string' && value.trim() ? value : 'unknown'
  return {
    value: row ? row.ul : null,
    unit: row ? row.unit : null,
    source_url: row && row.source_url || null,
    note: row && row.note || null,
    kind: ['formal_ul', 'other_reference'].includes(meta.kind) ? meta.kind : 'unknown',
    scope: knownText(meta.scope),
    population: knownText(meta.population),
    jurisdiction: knownText(meta.jurisdiction),
    provenance: meta.provenance ? { ...meta.provenance } : {
      status: 'unverified', checked_at: null, retrieved_at: null, ledger: null, retrieval_url: null,
    },
  }
}

function compareReference(group, reference) {
  const reasons = []
  if (group.unit_conflict) reasons.push('unit_conflict')
  if (!Number.isFinite(group.total)) reasons.push('invalid_total')
  if (!Number.isFinite(reference.value)) reasons.push('no_numeric_reference')
  if (!group.unit || !reference.unit || group.unit !== reference.unit) reasons.push('unit_mismatch')
  if (reference.kind === 'unknown') reasons.push('reference_kind_unknown')
  if ([reference.scope, reference.population, reference.jurisdiction].includes('unknown')) reasons.push('reference_scope_unknown')
  if (!reference.source_url || !reference.note || reference.provenance.status !== 'source_supported') reasons.push('source_unverified')
  return {
    status: reasons.length ? 'not_comparable' : group.total > reference.value ? 'above' : 'not_above',
    reasons,
    basis: 'recorded_supplement_stack',
    applicability: 'not_assessed',
  }
}

/**
 * @param {object[]} activeItems supplement_catalog docs (already filtered
 *   to active !== false)
 * @param {Map<number, object>} knowledgeById catalog_id -> supplement_knowledge doc
 * @returns {object[]} one row per nutrient_key found across the stack, sorted
 *   by nutrient_key: { nutrient_key, total, unit, sources, ul, over_ul,
 *   multi_source, unit_conflict }
 */
function sumStack(activeItems, knowledgeById) {
  const groups = new Map()

  for (const item of activeItems) {
    const knowledge = knowledgeById.get(item.id)
    const ingredients = knowledge && Array.isArray(knowledge.active_ingredients) ? knowledge.active_ingredients : []
    const servingsPerDay = resolveServingsPerDay(item)

    for (const ing of ingredients) {
      // `Number(null)` is 0 (finite!) — must reject null/undefined BEFORE
      // the Number() cast, or an RDA-only placeholder ({amount_per_dose:
      // null}, e.g. live catalog id 4's B-vitamin rows) silently counts as
      // a real 0-amount source instead of being skipped.
      if (ing.amount_per_dose === null || ing.amount_per_dose === undefined) continue
      const rawAmount = Number(ing.amount_per_dose)
      if (!Number.isFinite(rawAmount)) continue

      const key = ing.nutrient_key || normalizeNutrientKey(ing.name)
      const amount = rawAmount * servingsPerDay
      const unit = normalizeUnit(ing.unit)
      const source = { catalog_id: item.id, short_name: item.short_name || item.name, amount }

      if (!groups.has(key)) {
        groups.set(key, { unit, total: amount, sources: [source], unit_conflict: false })
      } else {
        const g = groups.get(key)
        if (g.unit !== unit) {
          // A same-nutrient_key group disagreeing on unit (e.g. IU vs mcg)
          // cannot be safely summed — report the conflict instead of a
          // silently wrong number.
          g.unit_conflict = true
        } else {
          g.total += amount
        }
        g.sources.push(source)
      }
    }
  }

  const rows = []
  for (const [nutrient_key, g] of groups) {
    const ulRow = UPPER_LIMITS[nutrient_key] || null
    // over_ul only makes sense when the summed unit matches the UL table's
    // own unit — a mismatched or conflicted unit can't be safely compared.
    const canCompare = !g.unit_conflict && ulRow && ulRow.ul != null && ulRow.unit === g.unit
    const reference = referenceFor(ulRow)
    rows.push({
      nutrient_key,
      total: g.unit_conflict ? null : g.total,
      unit: g.unit_conflict ? null : g.unit,
      sources: g.sources,
      ul: ulRow ? ulRow.ul : null,
      // Legacy arithmetic flag retained for older clients. false is NOT safety
      // or proof of comparability; new consumers must use comparison.status.
      over_ul: canCompare ? g.total > ulRow.ul : false,
      reference,
      comparison: compareReference(g, reference),
      multi_source: g.sources.length >= 2,
      unit_conflict: g.unit_conflict,
    })
  }

  return rows.sort((a, b) => a.nutrient_key.localeCompare(b.nutrient_key))
}

module.exports = { sumStack, normalizeNutrientKey }
