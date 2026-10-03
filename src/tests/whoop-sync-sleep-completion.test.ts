export {}

const { syncDate, shouldUnsetSleep } = require('../../scripts/sync-whoop')

const cycle = { id: 1972, start: '2026-07-06T06:00:00.000Z', end: '2026-07-07T06:00:00.000Z', score_state: 'SCORED', score: { strain: 8 } }
const sleep = { id: 'sleep1972', cycle_id: 1972, nap: false, score_state: 'SCORED', score: { stage_summary: { total_in_bed_time_milli: 28_800_000, total_awake_time_milli: 0 } } }

async function runSync({ sleeps = [sleep], cycles = [cycle], failFetch = false, failWrite = false } = {}) {
  const dailyUpdate = jest.fn().mockResolvedValue({})
  const sleepUpdate = jest.fn().mockImplementation(async () => {
    if (failWrite) throw new Error('sleep upsert unavailable')
    return {}
  })
  const ordinaryUpdate = jest.fn().mockResolvedValue({})
  const db = { collection: jest.fn((name: string) => ({
    updateOne: name === 'daily_metrics' ? dailyUpdate : name === 'whoop_sleep' ? sleepUpdate : ordinaryUpdate,
  })) }
  const fetchWhoop = jest.fn(async (_token: string, path: string) => {
    if (path.startsWith('/cycle?')) return { records: cycles }
    if (path.startsWith('/activity/sleep?')) {
      if (failFetch) throw new Error('WHOOP temporarily unavailable')
      return { records: sleeps }
    }
    return { records: [] }
  })
  await syncDate(db, 'fixture-token', '2026-07-06', { fetchWhoop })
  expect(dailyUpdate).toHaveBeenCalledTimes(1)
  return { update: dailyUpdate.mock.calls[0][1], sleepUpdate }
}

describe('#1972 real syncDate sleep cleanup', () => {
  it('preserves existing sleep fields when the matching sleep upsert fails', async () => {
    const { update, sleepUpdate } = await runSync({ failWrite: true })
    expect(sleepUpdate).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveProperty('$unset')
    expect(update.$set).not.toHaveProperty('sleep_hours')
  })
  it('preserves sleep fields on a fetch error', async () => {
    expect((await runSync({ failFetch: true })).update).not.toHaveProperty('$unset')
  })
  it('preserves sleep fields without a settled cycle', async () => {
    expect((await runSync({ cycles: [], sleeps: [] })).update).not.toHaveProperty('$unset')
  })
  it('clears stale sleep fields on a successfully processed empty cycle match', async () => {
    const { update } = await runSync({ sleeps: [] })
    expect(update.$unset).toHaveProperty('sleep_hours', '')
    expect(update.$set).not.toHaveProperty('sleep_hours')
  })
  it('sets matching sleep scores and does not unset them', async () => {
    const { update } = await runSync()
    expect(update).not.toHaveProperty('$unset')
    expect(update.$set.sleep_hours).toBe(8)
  })
})


describe('#1972 cleanup predicate', () => {
  it.each([
    [null, true, null, false],
    ['1972', false, null, false],
    ['1972', true, { sleep_hours: 8 }, false],
    ['1972', true, null, true],
  ])('cycle=%s completed=%s result=%s => unset=%s', (cycleId, sleepFetchCompleted, sleepResult, expected) => {
    expect(shouldUnsetSleep({ cycleId, sleepFetchCompleted, sleepResult })).toBe(expected)
  })
})
