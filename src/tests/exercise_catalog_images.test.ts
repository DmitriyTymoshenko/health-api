/**
 * #1332 acceptance #7 — exercise-catalog images must be served from OUR host with a
 * real image content-type, never a 404/HTML masquerading as success (lesson:
 * `rules/lessons-learned.md` "HTTP 200 on an SPA path proves nothing about the asset —
 * assert content-type/size"). This test exercises the REAL mounted express.static
 * middleware (server.js) against a small real-looking fixture file, so it tracks the
 * actual route wiring instead of a hand-rolled express instance that could drift.
 *
 * Does NOT depend on the live migration having downloaded the real 876-exercise image
 * set (that's a live/manual verification step, not this suite) — it proves the static
 * mount itself is correct and content-type is asset-derived, independent of migration
 * timing.
 */
import request from 'supertest'
import fs from 'fs'
import path from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../../server')

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'uploads', 'exercises', '__test_fixture_1332__')
const FIXTURE_PATH = path.join(FIXTURE_DIR, '0.jpg')

describe('GET /uploads/exercises/:id/:n.jpg (#1332 acceptance #7)', () => {
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true })
    // Minimal valid JPEG header bytes are not required — express.static derives
    // content-type from the FILE EXTENSION, not file content, so any bytes exercise
    // the real code path this test is verifying.
    fs.writeFileSync(FIXTURE_PATH, Buffer.from('fixture-not-a-real-jpeg-but-real-extension'))
  })

  afterAll(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  })

  it('serves an existing image with 200 and image/jpeg content-type — not HTML/404', async () => {
    const res = await request(app).get('/uploads/exercises/__test_fixture_1332__/0.jpg')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/)
  })

  it('returns a real 404 (not a 200 SPA-style fallback) for a missing image', async () => {
    const res = await request(app).get('/uploads/exercises/__does_not_exist__/0.jpg')
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).not.toMatch(/^image\//)
  })
})
