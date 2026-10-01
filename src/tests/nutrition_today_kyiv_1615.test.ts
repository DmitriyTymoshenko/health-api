/** #1615 — /today routes must use the Kyiv day, not the UTC day (00:00–03:00 Kyiv bug). */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')

function makeApp() {
  const seen: any[] = []
  const getDB = () => ({
    collection(name: string) {
      if (name === 'nutrition_log') {
        return {
          find: (filter: any) => {
            seen.push(filter.date)
            return { sort: () => ({ toArray: async () => [] }), toArray: async () => [] }
          },
        }
      }
      if (name === 'personal_profile') return { findOne: async () => ({ _type: 'profile', daily_kcal_goal: 2000 }) }
      if (name === 'weight_log') return { findOne: async () => ({ date: '2026-08-18', weight_kg: 80 }) }
      if (name === 'whoop_cycles') return { findOne: async () => null, find: () => ({ toArray: async () => [] }) }
      if (name === 'activity_plans' || name === 'whoop_workouts') return { find: () => ({ toArray: async () => [] }) }
      throw new Error('unexpected collection ' + name)
    },
  })
  const app = express()
  app.use('/api/nutrition', nutritionRouter(getDB))
  return { app, seen }
}

describe('nutrition /today uses Kyiv day (#1615)', () => {
  afterEach(() => jest.useRealTimers())

  it('21:30Z on 01.10 (00:30 Kyiv 02.10) → date 2026-10-02', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    jest.setSystemTime(new Date('2026-10-01T21:30:00Z'))
    const { app, seen } = makeApp()
    await request(app).get('/api/nutrition/summary/today')
    await request(app).get('/api/nutrition/today')
    expect(seen).toEqual(['2026-10-02', '2026-10-02'])
  })

  it('12:00Z on 01.10 → 2026-10-01', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    jest.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    const { app, seen } = makeApp()
    await request(app).get('/api/nutrition/summary/today')
    expect(seen).toEqual(['2026-10-01'])
  })
})
