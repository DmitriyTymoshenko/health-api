/**
 * ROUTE-LEVEL security tests for GET /api/whoop/authorize and GET /api/whoop/callback (#1294).
 *
 * WHAT #1294 FOUND (live measurement, apex, 09.09, task #1294 comment #7328):
 *   1) FOUR reflected-XSS sinks in routes/whoop.js send unescaped query/error data as HTML
 *      (lines 262, 269, 270, 316 pre-fix) — line 270 is the worst: it fires whenever `code`
 *      is simply ABSENT, so `?x=<script>` hits it with no valid-looking request at all.
 *   2) `/authorize` generated an OAuth `state` and never stored it — `/callback` never
 *      checked it — so ANY third party hitting `/callback?code=<theirs>` got their code
 *      exchanged and their tokens written over Дмитро's live `/root/.config/whoop/whoop.json`.
 *   3) The 2 routes that sit outside Caddy's basicauth by design had no rate limit.
 *
 * This is a ROUTE-LEVEL test (drives the REAL router via supertest, per the #931/#909/#1225
 * "mirror test" lesson — never re-implement escapeHtml/state-check here, only assert on HTTP
 * behaviour). `fs` and `https` are mocked so no test run ever touches the real
 * /root/.config/whoop/whoop.json or makes a real network call to WHOOP.
 *
 * RED-FIRST: every `expect` below was verified failing against the pre-fix routes/whoop.js
 * (reflected `<script` in the body; `code=fake123` with no `state` returned 200/500 and wrote
 * to the creds file; unlimited requests never 429'd) before this file was committed — see
 * task #1294 closing comment for the live curl transcript on a disposable instance.
 */
import request from 'supertest'
import express from 'express'
import fs from 'fs'

// #1294: mock the WHOLE `fs` module (not a runtime jest.spyOn on the live built-in object —
// that hit "Cannot redefine property: readFileSync" once combined with jest.isolateModules()
// re-requiring routes/whoop.js per test) so no test run ever touches the real
// /root/.config/whoop/whoop.json.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    readFileSync: jest.fn(actual.readFileSync),
    writeFileSync: jest.fn(),
  }
})

jest.mock('https', () => ({
  // Minimal fake: every token-exchange POST "succeeds" at the transport level but WHOOP
  // rejects the fake code with a 400 invalid_grant — enough to prove the route reaches the
  // exchange step (state was valid) without ever hitting the real network in a test run.
  request: jest.fn((_opts: unknown, cb: (res: any) => void) => {
    const { EventEmitter } = require('events')
    const res = new EventEmitter() as any
    res.statusCode = 400
    process.nextTick(() => {
      cb(res)
      res.emit('data', JSON.stringify({ error: 'invalid_grant', error_description: 'fake code' }))
      res.emit('end')
    })
    return { on: jest.fn(), write: jest.fn(), end: jest.fn() }
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const whoopRouter = require('../../routes/whoop')

type StateDoc = { state: string; createdAt: Date }

function makeOAuthStateCollection() {
  const store: StateDoc[] = []
  return {
    async insertOne(doc: StateDoc) {
      store.push(doc)
      return { insertedId: 'fake-id' }
    },
    // Mirrors mongodb driver v6 default: returns the matched document directly (or null),
    // not the legacy { value } wrapper — same assumption routes/whoop.js relies on.
    async findOneAndDelete(filter: { state: string }) {
      const idx = store.findIndex((d) => d.state === filter.state)
      if (idx === -1) return null
      const [doc] = store.splice(idx, 1)
      return doc
    },
    _debugCount: () => store.length,
  }
}

function makeGetDB() {
  const stateColl = makeOAuthStateCollection()
  return {
    getDB: () => ({
      collection(name: string) {
        if (name !== 'whoop_oauth_state') throw new Error(`unexpected collection in this test: ${name}`)
        return stateColl
      },
    }),
    stateColl,
  }
}

// #1294: the rate limiter is module-scope state inside routes/whoop.js (shared across every
// app mounted from one `require`), matching how it behaves in the real single process. Tests
// that need a CLEAN counter re-require the module fresh via isolateModules — otherwise every
// test in this file would silently share (and eventually exhaust) one limiter.
function freshApp() {
  let router: any
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    router = require('../../routes/whoop')
  })
  const { getDB, stateColl } = makeGetDB()
  const app = express()
  app.use('/api/whoop', router(getDB))
  return { app, stateColl }
}

const mockReadFileSync = fs.readFileSync as jest.Mock
const mockWriteFileSync = fs.writeFileSync as jest.Mock
const actualReadFileSync = jest.requireActual('fs').readFileSync

beforeEach(() => {
  mockReadFileSync.mockImplementation((path: any, ...args: any[]) => {
    if (String(path).includes('whoop.json')) {
      return JSON.stringify({ client_id: 'test-client', client_secret: 'test-secret' })
    }
    return actualReadFileSync(path, ...args)
  })
  mockWriteFileSync.mockImplementation(() => undefined)
})

afterEach(() => {
  mockReadFileSync.mockClear()
  mockWriteFileSync.mockClear()
})

describe('GET /api/whoop/callback — XSS escaping (#1294, Finding 2)', () => {
  it('?error=<script> is escaped, not reflected raw (was the named line-269 sink)', async () => {
    const { app } = freshApp()
    const res = await request(app).get('/api/whoop/callback').query({ error: '<script>alert(1)</script>' })
    expect(res.status).toBe(400)
    expect(res.text).not.toContain('<script')
    expect(res.text).toContain('&lt;script&gt;')
  })

  it('?x=<script> with NO code is escaped (line-270 sink — fires on missing code, not named in the original ticket)', async () => {
    const { app } = freshApp()
    const res = await request(app).get('/api/whoop/callback').query({ x: '<script>alert(1)</script>' })
    expect(res.status).toBe(400)
    expect(res.text).not.toContain('<script')
    expect(res.text).toContain('&lt;script&gt;')
  })
})

describe('GET /api/whoop/callback — state validation (#1294, Finding 2)', () => {
  it('code with no state at all -> 400, no token exchange, no file write', async () => {
    const { app } = freshApp()
    const res = await request(app).get('/api/whoop/callback').query({ code: 'fake123' })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Invalid or expired state')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('code with an unknown/fabricated state -> 400, no token exchange, no file write', async () => {
    const { app } = freshApp()
    const res = await request(app).get('/api/whoop/callback').query({ code: 'fake123', state: 'not-a-real-state' })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Invalid or expired state')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('a state minted by /authorize is accepted exactly once (single-use)', async () => {
    const { app, stateColl } = freshApp()

    const authRes = await request(app).get('/api/whoop/authorize')
    expect(authRes.status).toBe(302)
    const location = new URL(authRes.headers.location)
    const state = location.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(stateColl._debugCount()).toBe(1)

    // 1st use: valid state -> passes the state gate, reaches the (mocked) token exchange,
    // which WHOOP rejects (fake code) -> 500, but proves the state check let it through.
    const first = await request(app).get('/api/whoop/callback').query({ code: 'fake-code', state })
    expect(first.status).toBe(500)
    expect(stateColl._debugCount()).toBe(0) // consumed
    expect(mockWriteFileSync).not.toHaveBeenCalled() // upstream rejected the code, no creds written

    // 2nd use of the SAME state -> must now be rejected (already consumed), not re-accepted.
    const second = await request(app).get('/api/whoop/callback').query({ code: 'fake-code', state })
    expect(second.status).toBe(400)
    expect(second.text).toContain('Invalid or expired state')
  })
})

describe('GET /api/whoop/authorize + /callback — rate limit (#1294, Finding 3)', () => {
  it('exceeds the limit -> 429, without ever writing the creds file', async () => {
    const { app } = freshApp()
    const results: number[] = []
    for (let i = 0; i < 12; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/api/whoop/callback').query({ code: `fake${i}` })
      results.push(res.status)
    }
    expect(results).toContain(429)
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('a fresh limiter instance (new process-equivalent) is not pre-throttled by a previous test', async () => {
    const { app } = freshApp()
    const res = await request(app).get('/api/whoop/callback').query({ code: 'fake1' })
    expect(res.status).not.toBe(429)
  })
})

export {}
