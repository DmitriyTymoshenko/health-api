/**
 * Unit tests for lib/cycle-notify.js (#1487, stage B of #1485, design D8).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkCycleEndsAndNotify, formatMessage } = require('../../lib/cycle-notify')

type Doc = Record<string, any>

function makeDB(initialCycles: Doc[]) {
  const cycles = initialCycles.map(c => ({ ...c }))
  return {
    collection(name: string) {
      if (name !== 'supplement_cycles') throw new Error(`unexpected collection: ${name}`)
      return {
        find() {
          return { toArray: async () => cycles.map(c => ({ ...c })) }
        },
        async updateOne(filter: Doc, update: Doc) {
          const doc = cycles.find(c => c._id === filter._id)
          if (!doc) return { matchedCount: 0 }
          const set = update.$set || {}
          for (const [key, value] of Object.entries(set)) {
            // Support one level of dot-path (end_notified.pause) like real Mongo $set.
            if (key.includes('.')) {
              const [top, sub] = key.split('.')
              doc[top] = doc[top] || {}
              doc[top][sub] = value
            } else {
              doc[key] = value
            }
          }
          return { matchedCount: 1 }
        },
      }
    },
    _cycles: cycles,
  }
}

// Same fixture as lib/cycle-status.js's parity test: 2026-06-10 start, 8
// weeks active + 4 weeks pause -> pauseEnd 2026-09-02, so 2026-09-22 is
// 'completed'.
const CREATINE_CYCLE = { _id: 'c1', supplement_id: 1, supplement_name: 'Creatine HCl', start_date: '2026-06-10', duration_weeks: 8, pause_weeks: 4 }

describe('checkCycleEndsAndNotify — B6', () => {
  it('a completed cycle with no prior notification sends exactly 1 message', async () => {
    const db = makeDB([CREATINE_CYCLE])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await checkCycleEndsAndNotify(db, new Date('2026-09-22'), sendTelegramImpl)

    expect(sendTelegramImpl).toHaveBeenCalledTimes(1)
    expect(sendTelegramImpl.mock.calls[0][0]).toContain('Creatine HCl')
    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 })
    expect(db._cycles[0].end_notified.completed).toBeTruthy()
  })

  it('a repeated call after a successful send sends 0 more messages (idempotent)', async () => {
    const db = makeDB([CREATINE_CYCLE])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    await checkCycleEndsAndNotify(db, new Date('2026-09-22'), sendTelegramImpl)
    sendTelegramImpl.mockClear()

    const result2 = await checkCycleEndsAndNotify(db, new Date('2026-09-22'), sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result2).toEqual({ checked: 1, sent: 0, skipped: 1 })
  })

  it('a failed send (sendTelegram -> false) does NOT write the flag — the next call retries', async () => {
    const db = makeDB([CREATINE_CYCLE])
    const failingSend = jest.fn(async () => false)
    const result = await checkCycleEndsAndNotify(db, new Date('2026-09-22'), failingSend)

    expect(result).toEqual({ checked: 1, sent: 0, skipped: 1 })
    expect(db._cycles[0].end_notified).toBeUndefined()

    // Next tick with a WORKING send must retry, not skip.
    const workingSend = jest.fn(async (_msg: string) => true)
    const result2 = await checkCycleEndsAndNotify(db, new Date('2026-09-22'), workingSend)
    expect(workingSend).toHaveBeenCalledTimes(1)
    expect(result2).toEqual({ checked: 1, sent: 1, skipped: 0 })
  })

  it('an active-by-dates cycle is never notified', async () => {
    const db = makeDB([CREATINE_CYCLE])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    const result = await checkCycleEndsAndNotify(db, new Date('2026-06-15'), sendTelegramImpl)
    expect(sendTelegramImpl).not.toHaveBeenCalled()
    expect(result).toEqual({ checked: 1, sent: 0, skipped: 0 })
  })

  it('pause and completed are tracked as SEPARATE flags — a cycle notified for pause still gets notified once it later completes', async () => {
    const db = makeDB([CREATINE_CYCLE])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)

    // First: cycle enters pause (2026-08-20, inside the pause window).
    await checkCycleEndsAndNotify(db, new Date('2026-08-20'), sendTelegramImpl)
    expect(db._cycles[0].end_notified.pause).toBeTruthy()
    expect(db._cycles[0].end_notified.completed).toBeUndefined()
    sendTelegramImpl.mockClear()

    // Later: same cycle is now completed — must send again (different state key).
    const result = await checkCycleEndsAndNotify(db, new Date('2026-09-22'), sendTelegramImpl)
    expect(sendTelegramImpl).toHaveBeenCalledTimes(1)
    expect(result.sent).toBe(1)
    expect(db._cycles[0].end_notified.completed).toBeTruthy()
  })

  it('a manual status:"paused" override also triggers a pause notification', async () => {
    const manualPause = { ...CREATINE_CYCLE, status: 'paused' }
    const db = makeDB([manualPause])
    const sendTelegramImpl = jest.fn(async (_msg: string) => true)
    // 2026-06-15 is active by dates alone — only the manual override causes 'pause'.
    const result = await checkCycleEndsAndNotify(db, new Date('2026-06-15'), sendTelegramImpl)
    expect(result.sent).toBe(1)
    expect(sendTelegramImpl.mock.calls[0][0]).toContain('⏸')
  })
})

describe('formatMessage', () => {
  it('pause message uses the supplement name and a distinct emoji from completed', () => {
    const pauseMsg = formatMessage(CREATINE_CYCLE, 'pause')
    const doneMsg = formatMessage(CREATINE_CYCLE, 'completed')
    expect(pauseMsg).toContain('Creatine HCl')
    expect(doneMsg).toContain('Creatine HCl')
    expect(pauseMsg).not.toBe(doneMsg)
  })
  it('falls back to #<supplement_id> when supplement_name is missing', () => {
    const msg = formatMessage({ supplement_id: 42 }, 'pause')
    expect(msg).toContain('#42')
  })
})

export {}
