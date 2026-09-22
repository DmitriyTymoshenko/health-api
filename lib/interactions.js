'use strict'

const { normalizeNutrientKey } = require('./nutrient-sum')

/**
 * #1489 (stage E of #1485, design E5): pairwise same-slot conflict/synergy
 * READ engine. `knowledge.interactions[]` (stage F / #1490's data — 0/14
 * docs filled live as of 22.09, this is the engine that will read it once
 * that lands) is shaped `{with, kind: 'conflict'|'synergy', rule, source}`,
 * where `with` matches either another item's `catalog_id` (number, or a
 * numeric string) or a `nutrient_key` present in the OTHER item's
 * `active_ingredients[]`.
 *
 * A pair only produces a result when BOTH items share the same `schedule`
 * slot — different slots means no real co-ingestion, so those pairs are
 * silently dropped (not returned with `same_slot:false`), matching the E5
 * acceptance directly: "Zinc перенесений у evening -> 0" (not "1 entry with
 * same_slot:false").
 *
 * @param {object[]} activeItems supplement_catalog docs (active !== false)
 * @param {Map<number, object>} knowledgeById catalog_id -> supplement_knowledge doc
 * @returns {object[]} [{a, b, kind, rule, source, same_slot: true}, ...]
 */
function checkStack(activeItems, knowledgeById) {
  const results = []

  for (let i = 0; i < activeItems.length; i++) {
    for (let j = i + 1; j < activeItems.length; j++) {
      const a = activeItems[i]
      const b = activeItems[j]
      if (!a.schedule || !b.schedule || a.schedule !== b.schedule) continue

      const found = findInteraction(a, b, knowledgeById) || findInteraction(b, a, knowledgeById)
      if (found) {
        results.push({ a: a.id, b: b.id, kind: found.kind, rule: found.rule, source: found.source, same_slot: true })
      }
    }
  }

  return results
}

/** Looks for a rule on `item.knowledge.interactions[]` whose `with` matches `other`. */
function findInteraction(item, other, knowledgeById) {
  const knowledge = knowledgeById.get(item.id)
  if (!knowledge || !Array.isArray(knowledge.interactions)) return null

  const otherKnowledge = knowledgeById.get(other.id)
  const otherIngredients = (otherKnowledge && otherKnowledge.active_ingredients) || []
  const otherNutrientKeys = new Set(
    otherIngredients.map((ing) => ing.nutrient_key || normalizeNutrientKey(ing.name))
  )

  for (const rule of knowledge.interactions) {
    if (!rule || rule.with === undefined || rule.with === null) continue
    const matchesCatalogId = Number(rule.with) === other.id
    const matchesNutrient = otherNutrientKeys.has(String(rule.with))
    if (matchesCatalogId || matchesNutrient) return rule
  }

  return null
}

module.exports = { checkStack }
