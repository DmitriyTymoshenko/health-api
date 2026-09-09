/**
 * Route-level tests for PATCH /api/workouts/exercises/:name (task #1304 — exercise
 * technique/video/photo library).
 *
 * Mounts the REAL route factory (routes/workouts.js exports `function (getDB)`) with a
 * stub `exercises_library` collection, same pattern as workouts_exercise_history_reps.test.ts
 * (#1130/#969) — assertions run against production code, not a re-implementation of it.
 *
 * WHY this route exists: `exercises_library` already has 17/17 exercises of plan #1290
 * seeded as documents (name/muscle_group/equipment only). Adding technique content is an
 * UPDATE to existing documents — Apex's triage (task #1304, comment 18:17) explicitly
 * rejected turning the existing `POST /exercises` into an upsert, because upserting on a
 * typo'd name would silently CREATE a duplicate exercise (the plan↔library join key is the
 * name, byte-for-byte, #1290) instead of failing loudly. `PATCH .../:name` instead:
 *   - looks up by EXACT name (no regex — names are already canonical, no case-folding needed)
 *   - `$set`s only a whitelist {description_ua, video_url, image_url, cues}
 *   - 404s on no match, never inserts
 *   - never writes name/muscle_group/equipment/_id, even if present in the request body —
 *     so this route is structurally unable to rename an exercise and break the join key.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

/** Minimal in-memory stand-in for the `exercises_library` collection this route touches. */
function makeApp(initialDocs: Array<Record<string, any>>) {
  const docs = initialDocs.map(d => ({ ...d }))
  const db = {
    collection(name: string) {
      if (name !== 'exercises_library') {
        throw new Error(`unexpected collection: ${name}`)
      }
      return {
        async findOne(filter: { name?: string }) {
          return docs.find(d => d.name === filter.name) || null
        },
        async updateOne(filter: { name?: string }, update: { $set: Record<string, any> }) {
          const doc = docs.find(d => d.name === filter.name)
          if (!doc) return { matchedCount: 0, modifiedCount: 0 }
          Object.assign(doc, update.$set)
          return { matchedCount: 1, modifiedCount: 1 }
        },
      }
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workouts', workoutsRoute(() => db))
  return { app, docs }
}

const PLANKA = { _id: 'p1', name: 'Планка', muscle_group: 'core', equipment: 'bodyweight' }

describe('PATCH /api/workouts/exercises/:name (#1304)', () => {
  it('sets description_ua and video_url on an exact name match, returns the updated document', async () => {
    const { app } = makeApp([PLANKA])
    const res = await request(app)
      .patch(`/api/workouts/exercises/${encodeURIComponent('Планка')}`)
      .send({ description_ua: 'Упор на передпліччя...', video_url: '' })

    expect(res.status).toBe(200)
    expect(res.body.description_ua).toBe('Упор на передпліччя...')
    expect(res.body.video_url).toBe('')
    // Untouched fields survive the $set.
    expect(res.body.muscle_group).toBe('core')
    expect(res.body.equipment).toBe('bodyweight')
  })

  it('404s on an unknown exercise name and does NOT create a new document (no upsert)', async () => {
    const { app, docs } = makeApp([PLANKA])
    const before = docs.length
    const res = await request(app)
      .patch(`/api/workouts/exercises/${encodeURIComponent('Неіснуюча вправа')}`)
      .send({ description_ua: 'x' })

    expect(res.status).toBe(404)
    expect(docs.length).toBe(before) // no insert happened
  })

  it('whitelist: name/muscle_group/equipment/_id in the body are ignored — route cannot rename an exercise', async () => {
    const { app, docs } = makeApp([PLANKA])
    const res = await request(app)
      .patch(`/api/workouts/exercises/${encodeURIComponent('Планка')}`)
      .send({
        cues: ['напруж прес'],
        name: 'ЗЛОМ',
        muscle_group: 'ЗЛОМ',
        equipment: 'ЗЛОМ',
        _id: '000000000000000000000000',
      })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Планка') // unchanged — join key with #1290 plan preserved
    expect(res.body.muscle_group).toBe('core')
    expect(res.body.equipment).toBe('bodyweight')
    expect(res.body._id).toBe('p1')
    expect(res.body.cues).toEqual(['напруж прес']) // the one whitelisted field DID write
    expect(docs[0].name).toBe('Планка')
  })

  it('handles a Cyrillic name with spaces via a single encodeURIComponent (lesson #1286/#1290)', async () => {
    const doc = { _id: 'm1', name: 'Молоткові згинання на лаві Скотта', muscle_group: 'biceps', equipment: 'dumbbell' }
    const { app } = makeApp([doc])
    const res = await request(app)
      .patch(`/api/workouts/exercises/${encodeURIComponent('Молоткові згинання на лаві Скотта')}`)
      .send({ video_url: 'https://www.youtube.com/watch?v=9kMkjOPA7qs' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Молоткові згинання на лаві Скотта')
    expect(res.body.video_url).toBe('https://www.youtube.com/watch?v=9kMkjOPA7qs')
  })
})

export {}
