'use strict'

/**
 * Exercise-name alias layer (#1692 п.2). `exercises_library.aliases: string[]` holds
 * former/duplicate names that were merged into the canonical doc. Every write path
 * (POST /, PUT /:id, POST /log-text) normalizes incoming names to the canonical one
 * BEFORE library registration, so a dictated variant ("Тяга блоку широким хватом")
 * never re-creates a duplicate library entry.
 */

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {import('mongodb').Collection} libCol
 * @param {string[]} names
 * @returns {Promise<Map<string,string>>} input name -> canonical name (only for names that are aliases)
 */
async function resolveAliases(libCol, names) {
  const map = new Map()
  for (const name of new Set((names || []).filter(n => typeof n === 'string' && n.trim()))) {
    const re = new RegExp(`^${esc(name.trim())}$`, 'i')
    // An exact (case-insensitive) canonical name always wins over an alias.
    if (await libCol.findOne({ name: { $regex: re } }, { projection: { _id: 1 } })) continue
    const doc = await libCol.findOne({ aliases: { $regex: re } }, { projection: { name: 1 } })
    if (doc && doc.name !== name) map.set(name, doc.name)
  }
  return map
}

/** Returns a new exercises[] with alias names replaced by canonical ones. */
async function canonicalizeExercises(libCol, exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) return exercises
  const map = await resolveAliases(libCol, exercises.map(e => e && e.name))
  if (map.size === 0) return exercises
  return exercises.map(e => (e && map.has(e.name) ? { ...e, name: map.get(e.name) } : e))
}

module.exports = { resolveAliases, canonicalizeExercises }
