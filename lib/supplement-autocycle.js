'use strict'

// #1487 (stage B of #1485, design D6): shared auto-cycle logic for
// `POST /api/catalog` (new supplement with a `knowledge.cycle`) and the
// active:false→true reactivation transition on `PUT /api/catalog/:id`
// (#1427's own write path). ONE definition, both call sites — per the
// #966/#988 lesson ("a stub of the same typo only proves the typo"), this
// file is required directly by both the route AND its own test, no mirrored
// re-implementation in a test fixture.
//
// #1290's Kyiv-day helper is reused as-is (formatDateKyiv) rather than
// forked — same algorithm, single source, this repo already has the
// "byte-identical copy across repos" exception documented for the
// cross-REPO case (lib/cycle-status.js); within ONE repo there is no reason
// to duplicate it.
const { formatDateKyiv } = require('./training-program')

/**
 * Build the supplement_cycles document for an auto-created cycle. Pure —
 * no DB access, no id assignment (the caller does the id-increment dance
 * the same way the existing `POST /cycles` route already does, so both
 * paths produce cycles with the SAME id-numbering scheme).
 */
function buildAutoCycleDoc(supplementId, supplementName, cycle, startDate) {
  return {
    supplement_id: supplementId,
    supplement_name: supplementName || '',
    start_date: startDate,
    duration_weeks: cycle.duration_weeks,
    pause_weeks: cycle.pause_weeks || 0,
    status: 'active',
    created_by: 'auto',
  }
}

/**
 * Creates an auto-cycle for `supplementId` if `knowledge.cycle` is present
 * (continuous supplements — `cycle: null` — never get one). Dedupes on
 * (supplement_id, start_date): a retried/duplicate call for the SAME
 * supplement on the SAME day is a no-op, returns the EXISTING doc instead of
 * inserting a second one (D6: "повторний виклик НЕ створює другий
 * auto-цикл"). Never throws on a DB failure — returns `{cycle: null,
 * cycle_error: <message>}` so the caller (POST /catalog) can still respond
 * 201 with the catalog item created, per D6's explicit failure-path.
 *
 * `now` is injectable for tests (defaults to real time, Kyiv calendar day).
 */
async function ensureAutoCycleForSupplement(db, supplementId, supplementName, knowledge, now = new Date()) {
  if (!knowledge || !knowledge.cycle) return { cycle: null, cycle_error: null }

  const cycle = knowledge.cycle
  if (!Number.isInteger(cycle.duration_weeks) || cycle.duration_weeks < 1) {
    return { cycle: null, cycle_error: 'invalid cycle.duration_weeks' }
  }

  const startDate = formatDateKyiv(now)

  try {
    const existing = await db.collection('supplement_cycles').findOne({ supplement_id: supplementId, start_date: startDate })
    if (existing) return { cycle: existing, cycle_error: null }

    const lastItem = await db.collection('supplement_cycles').findOne({}, { sort: { id: -1 } })
    const newId = (lastItem?.id || 0) + 1
    const doc = { ...buildAutoCycleDoc(supplementId, supplementName, cycle, startDate), id: newId }
    await db.collection('supplement_cycles').insertOne(doc)
    return { cycle: doc, cycle_error: null }
  } catch (err) {
    console.error('[supplement-autocycle] failed to create auto-cycle:', err.message)
    return { cycle: null, cycle_error: err.message }
  }
}

module.exports = { buildAutoCycleDoc, ensureAutoCycleForSupplement }
