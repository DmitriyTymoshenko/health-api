import request from 'supertest'
import express from 'express'
const workoutsRouter = require('../../routes/workouts')
function makeApp(names: string[]) {
  const docs = names.map(name => ({ name, muscle_group: 'legs' }))
  const col = {
    findOne: async (filter: any) => docs.find(d => filter.name.$regex.test(d.name)) || null,
    insertOne: async (doc: any) => { docs.push(doc); return { insertedId: 'new' } },
  }
  const app = express(); app.use(express.json())
  app.use('/api/workouts', workoutsRouter(() => ({ collection: () => col })))
  return app
}
describe('exercise names are literal in duplicate detection #1842', () => {
  it('accepts an unmatched parenthesis without a 500', async () => {
    const res = await request(makeApp(['Squat'])).post('/api/workouts/exercises').send({ name: 'Squat (', muscle_group: 'legs' })
    expect(res.status).toBe(201)
  })
  it('does not treat .* as a wildcard duplicate', async () => {
    const res = await request(makeApp(['Squat'])).post('/api/workouts/exercises').send({ name: '.*', muscle_group: 'legs' })
    expect(res.status).toBe(201)
  })
  it('still detects the same literal name regardless of case', async () => {
    const res = await request(makeApp(['Squat (Smith)'])).post('/api/workouts/exercises').send({ name: 'squat (smith)', muscle_group: 'legs' })
    expect(res.status).toBe(409)
  })
})
