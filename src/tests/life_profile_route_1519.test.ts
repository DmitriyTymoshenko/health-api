/**
 * Route-level wiring test for GET /api/life/profile (#1519, SPEC #1518 §3/§6).
 * Read-only — the only writer is scripts/seed-life-profile.js, not this route.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifeProfileRoute = require('../../routes/life_profile')
import { makeMockCollection } from './utils/mockLifeMongo'

function makeApp(seed: { profile?: any[] } = {}) {
  const collection = makeMockCollection(seed.profile || [])
  const db = {
    collection(name: string) {
      if (name !== 'life_profile') throw new Error(`unexpected collection: ${name}`)
      return collection
    },
  }
  const app = express()
  app.use('/api/life', lifeProfileRoute(() => db))
  return { app }
}

describe('GET /api/life/profile', () => {
  it('404 when the singleton has not been seeded yet', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/life/profile')
    expect(res.status).toBe(404)
  })

  it('200 with the seeded profile fields (SPEC §3 shape)', async () => {
    const { app } = makeApp({
      profile: [
        {
          version: 1,
          source: 'vault:EN/00-09 System & Personal/01 About/dmytro-profile.md#51.01',
          strengths: [{ key: 'learner', name: 'Learner', description: 'x' }],
          dominant_domain: 'Стратегічне мислення',
          leadership_style: 'Аналітик-стратег, «архітектор систем»',
          balance_formula: { label: 'Аналітика + Дія + Довіра = Ріст', components: [] },
        },
      ],
    })
    const res = await request(app).get('/api/life/profile')
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(1)
    expect(res.body.strengths.length).toBe(1)
    expect(res.body.balance_formula.label).toBe('Аналітика + Дія + Довіра = Ріст')
  })
})

export {}
