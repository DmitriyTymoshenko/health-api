/**
 * Route-level tests for PATCH /api/workouts/exercises/:name/name (#1472).
 *
 * Discovered by Lisa 21.09: dictating the same exercise with a slightly different name
 * across sessions ("Розводка в тренажері" vs "Розводка в тренажері на груди") split its
 * history into two untracked exercises_library docs — `/rename` 404'd, a bare
 * `PATCH /exercises/:name` with `{name}` silently ignored it (200, nothing changed).
 *
 * This route is the ONE write path for renaming/merging an exercises_library exercise —
 * mirrors `/weight-unit` and `/muscle-group` (exact-match findOne, 404 on unknown name,
 * post-write walk over `workouts`), plus the merge/consolidation logic from
 * lib/exercise-rename.js and a `training_programs` backfill neither sibling route needs.
 *
 * Mounts the REAL route factory (routes/workouts.js), stub `exercises_library` +
 * `workouts` + `training_programs` collections — same in-memory pattern as
 * workouts_exercises_muscle_group_route.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workoutsRoute = require('../../routes/workouts')

function makeApp(opts: {
  exercises?: Array<Record<string, any>>
  workouts?: Array<Record<string, any>>
  programs?: Array<Record<string, any>>
}) {
  const exercises: Array<Record<string, any>> = (opts.exercises || []).map(e => ({ ...e }))
  const workouts: Array<Record<string, any>> = (opts.workouts || []).map(w => ({ ...w, exercises: [...(w.exercises || [])] }))
  const programs: Array<Record<string, any>> = (opts.programs || []).map(p => ({ ...p, days: (p.days || []).map((d: any) => ({ ...d, exercises: [...(d.exercises || [])] })) }))

  const db = {
    collection(name: string) {
      if (name === 'exercises_library') {
        return {
          findOne: async (filter: { name?: string }) => exercises.find(e => e.name === filter.name) || null,
          updateOne: async (filter: { name?: string }, update: { $set: Record<string, any> }) => {
            const doc = exercises.find(e => e.name === filter.name)
            if (!doc) return { matchedCount: 0, modifiedCount: 0 }
            Object.assign(doc, update.$set)
            return { matchedCount: 1, modifiedCount: 1 }
          },
          deleteOne: async (filter: { name?: string }) => {
            const idx = exercises.findIndex(e => e.name === filter.name)
            if (idx === -1) return { deletedCount: 0 }
            exercises.splice(idx, 1)
            return { deletedCount: 1 }
          },
        }
      }
      if (name === 'workouts') {
        return {
          find: (filter: { 'exercises.name'?: string }) => ({
            toArray: async () =>
              workouts.filter(w => (w.exercises || []).some((e: any) => e.name === filter['exercises.name'])),
          }),
          updateOne: async (filter: { _id?: string }, update: { $set: Record<string, any> }) => {
            const doc = workouts.find(w => w._id === filter._id)
            if (!doc) return { matchedCount: 0 }
            Object.assign(doc, update.$set)
            return { matchedCount: 1 }
          },
        }
      }
      if (name === 'training_programs') {
        return {
          find: (filter: { 'days.exercises.name'?: string }) => ({
            toArray: async () =>
              programs.filter(p =>
                (p.days || []).some((d: any) => (d.exercises || []).some((e: any) => e.name === filter['days.exercises.name']))
              ),
          }),
          updateOne: async (filter: { _id?: string }, update: { $set: Record<string, any> }) => {
            const doc = programs.find(p => p._id === filter._id)
            if (!doc) return { matchedCount: 0 }
            Object.assign(doc, update.$set)
            return { matchedCount: 1 }
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workouts', workoutsRoute(() => db))
  return { app, exercises, workouts, programs }
}

const patchName = (app: any, source: string, target: unknown) =>
  request(app).patch(`/api/workouts/exercises/${encodeURIComponent(source)}/name`).send({ name: target })

describe('PATCH /api/workouts/exercises/:name/name (#1472)', () => {
  it('400 when target name is missing, empty, or not a string', async () => {
    const { app } = makeApp({ exercises: [{ name: 'Розводка в тренажері на груди' }] })
    const res1 = await patchName(app, 'Розводка в тренажері на груди', undefined)
    const res2 = await patchName(app, 'Розводка в тренажері на груди', '')
    const res3 = await patchName(app, 'Розводка в тренажері на груди', '   ')
    const res4 = await patchName(app, 'Розводка в тренажері на груди', 123)
    expect(res1.status).toBe(400)
    expect(res2.status).toBe(400)
    expect(res3.status).toBe(400)
    expect(res4.status).toBe(400)
  })

  it('400 when target === source', async () => {
    const { app } = makeApp({ exercises: [{ name: 'Планка' }] })
    const res = await patchName(app, 'Планка', 'Планка')
    expect(res.status).toBe(400)
  })

  it('404 on an unknown source name, touches nothing', async () => {
    const { app, workouts } = makeApp({
      exercises: [{ name: 'Планка' }],
      workouts: [{ _id: 'w1', exercises: [{ name: 'Планка', sets: [] }] }],
    })
    const res = await patchName(app, 'Неіснуюча', 'Планка')
    expect(res.status).toBe(404)
    expect(workouts[0].exercises[0].name).toBe('Планка') // untouched
  })

  it('simple rename (target does not exist yet): library doc renamed, session backfilled, merged=false', async () => {
    const { app, exercises, workouts } = makeApp({
      exercises: [{ name: 'Розводка в тренажері на груди', muscle_group: 'chest', equipment: null }],
      workouts: [
        {
          _id: 'w1',
          date: '2026-09-21',
          exercises: [{ name: 'Розводка в тренажері на груди', sets: [{ reps: 8, weight_kg: 20 }] }],
          needs_muscle_group_clarification: ['Розводка в тренажері на груди'],
        },
      ],
    })

    const res = await patchName(app, 'Розводка в тренажері на груди', 'Розводка в тренажері')

    expect(res.status).toBe(200)
    expect(res.body.merged).toBe(false)
    expect(res.body.renamed_sessions).toBe(1)
    expect(res.body.consolidated_sessions).toBe(0)
    expect(res.body.exercise.name).toBe('Розводка в тренажері')
    expect(exercises.length).toBe(1)
    expect(exercises[0].name).toBe('Розводка в тренажері')
    expect(workouts[0].exercises).toEqual([
      { name: 'Розводка в тренажері', sets: [{ reps: 8, weight_kg: 20 }] },
    ])
    expect(workouts[0].needs_muscle_group_clarification).toEqual(['Розводка в тренажері']) // renamed, deduped
  })

  it('merge (target already exists): target doc survives, source deleted, null fields backfilled from source, muscle_group NOT auto-filled', async () => {
    const { app, exercises } = makeApp({
      exercises: [
        { name: 'Розводка в тренажері', muscle_group: 'chest', equipment: null, video_url: null, weight_unit: 'kg' },
        { name: 'Розводка в тренажері на груди', muscle_group: null, equipment: 'machine', video_url: 'https://x', weight_unit: null },
      ],
    })

    const res = await patchName(app, 'Розводка в тренажері на груди', 'Розводка в тренажері')

    expect(res.status).toBe(200)
    expect(res.body.merged).toBe(true)
    expect(exercises.length).toBe(1) // source doc deleted
    expect(exercises[0].name).toBe('Розводка в тренажері')
    expect(exercises[0].equipment).toBe('machine') // backfilled — target's was null
    expect(exercises[0].video_url).toBe('https://x') // backfilled
    expect(exercises[0].weight_unit).toBe('kg') // target's own non-null value wins, NOT overwritten by source's null
    expect(exercises[0].muscle_group).toBe('chest') // untouched — muscle_group is not in the fillable list
  })

  it('merge + a session already logging BOTH names consolidates into ONE entry (sets target-then-source, order preserved), counted as consolidated not renamed', async () => {
    const { app, workouts } = makeApp({
      exercises: [
        { name: 'Розводка в тренажері' },
        { name: 'Розводка в тренажері на груди' },
      ],
      workouts: [
        {
          _id: 'w1',
          date: '2026-09-21',
          exercises: [
            { name: 'Розводка в тренажері', sets: [{ reps: 8, weight_kg: 30 }] },
            { name: 'Розводка в тренажері на груди', sets: [{ reps: 6, weight_kg: 32 }] },
          ],
        },
      ],
    })

    const res = await patchName(app, 'Розводка в тренажері на груди', 'Розводка в тренажері')

    expect(res.status).toBe(200)
    expect(res.body.renamed_sessions).toBe(0)
    expect(res.body.consolidated_sessions).toBe(1)
    expect(workouts[0].exercises).toHaveLength(1) // no leftover second entry (would be invisible to readers)
    expect(workouts[0].exercises[0].name).toBe('Розводка в тренажері')
    expect(workouts[0].exercises[0].sets).toEqual([
      { reps: 8, weight_kg: 30 }, // target's own set first
      { reps: 6, weight_kg: 32 }, // then source's
    ])
  })

  it('a session that only has the SOURCE name (target not logged there yet) is a plain rename even during a library-level merge', async () => {
    const { app, workouts } = makeApp({
      exercises: [{ name: 'Розводка в тренажері' }, { name: 'Розводка в тренажері на груди' }],
      workouts: [
        { _id: 'w1', exercises: [{ name: 'Розводка в тренажері на груди', sets: [{ reps: 5, weight_kg: 10 }] }] },
      ],
    })
    const res = await patchName(app, 'Розводка в тренажері на груди', 'Розводка в тренажері')
    expect(res.body.renamed_sessions).toBe(1)
    expect(res.body.consolidated_sessions).toBe(0)
    expect(workouts[0].exercises).toEqual([{ name: 'Розводка в тренажері', sets: [{ reps: 5, weight_kg: 10 }] }])
  })

  it('needs_unit_clarification is renamed+deduped the same way as needs_muscle_group_clarification', async () => {
    const { app, workouts } = makeApp({
      exercises: [{ name: 'A' }, { name: 'B' }],
      workouts: [
        {
          _id: 'w1',
          exercises: [{ name: 'A', sets: [] }],
          needs_unit_clarification: ['A', 'C'],
        },
      ],
    })
    const res = await patchName(app, 'A', 'B')
    expect(res.status).toBe(200)
    expect(workouts[0].needs_unit_clarification).toEqual(['B', 'C'])
  })

  it('backfills training_programs.days[].exercises[].name and counts updated_programs', async () => {
    const { app, programs } = makeApp({
      exercises: [{ name: 'Розводка в тренажері' }, { name: 'Розводка в тренажері на груди' }],
      programs: [
        {
          _id: 'prog1',
          is_active: true,
          days: [
            { day: 1, exercises: [{ name: 'Розводка в тренажері на груди', target_reps: '8-10' }] },
            { day: 2, exercises: [{ name: 'Присідання', target_reps: '5' }] },
          ],
        },
        { _id: 'prog2', is_active: false, days: [{ day: 1, exercises: [{ name: 'Присідання' }] }] },
      ],
    })

    const res = await patchName(app, 'Розводка в тренажері на груди', 'Розводка в тренажері')

    expect(res.status).toBe(200)
    expect(res.body.updated_programs).toBe(1)
    expect(programs[0].days[0].exercises[0].name).toBe('Розводка в тренажері')
    expect(programs[0].days[1].exercises[0].name).toBe('Присідання') // sibling untouched
    expect(programs[1].days[0].exercises[0].name).toBe('Присідання') // unrelated program untouched
  })

  it('no matching sessions or programs: renamed_sessions/consolidated_sessions/updated_programs all 0', async () => {
    const { app } = makeApp({ exercises: [{ name: 'Планка' }] })
    const res = await patchName(app, 'Планка', 'Планка (нова)')
    expect(res.status).toBe(200)
    expect(res.body.renamed_sessions).toBe(0)
    expect(res.body.consolidated_sessions).toBe(0)
    expect(res.body.updated_programs).toBe(0)
  })
})

export {}
