/**
 * #870 (approved 19.09, apex triage comment #8218): the two remaining live
 * defects in `routes/labs.js` after #971 (date-swap front-half) and #1415
 * (one document excluded) were closed the class, not the symptom, here:
 *
 *  A1 — plausibility validation on write (parsePdfText): a garbled parse
 *       (alt=184 when ref is 7-40, hba1c=1 when ref is 4.0-5.7, free_t4=4 when
 *       ref is 10.0-25.0, vitamin_b12=12 when ref is 148-740) must go to
 *       `parse_warnings`, never into `values`.
 *  A2 — date is required provenance: no silent `new Date()` fallback; missing
 *       date (no `req.body.date`, no PDF-detected date) → 400, no document.
 *  A3 — two uploads for the same date merge into ONE document (no dedup /
 *       first-seen-wins race), a null slot does not "occupy" a key, and a real
 *       conflicting value is kept + flagged, never silently overwritten.
 *  A4 — GET /latest carries `age_days` per marker (Kyiv calendar day).
 *
 * Unit-level assertions call the REAL `parsePdfText`/`isPlausible` exported
 * from `../../routes/labs` (see the module's test-only exports) — not a
 * second copy of the logic (the mirror-test trap this repo already has one
 * instance of in labs.test.ts).
 *
 * Route-level assertions run supertest against the REAL `makeRouter` factory
 * with a minimal in-memory Mongo-shaped fake (insertOne/updateOne/findOne/find
 * matching exactly the queries `routes/labs.js` issues), and mock `pdf-parse`
 * so a real (fake) PDF buffer never needs to be parsed — this test controls
 * the extracted TEXT, exactly like `pdf-parse` would hand it to the route.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')

let mockPdfText = ''
jest.mock('pdf-parse', () => jest.fn(() => Promise.resolve({ text: mockPdfText })))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const labsRoute = require('../../routes/labs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { formatDateKyiv, daysBetweenDateStrings } = require('../../lib/training-program')

// ---------------------------------------------------------------------------
// A1 — unit-level: parsePdfText plausibility (real production function)
// ---------------------------------------------------------------------------
describe('parsePdfText — plausibility validation (#870 A1)', () => {
  it('alt=184 (ref 7-40) goes to warnings, not values (the real #1409 garbled number)', () => {
    const { values, warnings } = labsRoute.parsePdfText('АЛТ (аланінамінотрансфераза) 184 Од/л високий')
    expect(values.alt).toBeUndefined()
    expect(warnings.alt).toBeDefined()
    expect(warnings.alt.value).toBe(184)
  })

  it('hba1c=1 (ref 4.0-5.7) goes to warnings, not values', () => {
    const { values, warnings } = labsRoute.parsePdfText('Глікований гемоглобін HbA1c 1 % низький')
    expect(values.hba1c).toBeUndefined()
    expect(warnings.hba1c).toBeDefined()
  })

  it('free_t4=4 (ref 10.0-25.0) goes to warnings, not values', () => {
    const { values, warnings } = labsRoute.parsePdfText('Т4 вільний 4 пмоль/л низький')
    expect(values.free_t4).toBeUndefined()
    expect(warnings.free_t4).toBeDefined()
  })

  it('vitamin_b12=12 (ref 148-740) goes to warnings, not values', () => {
    const { values, warnings } = labsRoute.parsePdfText('Вітамін B12 12 пмоль/л низький')
    expect(values.vitamin_b12).toBeUndefined()
    expect(warnings.vitamin_b12).toBeDefined()
  })

  it('a real, merely low-normal value (alt=23, within widened window) is accepted, not warned', () => {
    const { values, warnings } = labsRoute.parsePdfText('АЛТ (аланінамінотрансфераза) 23 Од/л нормальний')
    expect(values.alt).toBe(23)
    expect(warnings.alt).toBeUndefined()
  })

  it('isPlausible: [min*0.5, max*3] window is exactly what the 4 known-bad numbers fail', () => {
    expect(labsRoute.isPlausible('alt', 184)).toBe(false)   // ref 7-40 → window 3.5-120
    expect(labsRoute.isPlausible('hba1c', 1)).toBe(false)   // ref 4.0-5.7 → window 2.0-17.1
    expect(labsRoute.isPlausible('free_t4', 4)).toBe(false) // ref 10-25 → window 5-75
    expect(labsRoute.isPlausible('vitamin_b12', 12)).toBe(false) // ref 148-740 → window 74-2220
    expect(labsRoute.isPlausible('alt', 23)).toBe(true)
    expect(labsRoute.isPlausible('testosterone', 11.8)).toBe(true) // real low-normal, ref min 12.1
  })
})

// ---------------------------------------------------------------------------
// Route-level fake DB — mirrors exactly the queries POST /upload and
// GET /latest issue against `lab_results`.
// ---------------------------------------------------------------------------
function makeFakeDb(initialRows: Array<Record<string, any>> = []) {
  const rows: Array<Record<string, any>> = initialRows.map((r) => ({ ...r }))
  let nextId = 0
  return {
    _rows: rows,
    collection(name: string) {
      if (name !== 'lab_results') throw new Error(`unexpected collection ${name}`)
      return {
        find(filter: Record<string, any> = {}) {
          const excludedFilter = filter.excluded as { $ne?: unknown } | undefined
          const filtered = rows.filter((r) => {
            if (excludedFilter && '$ne' in excludedFilter) return r.excluded !== excludedFilter.$ne
            return true
          })
          return {
            sort() { return this },
            toArray: async () => filtered,
          }
        },
        findOne: async (filter: Record<string, any>) => {
          if (filter._id !== undefined) {
            return rows.find((r) => r._id === filter._id) || null
          }
          if (filter.date !== undefined) {
            const excludedFilter = filter.excluded as { $ne?: unknown } | undefined
            return (
              rows.find(
                (r) =>
                  r.date === filter.date &&
                  (!excludedFilter || r.excluded !== excludedFilter.$ne)
              ) || null
            )
          }
          return null
        },
        insertOne: async (doc: Record<string, any>) => {
          const _id = `fake-${nextId++}`
          rows.push({ ...doc, _id })
          return { insertedId: _id }
        },
        updateOne: async (filter: Record<string, any>, update: Record<string, any>) => {
          const row = rows.find((r) => r._id === filter._id)
          if (!row) return { modifiedCount: 0 }
          Object.assign(row, update.$set)
          return { modifiedCount: 1 }
        },
      }
    },
  }
}

function makeApp(db: ReturnType<typeof makeFakeDb>) {
  const app = express()
  app.use('/api/labs', labsRoute(() => db))
  return app
}

// ---------------------------------------------------------------------------
// A2 — date is required provenance
// ---------------------------------------------------------------------------
describe('POST /api/labs/upload — date provenance (#870 A2)', () => {
  it('no req.body.date, no PDF-detected date → 400, no document created', async () => {
    mockPdfText = 'Глюкоза 5.1 ммоль/л нормальний' // recognizable value, NO date anywhere
    const db = makeFakeDb()
    const app = makeApp(db)

    const res = await request(app)
      .post('/api/labs/upload')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'no_date.pdf')

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/дату/i)
    expect(db._rows.length).toBe(0) // #870 A2: never a silent today-dated document
  })

  it('req.body.date wins over an absent PDF date → date_source:"manual", written to the DOCUMENT', async () => {
    mockPdfText = 'Глюкоза 5.1 ммоль/л нормальний'
    const db = makeFakeDb()
    const app = makeApp(db)

    const res = await request(app)
      .post('/api/labs/upload')
      .field('date', '2026-01-15')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'manual_date.pdf')

    expect(res.status).toBe(200)
    expect(res.body.date_source).toBe('manual')
    expect(res.body.entry.date).toBe('2026-01-15')
    // provenance is on the DOCUMENT, not just the response (#870's core complaint)
    expect(db._rows[0].date_source).toBe('manual')
    expect(db._rows[0].detected_date).toBeNull()
  })

  it('a PDF-detected date is used when no manual date is given → date_source:"pdf"', async () => {
    mockPdfText = 'Дата взяття: 03.11.2025\nГлюкоза 5.1 ммоль/л нормальний'
    const db = makeFakeDb()
    const app = makeApp(db)

    const res = await request(app)
      .post('/api/labs/upload')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'pdf_date.pdf')

    expect(res.status).toBe(200)
    expect(res.body.date_source).toBe('pdf')
    expect(res.body.entry.date).toBe('2025-11-03')
    expect(db._rows[0].detected_date).toBe('2025-11-03')
  })
})

// ---------------------------------------------------------------------------
// A1 (route level) — an implausible value never enters `values`, doc flagged
// ---------------------------------------------------------------------------
describe('POST /api/labs/upload — implausible values flagged, not stored as values (#870 A1)', () => {
  it('alt=184 lands in parse_warnings + needs_review:true, absent from values and /latest', async () => {
    mockPdfText = 'Дата взяття: 01.02.2026\nАЛТ (аланінамінотрансфераза) 184 Од/л високий'
    const db = makeFakeDb()
    const app = makeApp(db)

    const uploadRes = await request(app)
      .post('/api/labs/upload')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'garbled.pdf')

    expect(uploadRes.status).toBe(200)
    expect(uploadRes.body.entry.values.alt).toBeUndefined()
    expect(uploadRes.body.entry.parse_warnings.alt.value).toBe(184)
    expect(uploadRes.body.entry.needs_review).toBe(true)

    const latestRes = await request(app).get('/api/labs/latest')
    expect(latestRes.body.alt).toBeUndefined() // never won a /latest slot
  })
})

// ---------------------------------------------------------------------------
// A3 — dedup by date: merge, not a second competing document
// ---------------------------------------------------------------------------
describe('POST /api/labs/upload — same-date dedup/merge (#870 A3)', () => {
  it('second upload for an existing date MERGES values into the same document (no 2nd insert)', async () => {
    mockPdfText = 'Дата взяття: 01.03.2026\nАЛТ (аланінамінотрансфераза) 23 Од/л нормальний'
    const db = makeFakeDb()
    const app = makeApp(db)

    const first = await request(app)
      .post('/api/labs/upload')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'first.pdf')
    expect(first.status).toBe(200)
    expect(db._rows.length).toBe(1)

    mockPdfText = 'Дата взяття: 01.03.2026\nГлюкоза 5.1 ммоль/л нормальний'
    const second = await request(app)
      .post('/api/labs/upload')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'second.pdf')

    expect(second.status).toBe(200)
    expect(second.body.merged).toBe(true)
    expect(db._rows.length).toBe(1) // no second insert
    expect(db._rows[0].values.alt).toBe(23)
    expect(db._rows[0].values.glucose).toBe(5.1)
  })

  it('a null/missing existing slot does NOT occupy the key — the new real value wins (Max #1415 Low)', async () => {
    const db = makeFakeDb([
      { _id: 'x1', date: '2026-04-01', values: { hba1c: null, alt: 23 }, source: 'pdf', filename: 'a.pdf' },
    ])
    mockPdfText = 'Глікований гемоглобін HbA1c 5.2 % нормальний'
    const app = makeApp(db)

    const res = await request(app)
      .post('/api/labs/upload')
      .field('date', '2026-04-01')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'b.pdf')

    expect(res.status).toBe(200)
    expect(res.body.merged).toBe(true)
    expect(db._rows.length).toBe(1)
    expect(db._rows[0].values.hba1c).toBe(5.2) // filled, not left null
  })

  it('a real conflicting non-null value is KEPT (not overwritten) and flagged needs_review + merge_conflicts', async () => {
    const db = makeFakeDb([
      { _id: 'x2', date: '2026-05-01', values: { alt: 23 }, source: 'pdf', filename: 'a.pdf' },
    ])
    mockPdfText = 'АЛТ (аланінамінотрансфераза) 30 Од/л нормальний' // different but still plausible
    const app = makeApp(db)

    const res = await request(app)
      .post('/api/labs/upload')
      .field('date', '2026-05-01')
      .attach('pdf', Buffer.from('%PDF-1.4 fake'), 'b.pdf')

    expect(res.status).toBe(200)
    expect(res.body.conflicts).toBe(1)
    expect(db._rows[0].values.alt).toBe(23) // kept, not silently overwritten by 30
    expect(db._rows[0].merge_conflicts.alt).toEqual({ kept: 23, incoming: 30 })
    expect(db._rows[0].needs_review).toBe(true)
    expect(db._rows.length).toBe(1) // still no deleteOne / second insert
  })
})

// ---------------------------------------------------------------------------
// A4 — GET /latest carries age_days (Kyiv calendar day)
// ---------------------------------------------------------------------------
describe('GET /api/labs/latest — age_days per marker (#870 A4)', () => {
  it('age_days is the Kyiv-day distance from the entry date to today, via the shared helper', async () => {
    const db = makeFakeDb([
      { _id: 'y1', date: '2025-11-03', values: { alt: 23 }, source: 'pdf', filename: 'synevo.pdf' },
    ])
    const app = makeApp(db)

    const res = await request(app).get('/api/labs/latest')
    expect(res.status).toBe(200)
    const expectedAge = daysBetweenDateStrings('2025-11-03', formatDateKyiv(new Date()))
    expect(res.body.alt.age_days).toBe(expectedAge)
    expect(res.body.alt.date).toBe('2025-11-03')
  })
})

export {}
