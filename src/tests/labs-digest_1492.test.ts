/**
 * Unit tests for lib/labs-digest.js (#1492, stage H of #1485, REQ-10).
 * Gate: Monday >=09:00 Kyiv, once per ISO week, reuses lib/labs-reminders.js
 * (which itself lazy-requires the REAL routes/labs.js for
 * REFERENCE_RANGES/RETEST_INTERVALS/getStatus — not mocked here, same as
 * src/tests/labs_excluded_1415.test.ts's approach of exercising the actual
 * production constants instead of a second copy).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendWeeklyLabsDigest, isoWeekKey } = require('../../lib/labs-digest')

type Doc = Record<string, any>

function chain(rows: Doc[]) {
  return { sort() { return this }, toArray: async () => rows }
}

function makeDB(labResults: Doc[], notifyStateDocs: Doc[] = []) {
  const state = notifyStateDocs.map(d => ({ ...d }))
  return {
    collection(name: string) {
      if (name === 'lab_results') {
        return { find(_filter: Doc) { return chain(labResults) } }
      }
      if (name === 'health_notify_state') {
        return {
          async findOne(filter: Doc) {
            return state.find(d => d.key === filter.key) || null
          },
          async updateOne(filter: Doc, update: Doc, opts: Doc) {
            let doc = state.find(d => d.key === filter.key)
            if (!doc) {
              if (!opts?.upsert) return { matchedCount: 0 }
              doc = { key: filter.key }
              state.push(doc)
            }
            Object.assign(doc, update.$set || {})
            return { matchedCount: 1 }
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
    _state: state,
  }
}

// vitamin_d: RETEST_INTERVALS 90 days (routes/labs.js). Dated far enough in
// the past (2025-01-01) that it is OVERDUE relative to every "now" used below.
const OVERDUE_LAB_ROW = { date: '2025-01-01', values: { vitamin_d: 50 } }

const MON_0930 = new Date('2026-09-21T06:30:00Z')   // Kyiv Mon 09:30, ISO week 2026-W39
const MON_0830 = new Date('2026-09-21T05:30:00Z')   // Kyiv Mon 08:30 — before the 09:00 gate
const TUE_0930 = new Date('2026-09-22T06:30:00Z')   // Kyiv Tue 09:30 — not Monday
const NEXT_MON_0930 = new Date('2026-09-28T06:30:00Z') // Kyiv Mon 09:30, ISO week 2026-W40

describe('isoWeekKey', () => {
  it('matches the task-spec example week for the current Monday/Tuesday', () => {
    expect(isoWeekKey(MON_0930)).toBe('2026-W39')
    expect(isoWeekKey(TUE_0930)).toBe('2026-W39')
    expect(isoWeekKey(NEXT_MON_0930)).toBe('2026-W40')
  })
})

describe('sendWeeklyLabsDigest — H2', () => {
  it('Monday 09:30 Kyiv with 1 overdue biomarker -> 1 send + last_sent_iso_week written', async () => {
    const db = makeDB([OVERDUE_LAB_ROW])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await sendWeeklyLabsDigest(db, MON_0930, sendTelegramImpl)

    expect(sendTelegramImpl).toHaveBeenCalledTimes(1)
    expect(sendTelegramImpl.mock.calls[0][0]).toContain('Аналізи')
    expect(result.sent).toBe(true)
    expect(result.overdueCount).toBeGreaterThan(0)
    expect(db._state.find((d: Doc) => d.key === 'labs_digest')!.last_sent_iso_week).toBe('2026-W39')
  })

  it('a second call the SAME week sends 0 more messages (idempotent)', async () => {
    const db = makeDB([OVERDUE_LAB_ROW])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    await sendWeeklyLabsDigest(db, MON_0930, sendTelegramImpl)
    sendTelegramImpl.mockClear()

    const result2 = await sendWeeklyLabsDigest(db, MON_0930, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result2).toEqual({ sent: false, reason: 'already-sent-this-week' })
  })

  it('the NEXT Monday sends again (new ISO week)', async () => {
    const db = makeDB([OVERDUE_LAB_ROW])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    await sendWeeklyLabsDigest(db, MON_0930, sendTelegramImpl)
    sendTelegramImpl.mockClear()

    const result = await sendWeeklyLabsDigest(db, NEXT_MON_0930, sendTelegramImpl)
    expect(sendTelegramImpl).toHaveBeenCalledTimes(1)
    expect(result.sent).toBe(true)
    expect(db._state.find((d: Doc) => d.key === 'labs_digest')!.last_sent_iso_week).toBe('2026-W40')
  })

  it('0 overdue and 0 soon -> 0 sends, no flag written', async () => {
    const db = makeDB([]) // no lab_results at all -> "never", not overdue/soon
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await sendWeeklyLabsDigest(db, MON_0930, sendTelegramImpl)

    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false, reason: 'nothing-due' })
    expect(db._state.find((d: Doc) => d.key === 'labs_digest')).toBeUndefined()
  })

  it('before 09:00 Kyiv on Monday -> no send, no DB read needed', async () => {
    const db = makeDB([OVERDUE_LAB_ROW])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await sendWeeklyLabsDigest(db, MON_0830, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false, reason: 'not-monday-09' })
  })

  it('a non-Monday tick (Tuesday 09:30) -> no send', async () => {
    const db = makeDB([OVERDUE_LAB_ROW])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await sendWeeklyLabsDigest(db, TUE_0930, sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false, reason: 'not-monday-09' })
  })

  it('a failed send does NOT write the flag — the next tick retries', async () => {
    const db = makeDB([OVERDUE_LAB_ROW])
    const failingSend = jest.fn(async () => false)
    const result = await sendWeeklyLabsDigest(db, MON_0930, failingSend)

    expect(result).toEqual({ sent: false, reason: 'send-failed' })
    expect(db._state.find((d: Doc) => d.key === 'labs_digest')).toBeUndefined()

    const workingSend = jest.fn(async (_msg: string) => true)
    const result2 = await sendWeeklyLabsDigest(db, MON_0930, workingSend)
    expect(workingSend).toHaveBeenCalledTimes(1)
    expect(result2.sent).toBe(true)
  })
})

export {}
