/**
 * ROUTE-LEVEL RED-FIRST test for #1297 — 7 insert routes accepted `req.body`
 * as-is with zero validation (`insertOne(req.body)` / `findOneAndUpdate`
 * verbatim): `weight.js`, `nutrition.js`, `goals.js`, `notes.js`,
 * `body_measurements.js`, `activity.js`, `metrics.js`. The written middleware
 * (`src/middleware/validate.ts`) existed and was unit-tested but was NEVER
 * wired into any route (`grep requireFields|validateDate|normalizeNutrition
 * routes/` returned 0 hits before this fix) — `nutrition_log` already had 4
 * documents missing `food_name` as a direct result.
 *
 * ACCEPTANCE (task #1297, criterion d): `POST /api/{weight,nutrition,goals,
 * notes,body_measurements,activity,metrics}` with an EMPTY JSON body `{}`
 * must return 400, not 500/201.
 *
 * The stub DB below THROWS on any `collection()` access — a stronger proof
 * than asserting status alone: if a route's validation middleware has a gap
 * and the handler reaches the database, the test fails with a throw, not a
 * silently-wrong 2xx.
 *
 * RED-FIRST (verified before commit, see tasks_comment #1297 proof): with the
 * middleware NOT wired (original `routes/*.js`), every one of these 7 cases
 * returned 201/500 instead of 400. Wiring `requireFields`/`requireAnyField`/
 * `validateDate` (see each route's own #1297 comment for the field choice
 * rationale) makes all 7 return 400 without ever touching the throwing stub.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const weightRouter = require('../../routes/weight')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const goalsRouter = require('../../routes/goals')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notesRouter = require('../../routes/notes')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyMeasurementsRouter = require('../../routes/body_measurements')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activityRouter = require('../../routes/activity')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const metricsRouter = require('../../routes/metrics')

function throwingGetDB() {
  return () => ({
    collection() {
      throw new Error('validation gap: handler reached the database on an empty body')
    },
  })
}

function buildApp(mountPath: string, router: any) {
  const app = express()
  app.use(express.json())
  app.use(mountPath, router(throwingGetDB()))
  return app
}

describe('#1297 — POST {} rejected with 400 before touching the database', () => {
  const cases: Array<[string, string, any]> = [
    ['/api/weight', '/api/weight', weightRouter],
    ['/api/nutrition', '/api/nutrition', nutritionRouter],
    ['/api/goals', '/api/goals', goalsRouter],
    ['/api/notes', '/api/notes', notesRouter],
    ['/api/body_measurements', '/api/body_measurements', bodyMeasurementsRouter],
    ['/api/activity', '/api/activity', activityRouter],
    ['/api/metrics', '/api/metrics', metricsRouter],
  ]

  it.each(cases)('%s rejects an empty body with 400, not 500/201', async (_label, mountPath, router) => {
    const app = buildApp(mountPath, router)
    const res = await request(app).post(mountPath).send({})
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })
})
