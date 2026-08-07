/**
 * Integration test for #872 Finding #1 (QA FAIL on the recognize route, 2026-08-07): the default
 * express.json() body limit is 100kb. A real phone photo is 2-5MB, and base64-encoding it (as
 * PhotoRecognize.jsx does before POSTing to /api/nutrition/recognize) inflates that by ~4/3 — so
 * EVERY real-world photo got a raw HTML 413 before reaching the route at all, and the frontend's
 * `await res.json()` on that HTML body threw "Unexpected token" instead of showing why. Only a
 * ~18KB thumbnail ever worked, which is what the pre-fix "live test with a real photo" actually
 * used (Max reproduced 200 on 18KB / 413 on 127KB on the live :3001 service).
 *
 * Exercises the REAL configured app (server.js exports `app` without starting Mongo/listen when
 * required — see the `require.main === module` guard) via supertest against the actual mounted
 * route, not a hand-rolled express instance copying the limit — so this test tracks the real
 * config instead of a copy of it that could silently drift.
 */
import request from 'supertest'

// Force the deterministic "no key configured" 503 path in routes/nutrition_recognize.js (the
// route's OWN guard, before any network call) so this test never depends on GOOGLE_AI_API_KEY
// being present in the shell and never makes a real call to the Gemini API — it only asserts on
// body-SIZE handling, which happens in express.json() before the route handler ever runs.
delete process.env.GOOGLE_AI_API_KEY

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../../server')

function base64PayloadOfSize(bytes: number) {
  return { image: 'x'.repeat(bytes), mediaType: 'image/jpeg' }
}

describe('JSON body size limit (#872 Finding #1)', () => {
  it('lets a ~1MB payload (a real phone photo, base64-encoded) reach the route handler', async () => {
    const res = await request(app)
      .post('/api/nutrition/recognize')
      .send(base64PayloadOfSize(1_000_000))
    // The OLD 100kb default would 413 here, before the route ever ran. 503 = "no API key
    // configured", the route's OWN check — proof the body was accepted and parsed.
    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      error: 'GOOGLE_AI_API_KEY not configured',
      hint: 'Set GOOGLE_AI_API_KEY in environment to enable photo recognition',
    })
  })

  it('still rejects an absurdly oversized payload, but with a JSON error the frontend can parse', async () => {
    const res = await request(app)
      .post('/api/nutrition/recognize')
      .send(base64PayloadOfSize(12_000_000)) // over the 10mb HEALTH_API_JSON_LIMIT
    expect(res.status).toBe(413)
    expect(res.headers['content-type']).toMatch(/json/)
    expect(res.body.error).toBe('Payload too large')
    expect(res.body.hint).toContain('10mb')
  })
})
