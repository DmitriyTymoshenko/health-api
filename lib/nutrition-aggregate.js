'use strict'

/**
 * Sums a single nutrition_log document into its macro contribution for a day.
 *
 * TWO on-disk shapes are live in `nutrition_log` (task #862, measured on the
 * 2026-07-27 fixture day):
 *  - MODERN (flat):  { kcal, protein_g, carbs_g, fat_g, sugar_g, sat_fat_g, fiber_g, ... }
 *  - LEGACY (nested, pre photo-recognition quick-log UI):
 *      { items: [{ name, grams, kcal, protein, fat, carbs }] }
 *    Note the nested item fields have NO `_g` suffix (`protein`, not `protein_g`) —
 *    a different vocabulary than the flat/modern format. Legacy nested items never
 *    carry sugar/sat_fat/fiber at all (measured on all 5 legacy records for
 *    2026-07-27) — those three stay top-level-only, unchanged by this fix; the
 *    existing *_incomplete flags already cover a day missing them.
 *
 * Before this fix, `summaryHandler` read ONLY the flat top-level fields, so every
 * legacy nested-items record silently contributed 0 kcal/protein/carbs/fat to the
 * day total. Measured live: 2026-07-27 summed to 525 kcal (later grew to 621 once a
 * 3rd flat record landed) against the real 2104/2200 kcal across the day's actual
 * meals — a >70% undercount on a day with legacy records.
 *
 * @param {Record<string, unknown>} doc
 * @returns {{kcal:number, protein_g:number, carbs_g:number, fat_g:number}}
 */
function macroContribution(doc) {
  const nested = Array.isArray(doc.items) ? doc.items : null
  const nestedSum = nested
    ? nested.reduce(
        (acc, it) => {
          acc.kcal += it.kcal || 0
          acc.protein_g += it.protein || 0
          acc.carbs_g += it.carbs || 0
          acc.fat_g += it.fat || 0
          return acc
        },
        { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
      )
    : null

  return {
    // A record MAY carry both a nested items[] array AND a top-level field added
    // later (e.g. sat_fat_g back-filled post-hoc) — top-level always wins per field.
    kcal: doc.kcal ?? doc.calories ?? (nestedSum ? nestedSum.kcal : 0),
    protein_g: doc.protein_g ?? (nestedSum ? nestedSum.protein_g : 0),
    carbs_g: doc.carbs_g ?? (nestedSum ? nestedSum.carbs_g : 0),
    fat_g: doc.fat_g ?? (nestedSum ? nestedSum.fat_g : 0),
  }
}

/**
 * Aggregates a day's nutrition_log documents into the /nutrition/summary shape
 * (minus the kcal-target fields — summaryHandler attaches sat_fat_goal_g /
 * sugar_goal_g afterwards, since those need the personal_profile document, which
 * this function has no business fetching).
 *
 * This is the SINGLE implementation summaryHandler (routes/nutrition.js) calls —
 * unit tests call it too, rather than re-implementing the reduce in the test file
 * (the "mirror test" class flagged in #953 QA: a test that duplicates the logic it's
 * meant to guard proves nothing about the real code path).
 *
 * @param {string} date
 * @param {Array<Record<string, unknown>>} docs
 */
function aggregateDay(date, docs) {
  const summary = docs.reduce(
    (acc, item) => {
      const m = macroContribution(item)
      acc.kcal += m.kcal
      acc.protein_g += m.protein_g
      acc.carbs_g += m.carbs_g
      acc.fat_g += m.fat_g
      acc.fiber_g += item.fiber_g || 0
      acc.sugar_g += item.sugar_g || 0
      acc.sat_fat_g += item.sat_fat_g || 0
      // incompleteness: any item lacking sat_fat_g means the day's sat_fat total is underestimated
      if (item.sat_fat_g == null) acc.sat_fat_incomplete = true
      // same for sugar: an entry logged before sugar was tracked drags the day's
      // total DOWN, which would render a green 'ok' on a day that actually breached
      // the ceiling — the exact case the metric exists for.
      if (item.sugar_g == null) acc.sugar_incomplete = true
      return acc
    },
    {
      date,
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
      sugar_g: 0,
      sat_fat_g: 0,
      sat_fat_incomplete: false,
      sugar_incomplete: false,
      items: docs.length,
    }
  )

  // Round to 1 decimal
  summary.kcal = Math.round(summary.kcal)
  summary.protein_g = Math.round(summary.protein_g * 10) / 10
  summary.carbs_g = Math.round(summary.carbs_g * 10) / 10
  summary.fat_g = Math.round(summary.fat_g * 10) / 10
  summary.fiber_g = Math.round(summary.fiber_g * 10) / 10
  summary.sugar_g = Math.round(summary.sugar_g * 10) / 10
  summary.sat_fat_g = Math.round(summary.sat_fat_g * 10) / 10

  return summary
}

module.exports = { macroContribution, aggregateDay }
