/**
 * ROUTE-LEVEL test for GET /api/workouts/exercises/catalog(/:source_id) — #1334
 * (Ф3/#1331, ЕТАП 1, health-api only). Drives the REAL router via supertest against a
 * fake in-memory `exercises_catalog` collection (same pattern as
 * foods_search_regex_escape.test.ts, #1225's "mirror test" lesson) — not a copy of
 * routes/exercises_catalog.js's own escaping/pagination logic.
 *
 * WHAT THIS COVERS (per #1334 acceptance + the queue-#6180 stage-1 acceptance):
 *  - empty collection -> {items:[], total:0}, HTTP 200 (not 500, not HTML) — this is
 *    the pre-#1332-merge state; #1332 has since merged+deployed live with 876 real
 *    docs, so this case is only reachable via the fake collection now, not a live curl.
 *  - server-side pagination actually slices (limit/offset), not just caps a full fetch.
 *  - search by name_ua AND name_en, case-insensitive, regex-metachar-safe (catalog
 *    names carry parens/slashes for real: "3/4 Sit-Up", "90/90 Hamstring Lift").
 *  - equipment/muscle filters hit the #1332-MAPPED fields (`equipment`,
 *    `muscle_group`), never the raw `equipment_src`/`primary_muscles_src` — filtering
 *    on raw source values would reopen bug #1310 one layer up (#1331 #7551 §2).
 *  - list response never carries instructions_en/instructions_ua (heavy fields).
 *  - detail endpoint returns the full doc incl. instructions; 404 for unknown id.
 *
 * RED-FIRST: an unescaped `$regex` on `q=3/4` or `q=(` throws inside the fake
 * collection's regex compile (mirrors MongoDB's real behaviour) and would 500 the
 * whole request without routes/exercises_catalog.js's escapeRegex — verified by
 * temporarily removing the escape call, see below is the guard this locks in.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const catalogRouter = require('../../routes/exercises_catalog')

type Doc = Record<string, any>

function applyProjection(doc: Doc, projection?: Record<string, 0 | 1>) {
  if (!projection) return doc
  const excluded = Object.keys(projection).filter((k) => projection[k] === 0)
  if (excluded.length === 0) return doc
  const out: Doc = { ...doc }
  for (const key of excluded) delete out[key]
  return out
}

function makeFakeCollection(docs: Doc[]) {
  function matches(doc: Doc, filter: Doc): boolean {
    if (filter.$or) {
      return filter.$or.some((clause: Doc) => matches(doc, clause))
    }
    return Object.keys(filter).every((field) => {
      const cond = filter[field]
      if (cond && typeof cond === 'object' && '$regex' in cond) {
        // Mirrors real Mongo: an unescaped metachar throws here — same failure class
        // as a live 500, without re-implementing exercises_catalog.js's escaping.
        const re = new RegExp(cond.$regex, cond.$options)
        return typeof doc[field] === 'string' && re.test(doc[field])
      }
      return doc[field] === cond
    })
  }

  return {
    find(filter: Doc, opts?: { projection?: Record<string, 0 | 1> }) {
      const matched = docs.filter((d) => matches(d, filter))
      let sorted = matched
      return {
        sort(spec: Record<string, 1 | -1>) {
          const [[field, dir]] = Object.entries(spec)
          sorted = [...matched].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir as number))
          return this
        },
        skip(n: number) {
          sorted = sorted.slice(n)
          return this
        },
        limit(n: number) {
          sorted = sorted.slice(0, n)
          return this
        },
        toArray: async () => sorted.map((d) => applyProjection(d, opts?.projection)),
      }
    },
    countDocuments: async (filter: Doc) => docs.filter((d) => matches(d, filter)).length,
    findOne: async (filter: Doc) => docs.find((d) => matches(d, filter)) || null,
  }
}

function makeGetDB(docs: Doc[]) {
  return () => ({
    collection(name: string) {
      if (name !== 'exercises_catalog') throw new Error(`unexpected collection: ${name}`)
      return makeFakeCollection(docs)
    },
  })
}

function makeApp(docs: Doc[]) {
  const app = express()
  app.use('/api/workouts', catalogRouter(makeGetDB(docs)))
  return app
}

function doc(overrides: Partial<Doc>): Doc {
  return {
    source_id: 'X',
    name_en: 'X',
    name_ua: null,
    equipment: null,
    equipment_src: null,
    muscle_group: null,
    primary_muscles_src: [],
    secondary_muscles_src: [],
    category: 'strength',
    level: 'beginner',
    force: null,
    mechanic: null,
    instructions_en: ['step 1', 'step 2'],
    instructions_ua: null,
    images: [],
    source: 'free-exercise-db',
    source_url: 'https://github.com/yuhonas/free-exercise-db',
    source_license: 'Unlicense',
    verified_at: new Date('2026-09-10'),
    ...overrides,
  }
}

const CATALOG: Doc[] = [
  doc({ source_id: '3_4_Sit-Up', name_en: '3/4 Sit-Up', name_ua: 'Неповне підняття тулуба', equipment: 'bodyweight', muscle_group: 'core' }),
  doc({ source_id: 'Barbell_Bench_Press', name_en: 'Barbell Bench Press', name_ua: 'Жим штанги лежачи', equipment: 'barbell', muscle_group: 'chest' }),
  doc({ source_id: 'Kettlebell_Halo', name_en: 'Kettlebell Halo', name_ua: 'Гиря Хало', equipment: 'kettlebell', muscle_group: 'shoulders' }),
  doc({ source_id: '90_90_Hamstring', name_en: '90/90 Hamstring', name_ua: null, equipment: null, muscle_group: 'legs' }),
  doc({ source_id: 'Romanian_Deadlift', name_en: 'Romanian Deadlift', name_ua: 'Румунська тяга', equipment: 'barbell', muscle_group: 'legs' }),
]

describe('GET /api/workouts/exercises/catalog — empty collection (#1334 stage-1 acceptance)', () => {
  it('returns {items:[], total:0} with HTTP 200, not 500/HTML', async () => {
    const res = await request(makeApp([])).get('/api/workouts/exercises/catalog')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], total: 0, limit: 30, offset: 0 })
  })
})

describe('GET /api/workouts/exercises/catalog — pagination actually slices, not just caps', () => {
  it('limit=2 offset=0 returns 2 of 5, total stays 5', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ limit: 2, offset: 0 })
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2)
    expect(res.body.total).toBe(5)
    expect(res.body.limit).toBe(2)
    expect(res.body.offset).toBe(0)
  })

  it('limit=2 offset=2 returns the NEXT 2, not the same 2', async () => {
    const page1 = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ limit: 2, offset: 0 })
    const page2 = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ limit: 2, offset: 2 })
    const ids1 = page1.body.items.map((i: Doc) => i.source_id)
    const ids2 = page2.body.items.map((i: Doc) => i.source_id)
    expect(ids1).not.toEqual(ids2)
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0)
  })

  it('limit is clamped to MAX_LIMIT (100), never returns the whole 876-shaped set unbounded', async () => {
    const big = Array.from({ length: 150 }, (_, i) => doc({ source_id: `S${i}`, name_en: `Ex ${i}` }))
    const res = await request(makeApp(big)).get('/api/workouts/exercises/catalog').query({ limit: 9999 })
    expect(res.body.items.length).toBeLessThanOrEqual(100)
    expect(res.body.limit).toBeLessThanOrEqual(100)
  })

  it('invalid limit/offset fall back to sane defaults instead of 500ing', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ limit: 'abc', offset: '-5' })
    expect(res.status).toBe(200)
    expect(res.body.limit).toBe(30)
    expect(res.body.offset).toBe(0)
  })
})

describe('GET /api/workouts/exercises/catalog — search by name_ua/name_en, regex-safe', () => {
  it('q=3/4 does not 500 (real catalog name has a slash — "3/4 Sit-Up")', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ q: '3/4' })
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: Doc) => i.source_id)).toEqual(['3_4_Sit-Up'])
  })

  it('q=( does not 500', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ q: '(' })
    expect(res.status).toBe(200)
  })

  it('matches on name_ua (Ukrainian, case-insensitive)', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ q: 'румунська' })
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: Doc) => i.source_id)).toEqual(['Romanian_Deadlift'])
  })

  it('matches on name_en when name_ua is still null (pre-Ф2 translation state)', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ q: '90/90' })
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: Doc) => i.source_id)).toEqual(['90_90_Hamstring'])
  })

  it('empty q returns the unfiltered (paginated) list, not an empty result', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ q: '' })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(5)
  })
})

describe('GET /api/workouts/exercises/catalog — equipment/muscle filters use the #1332-MAPPED fields', () => {
  it('equipment=barbell filters on the mapped `equipment` field, not equipment_src', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ equipment: 'barbell' })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items.map((i: Doc) => i.source_id).sort()).toEqual(['Barbell_Bench_Press', 'Romanian_Deadlift'])
  })

  it('muscle=legs filters on the mapped `muscle_group` field, not primary_muscles_src', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ muscle: 'legs' })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items.map((i: Doc) => i.source_id).sort()).toEqual(['90_90_Hamstring', 'Romanian_Deadlift'])
  })

  it('equipment + muscle combined narrows further', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ equipment: 'barbell', muscle: 'legs' })
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: Doc) => i.source_id)).toEqual(['Romanian_Deadlift'])
  })
})

describe('GET /api/workouts/exercises/catalog — list never carries heavy instruction fields', () => {
  it('items omit instructions_en and instructions_ua', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog')
    expect(res.status).toBe(200)
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty('instructions_en')
      expect(item).not.toHaveProperty('instructions_ua')
    }
  })

  it('items still carry name_en/name_ua/equipment/muscle_group/images for card rendering', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog').query({ limit: 1 })
    const item = res.body.items[0]
    expect(item).toHaveProperty('name_en')
    expect(item).toHaveProperty('equipment')
    expect(item).toHaveProperty('muscle_group')
    expect(item).toHaveProperty('images')
  })
})

describe('GET /api/workouts/exercises/catalog/:source_id — detail view', () => {
  it('returns the full document including instructions', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog/Barbell_Bench_Press')
    expect(res.status).toBe(200)
    expect(res.body.source_id).toBe('Barbell_Bench_Press')
    expect(res.body.instructions_en).toEqual(['step 1', 'step 2'])
  })

  it('returns 404 (not 500, not a silent empty 200) for an unknown source_id', async () => {
    const res = await request(makeApp(CATALOG)).get('/api/workouts/exercises/catalog/does-not-exist')
    expect(res.status).toBe(404)
  })
})

export {}
