/** #1699 — missing date defaults must use Kyiv today, not UTC today. */
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import express from 'express'

jest.mock('../../lib/targets-resolver', () => ({
  resolveDayTargets: jest.fn(async (_db: unknown, date: string) => ({ date })),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetsRouter = require('../../routes/targets')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mealTemplatesRouter = require('../../routes/meal_templates')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const settingsRouter = require('../../routes/settings')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activityPlanRouter = require('../../routes/activity_plan')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const weightRouter = require('../../routes/weight')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const metricsRouter = require('../../routes/metrics')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyMeasurementsRouter = require('../../routes/body_measurements')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRouter = require('../../routes/workouts')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const labsRouter = require('../../routes/labs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeNutrition } = require('../../lib/validate')

const KYIV_EDGE_UTC = '2026-10-01T21:30:00Z'
const KYIV_EDGE_DAY = '2026-10-02'

function appFor(router: any, getDB: () => any) {
  const app = express()
  app.use(express.json())
  app.use('/api', router(getDB))
  return app
}

describe('#1699 Kyiv today defaults at 00:30 Kyiv', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    jest.setSystemTime(new Date(KYIV_EDGE_UTC))
  })

  afterEach(() => jest.useRealTimers())

  it('GET /targets defaults to the Kyiv day', async () => {
    const app = appFor(targetsRouter, () => ({}))
    const res = await request(app).get('/api')
    expect(res.status).toBe(200)
    expect(res.body.date).toBe(KYIV_EDGE_DAY)
  })

  it('POST /meal-templates/:id/apply writes the Kyiv day when query date is absent', async () => {
    const inserted: any[] = []
    const app = appFor(mealTemplatesRouter, () => ({
      collection: (name: string) => {
        if (name === 'meal_templates') return { findOne: async () => ({ name: 'T', items: [{ food_name: 'eggs' }] }) }
        if (name === 'nutrition_log') return { insertMany: async (docs: any[]) => { inserted.push(...docs); return { insertedIds: [1] } } }
        throw new Error('unexpected collection ' + name)
      },
    }))
    const res = await request(app).post('/api/507f1f77bcf86cd799439011/apply')
    expect(res.status).toBe(200)
    expect(inserted[0].date).toBe(KYIV_EDGE_DAY)
  })

  it('PUT /settings stores daily plan snapshot under the Kyiv day', async () => {
    const plans: any[] = []
    const app = appFor(settingsRouter, () => ({
      collection: (name: string) => {
        if (name === 'daily_plans') return { updateOne: async (filter: any, update: any) => plans.push({ filter, update }) }
        if (name === 'user_settings') {
          return {
            updateOne: async () => undefined,
            findOne: async () => ({ key: 'default', daily_deficit_goal: 450 }),
          }
        }
        throw new Error('unexpected collection ' + name)
      },
    }))
    const res = await request(app).put('/api').send({ daily_deficit_goal: 450 })
    expect(res.status).toBe(200)
    expect(plans[0].filter.date).toBe(KYIV_EDGE_DAY)
    expect(plans[0].update.$set.date).toBe(KYIV_EDGE_DAY)
  })

  it.each([
    ['activity_plans', activityPlanRouter, '/api', { name: 'walk' }, 'insertOne'],
    ['weight_log', weightRouter, '/api', { weight_kg: 93 }, 'findOneAndUpdate'],
    ['daily_metrics', metricsRouter, '/api', { recovery_score: 80 }, 'findOneAndUpdate'],
    ['body_measurements', bodyMeasurementsRouter, '/api', { waist_cm: 91 }, 'insertOne'],
    ['workouts', workoutsRouter, '/api', { exercises: [] }, 'insertOne'],
    ['lab_results', labsRouter, '/api', { values: { vitamin_d: 50 } }, 'insertOne'],
  ])('%s write route defaults missing body date to Kyiv day', async (collectionName, router, url, body, writeMethod) => {
    let written: any
    const app = appFor(router, () => ({
      collection: (name: string) => {
        if (name !== collectionName) {
          if (name === 'exercises_library') return {}
          if (name === 'weight_log') return { findOne: async () => null }
          throw new Error('unexpected collection ' + name)
        }
        return {
          insertOne: async (doc: any) => { written = doc; return { insertedId: 'id' } },
          findOneAndUpdate: async (_filter: any, update: any) => { written = update.$set; return written },
        }
      },
    }))
    const res = await request(app).post(url).send(body)
    expect(res.status).toBe(201)
    expect(written.date).toBe(KYIV_EDGE_DAY)
    expect(writeMethod).toMatch(/insertOne|findOneAndUpdate/)
  })

  it('normalizeNutrition middleware defaults missing body date to Kyiv day', () => {
    const req: any = { body: { name: 'eggs', protein: 20 } }
    normalizeNutrition(req, {}, jest.fn())
    expect(req.body.date).toBe(KYIV_EDGE_DAY)
  })
})

describe('#1699 static guard for raw UTC today defaults', () => {
  it('does not leave raw new Date().toISOString date defaults in routes/lib', () => {
    const root = path.resolve(__dirname, '../..')
    const offenders: string[] = []

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue
        const rel = path.relative(root, full)
        const text = fs.readFileSync(full, 'utf8')
        text.split('\n').forEach((line, idx) => {
          if (/new Date\(\)\.toISOString\(\)\.(split\('T'\)\[0\]|slice\(0,\s*10\))/.test(line)) {
            offenders.push(`${rel}:${idx + 1}:${line.trim()}`)
          }
        })
      }
    }

    walk(path.join(root, 'routes'))
    walk(path.join(root, 'lib'))
    expect(offenders).toEqual([])
  })
})
