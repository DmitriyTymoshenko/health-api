'use strict'
// #1729 — pure helpers for POST /api/nutrition/log-food (one-call food logging for Lisa).
// No DB access here: matching is done over candidate docs the route already fetched,
// so it is unit-testable without Mongo.
const crypto = require('crypto')

const MEALS = ['breakfast', 'lunch', 'snack', 'dinner']

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-яіїєґ]+/g, ' ').trim()
}
function tokens(s) { return norm(s).split(' ').filter(Boolean) }

// a query token matches a doc token if equal, or one is a prefix of the other (>=4 chars: стем «сирник»/«сирники»)
function tokMatch(q, d) {
  if (q === d) return true
  const m = Math.min(q.length, d.length)
  return m >= 4 && (d.startsWith(q) || q.startsWith(d))
}

function docNames(doc) {
  return [doc.name_ua, doc.name, ...(Array.isArray(doc.aliases) ? doc.aliases : [])].filter(Boolean)
}

// 0..100. >=ACCEPT_SCORE = usable match.
const ACCEPT_SCORE = 60
function scoreDoc(queryTokens, brandTokens, doc) {
  let best = 0
  for (const name of docNames(doc)) {
    const dt = tokens(name)
    if (!dt.length) continue
    if (norm(name) === queryTokens.join(' ')) { best = Math.max(best, 100); continue }
    const hit = queryTokens.filter((q) => dt.some((d) => tokMatch(q, d))).length
    if (hit === 0) continue
    const cover = hit / queryTokens.length
    // penalize docs that are much longer than the query (prefer the tighter match)
    const tight = Math.min(1, queryTokens.length / dt.length)
    best = Math.max(best, Math.round(cover * 70 + tight * 25))
    if (cover < 1) best = Math.min(best, 55) // partial token coverage never auto-accepts
  }
  if (brandTokens.length) {
    const hay = tokens([doc.brand, doc.name, doc.name_ua].filter(Boolean).join(' '))
    const ok = brandTokens.every((b) => hay.some((d) => tokMatch(b, d)))
    if (!ok) return 0 // brand given but not matched — different product, different macros
  }
  return best
}

function pickMatch(item, candidates) {
  const qt = tokens(item.name)
  const bt = item.brand ? tokens(item.brand) : []
  if (!qt.length) return { doc: null, candidates: [] }
  const scored = candidates
    .map((d) => ({ d, s: scoreDoc(qt, bt, d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.d.use_count || 0) - (a.d.use_count || 0))
  const top = scored[0]
  return {
    doc: top && top.s >= ACCEPT_SCORE ? top.d : null,
    score: top ? top.s : 0,
    candidates: scored.slice(0, 3).map((x) => x.d.name_ua || x.d.name),
  }
}

// Mongo candidate filter for one item: OR over its tokens (and brand tokens), regex-escaped.
function candidateFilter(item) {
  const toks = [...tokens(item.name), ...(item.brand ? tokens(item.brand) : [])].filter((t) => t.length >= 2)
  const stems = [...new Set(toks.map((t) => (t.length > 5 ? t.slice(0, t.length - 1) : t)))]
  if (!stems.length) return null
  const ors = []
  for (const t of stems) {
    const re = { $regex: escapeRegex(t), $options: 'i' }
    ors.push({ name: re }, { name_ua: re }, { brand: re }, { aliases: re })
  }
  return { $or: ors }
}

// grams from {grams} | {portion} (number of servings, or "150г") | default 1 serving.
function resolveGrams(item, doc) {
  const g = Number(item.grams)
  if (Number.isFinite(g) && g > 0) return { grams: g }
  const serving = Number(doc && doc.serving_size_g)
  if (item.portion !== undefined && item.portion !== null && String(item.portion).trim() !== '') {
    const p = String(item.portion).trim().toLowerCase().replace(',', '.')
    const num = parseFloat(p)
    if (Number.isFinite(num) && num > 0) {
      if (/(^|\d)\s*(г|гр|g|gr)\b/.test(p)) return { grams: num }
      if (serving > 0) return { grams: Math.round(num * serving * 10) / 10 }
      return { error: 'portion_without_serving_size' }
    }
  }
  if (serving > 0) return { grams: serving }
  return { error: 'no_amount' }
}

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10

function buildLogDoc(doc, grams, { date, meal_type }) {
  const k = grams / 100
  const per = (f) => (Number(doc[f]) || 0) * k
  return {
    date,
    meal_type,
    food_name: doc.name_ua || doc.name,
    amount_g: grams,
    kcal: r1(per('kcal_per_100g') || per('calories_per_100g')),
    protein_g: r1(per('protein_per_100g')),
    fat_g: r1(per('fat_per_100g')),
    carbs_g: r1(per('carbs_per_100g')),
    sugar_g: r1(per('sugar_per_100g')),
    fiber_g: r1(per('fiber_per_100g')),
    sat_fat_g: r1(per('sat_fat_per_100g')),
    source: 'food_log',
    library_id: doc._id,
  }
}

// Same date+meal+product+grams (or same caller request_id) within DEDUPE_WINDOW_MS = a retried message.
const DEDUPE_WINDOW_MS = 10 * 60 * 1000
function idemKey({ date, meal_type, name, grams, request_id }) {
  const base = request_id ? `rid|${request_id}|${norm(name)}` : `${date}|${meal_type}|${norm(name)}|${grams}`
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 20)
}

function mealByHour(now = new Date()) {
  const h = parseInt(now.toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }), 10)
  if (h < 11) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 18) return 'snack'
  return 'dinner'
}

module.exports = { MEALS, ACCEPT_SCORE, DEDUPE_WINDOW_MS, norm, tokens, pickMatch, candidateFilter, resolveGrams, buildLogDoc, idemKey, mealByHour }
