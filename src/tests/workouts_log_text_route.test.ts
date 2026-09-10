/**
 * Route-level wiring test for POST /api/workouts/log-text (#1314). Mounts the REAL
 * route factory (routes/workouts.js) with a stub DB covering `exercises_library` and
 * `workouts`, same pattern as workouts_progression_route.test.ts (#1291). Parsing and
 * conversion logic themselves are unit-tested in workout_log_parser.test.ts /
 * workout_log_write.test.ts — this file proves the ROUTE wires them together correctly:
 * weight_unit lookup, auto-create of an unknown exercise, and the idempotent
 * insert-vs-merge branch against the `workouts` collection.
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
}) {
  const exercises: Array<Record<string, any>> = opts.exercises || []
  const workouts: Array<Record<string, any>> = opts.workouts || []

  const db = {
    collection(name: string) {
      if (name === 'exercises_library') {
        return {
          findOne: async (filter: any) => {
            const re = filter.name.$regex
            return exercises.find(e => re.test(e.name as string)) || null
          },
          insertOne: async (doc: any) => {
            const _id = `lib_${exercises.length + 1}`
            exercises.push({ ...doc, _id })
            return { insertedId: _id }
          },
          updateOne: async (filter: any, update: any) => {
            const doc = exercises.find(e => e._id === filter._id)
            if (doc) Object.assign(doc, update.$set)
            return { matchedCount: doc ? 1 : 0 }
          },
        }
      }
      if (name === 'workouts') {
        return {
          findOne: async (filter: any) =>
            workouts.find(w => w.date === filter.date && w.source === filter.source) || null,
          insertOne: async (doc: any) => {
            const _id = `wk_${workouts.length + 1}`
            workouts.push({ ...doc, _id })
            return { insertedId: _id }
          },
          updateOne: async (filter: any, update: any) => {
            const doc = workouts.find(w => w._id === filter._id)
            if (doc) Object.assign(doc, update.$set)
            return { matchedCount: doc ? 1 : 0 }
          },
        }
      }
      throw new Error(`unexpected collection: ${name}`)
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workouts', workoutsRoute(() => db))
  return { app, exercises, workouts }
}

describe('POST /api/workouts/log-text', () => {
  it('400 when text is missing', async () => {
    const { app } = makeApp({})
    const res = await request(app).post('/api/workouts/log-text').send({})
    expect(res.status).toBe(400)
  })

  it('400 when text has zero parseable lines', async () => {
    const { app } = makeApp({})
    const res = await request(app).post('/api/workouts/log-text').send({ text: 'нічого тут немає' })
    expect(res.status).toBe(400)
    expect(res.body.skipped).toBeDefined()
  })

  it("201, creates a new session doc, NEVER silently defaults an unknown unit to kg, preserves weight_input the owner said, flags the session as needing clarification (#1318 KROK 1)", async () => {
    const { app, workouts } = makeApp({
      exercises: [{ _id: 'lib_1', name: 'Тяга блока', weight_unit: null }],
    })
    const text = 'Тяга блока: 8х52 · 8х66 · 8х73 · 8х73'
    const res = await request(app)
      .post('/api/workouts/log-text')
      .send({ date: '2026-09-09', text })

    expect(res.status).toBe(201)
    expect(res.body.date).toBe('2026-09-09')
    expect(res.body.source).toBe('telegram-log')
    expect(res.body.exercises).toHaveLength(1)
    const sets = res.body.exercises[0].sets
    expect(sets.map((s: any) => s.reps)).toEqual([8, 8, 8, 8])
    expect(sets.map((s: any) => s.weight_input)).toEqual([52, 66, 73, 73])
    // unit not set on this exercise -> weight_kg stays null, NEVER silently defaulted to
    // kg (this is exactly the #1318 bug: 0ecbcf0 wrote [52,66,73,73] here before the fix)
    expect(sets.every((s: any) => s.weight_kg === null)).toBe(true)
    expect(res.body.needs_unit_clarification).toEqual(['Тяга блока'])
    expect(workouts).toHaveLength(1)
    expect(workouts[0].needs_unit_clarification).toEqual(['Тяга блока'])
  })

  it("#1318 regression: dictated 'Розводка: 10х235' does NOT resolve to weight_kg=235 (235 is the owner's lb stack reading, not kg) — weight_input is preserved, weight_kg stays null, exercise is flagged", async () => {
    const { app } = makeApp({ exercises: [] })
    const res = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text: 'Розводка: 10х235' })
    const set = res.body.exercises[0].sets[0]
    expect(set.weight_input).toBe(235)
    expect(set.weight_kg).not.toBe(235)
    expect(set.weight_kg).toBeNull()
    expect(res.body.needs_unit_clarification).toEqual(['Розводка'])
  })

  it('auto-creates a missing exercises_library entry with unit "не задано" (null), does not invent equipment or a unit', async () => {
    const { app, exercises } = makeApp({ exercises: [] })
    await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text: 'Розводка: 10х235' })
    expect(exercises).toHaveLength(1)
    expect(exercises[0]).toMatchObject({ name: 'Розводка', equipment: null, weight_unit: null })
  })

  it('a mixed session (one exercise with a known unit, one without) flags only the unresolved exercise', async () => {
    const { app } = makeApp({
      exercises: [
        { _id: 'lib_1', name: 'Жим під нахилом', weight_unit: 'kg' },
        { _id: 'lib_2', name: 'Скотта', weight_unit: null },
      ],
    })
    const res = await request(app).post('/api/workouts/log-text').send({
      date: '2026-09-09',
      text: 'Жим під нахилом: 8х80\nСкотта: 6х160 · 6х160 · 6х145',
    })
    expect(res.body.needs_unit_clarification).toEqual(['Скотта'])
  })

  it('resolves weight_kg when the exercise has a known kg unit', async () => {
    const { app } = makeApp({ exercises: [{ name: 'Жим під нахилом', weight_unit: 'kg' }] })
    const res = await request(app)
      .post('/api/workouts/log-text')
      .send({ date: '2026-09-09', text: 'Жим під нахилом: 8х80 · 7х80 · 6х80' })
    const sets = res.body.exercises[0].sets
    expect(sets.every((s: any) => s.weight_kg === 80)).toBe(true)
  })

  it('idempotent: re-POSTing the SAME text does not duplicate the exercise or the session doc', async () => {
    const { app, workouts } = makeApp({ exercises: [{ _id: 'lib_1', name: 'Тяга блока', weight_unit: null }] })
    const text = 'Тяга блока: 8х52 · 8х66 · 8х73 · 8х73'
    const res1 = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text })
    expect(res1.status).toBe(201)
    const res2 = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text })
    expect(res2.status).toBe(200) // merged into existing, not a new doc
    expect(workouts).toHaveLength(1)
    expect(workouts[0].exercises).toHaveLength(1)
    expect(workouts[0].exercises[0].sets).toHaveLength(4)
  })

  it('needs_unit_clarification clears once the library entry gets a unit and the exercise is re-merged (KROK 2 will drive this via its own PATCH)', async () => {
    const { app, exercises, workouts } = makeApp({ exercises: [{ _id: 'lib_1', name: 'Тяга блока', weight_unit: null }] })
    const text = 'Тяга блока: 8х52 · 8х66 · 8х73 · 8х73'
    const res1 = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text })
    expect(res1.body.needs_unit_clarification).toEqual(['Тяга блока'])

    // simulate KROK 2 resolving the unit (owner answered "кг" once) — this route itself
    // never writes weight_unit, some future mechanism will
    exercises[0].weight_unit = 'kg'

    const res2 = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text })
    expect(res2.body.needs_unit_clarification).toEqual([])
    expect(res2.body.exercises[0].sets.every((s: any) => s.weight_kg !== null)).toBe(true)
    expect(workouts[0].needs_unit_clarification).toEqual([])
  })

  it('a second exercise on the same date is appended to the SAME session doc, not a new one', async () => {
    const { app, workouts } = makeApp({
      exercises: [{ _id: 'lib_1', name: 'Тяга блока', weight_unit: null }, { _id: 'lib_2', name: 'Розводка', weight_unit: null }],
    })
    await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text: 'Тяга блока: 8х52' })
    const res2 = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text: 'Розводка: 10х235' })
    expect(res2.status).toBe(200)
    expect(workouts).toHaveLength(1)
    expect(workouts[0].exercises.map((e: any) => e.name)).toEqual(['Тяга блока', 'Розводка'])
  })

  it('a manual UI entry (source=manual) for the same date is a SEPARATE doc from a telegram-log entry', async () => {
    const { app, workouts } = makeApp({
      exercises: [{ _id: 'lib_1', name: 'Тяга блока', weight_unit: null }],
      workouts: [{ date: '2026-09-09', source: 'manual', exercises: [{ name: 'Планка', sets: [] }] }],
    })
    const res = await request(app).post('/api/workouts/log-text').send({ date: '2026-09-09', text: 'Тяга блока: 8х52' })
    expect(res.status).toBe(201) // no existing telegram-log doc for this date -> new doc
    expect(workouts).toHaveLength(2)
  })

  it('a line that fails to parse is reported in `skipped`, good lines on the same request still write', async () => {
    const { app } = makeApp({ exercises: [{ _id: 'lib_1', name: 'Тяга блока', weight_unit: null }] })
    const res = await request(app)
      .post('/api/workouts/log-text')
      .send({ date: '2026-09-09', text: 'сміття без двокрапки\nТяга блока: 8х52' })
    expect(res.status).toBe(201)
    expect(res.body.exercises).toHaveLength(1)
    expect(res.body.skipped).toEqual([{ line: 'сміття без двокрапки', reason: 'no_colon' }])
  })
})

export {}
