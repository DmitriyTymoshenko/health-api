/** #1595 п.6: GET /api/whoop/summary marks an open cycle (end=null) as provisional. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whoopRoute = require('../../routes/whoop')

function makeApp(cycle: Record<string, unknown> | null) {
  const cursor = (rows: unknown[]) => ({
    sort() { return this }, limit() { return this },
    next: async () => rows[0] ?? null, toArray: async () => rows,
  })
  const db = {
    collection(name: string) {
      return {
        findOne: async () => (name === 'whoop_cycles' ? cycle : null),
        find: () => cursor([]),
      }
    },
  }
  const app = express()
  app.use('/api/whoop', whoopRoute(() => db))
  return app
}

describe('GET /api/whoop/summary calories_final (#1595 п.6)', () => {
  it.each([
    [{ date: '2026-10-02', calories_burned: 2400, end: null }, false],
    [{ date: '2026-10-02', calories_burned: 2400, end: '2026-10-02T21:00:00Z' }, true],
    [null, null],
  ])('cycle %j -> calories_final %s', async (cycle, expected) => {
    const res = await request(makeApp(cycle as any)).get('/api/whoop/summary?date=2026-10-02')
    expect(res.status).toBe(200)
    expect(res.body.calories_final).toBe(expected)
  })
})
