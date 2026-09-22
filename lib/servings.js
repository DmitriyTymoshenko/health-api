'use strict'

/**
 * #1489 (stage E of #1485, design E1): derives `servings_per_day` for a
 * catalog item when the caller doesn't pass one explicitly. Heuristic is
 * DELIBERATELY narrow: it counts SLOTS in `schedule`, never parses the dose
 * text. "2-3 капс (~3г)" is still ONE serving — the capsule-count range
 * describes how many capsules make up a single dose, not how many times a
 * day the dose is taken. Multiplying by the dose-range would double-count
 * (порція ≠ капсула — a serving/dose is not the same thing as a capsule).
 *
 * `schedule` today is a single enum value (morning|evening|pre_meal|
 * pre_workout — one slot per catalog item, see routes/supplement_catalog.js's
 * DEFAULT_SUPPLEMENTS). This function still handles a comma-separated
 * multi-slot schedule string (e.g. "morning,evening") for forward
 * compatibility — a supplement genuinely taken twice a day would carry 2
 * slots and derive 2 servings/day — even though no live item uses that shape
 * yet (verified live 22.09: all 11 catalog items have a single schedule
 * value, so every one of them derives to 1 — see servings.test.ts's live
 * fixture).
 *
 * `dose` is accepted (not used) so the signature stays stable if a future
 * stage adds dose-text parsing on top of the slot count — kept explicit in
 * the design (E1) rather than silently dropped.
 *
 * @param {string} dose free-text dose description (unused — see above)
 * @param {string} schedule e.g. "morning" or "morning,evening"
 * @returns {number} servings per day, default 1
 */
function parseServingsPerDay(dose, schedule) {
  if (!schedule || typeof schedule !== 'string') return 1
  const slots = schedule
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return slots.length > 0 ? slots.length : 1
}

/**
 * #1489 design note (F1 equal-or-stronger substitution, documented per task
 * constraints): E1's hypothesis text says "деривація при POST/PUT, якщо
 * поле не передане" — but this task's explicit constraint forbids touching
 * `routes/supplement_catalog.js` outside the one PATCH /:id/stock edit (Lucas
 * is live on stage C in the same file). Wiring the derivation into POST/PUT
 * there isn't needed for correctness anyway: PUT /:id already does a generic
 * `$set` over the request body, so `PUT {servings_per_day: 2}` already
 * persists an explicit value with ZERO code change — "always editable
 * through PUT" holds true as-is. The derivation instead lives HERE, read by
 * every consumer (`lib/stock.js`, `lib/nutrient-sum.js`, the stack-check
 * route) via this single resolver — functionally identical outcome (an item
 * with no stored `servings_per_day` behaves as if it had the derived value)
 * without touching the hot POST/PUT file or needing a backfill migration for
 * the 11 live items that currently have `servings_per_day` unset.
 *
 * @param {{servings_per_day?: number, dose?: string, schedule?: string}} item
 * @returns {number}
 */
function resolveServingsPerDay(item) {
  const stored = Number(item.servings_per_day)
  if (Number.isFinite(stored) && stored > 0) return stored
  return parseServingsPerDay(item.dose, item.schedule)
}

module.exports = { parseServingsPerDay, resolveServingsPerDay }
