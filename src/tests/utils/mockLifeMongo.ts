/**
 * Minimal in-memory Mongo-collection stub for the `life_*` route-level tests
 * (#1519). Same spirit as the inline stub DBs already used by
 * readiness_route.test.ts / workouts_exercise_trends_route.test.ts, but
 * shared here because 4+ life_* test files need the SAME small surface:
 * find().sort().toArray(), findOne, countDocuments, insertOne,
 * findOneAndUpdate (with upsert + returnDocument:'after').
 *
 * Deliberately NOT a general Mongo emulator — only the operators the
 * life_* routes actually issue: plain equality, `$ne`, `$in`, `$set`.
 *
 * #1587: added `deleteOne` for the new `DELETE /rules/:id/check` route
 * (routes/life_habits.js) — same minimal-surface principle as the rest of
 * this stub.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb')

type Doc = Record<string, any>

function matchesOne(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined
  if (cond && typeof cond === 'object' && !(cond instanceof ObjectId)) {
    if ('$ne' in cond) {
      if (cond.$ne === null) return value !== null && value !== undefined
      return String(value) !== String(cond.$ne)
    }
    if ('$gte' in cond || '$lte' in cond) {
      if (value === undefined || value === null) return false
      if ('$gte' in cond && !(value >= cond.$gte)) return false
      if ('$lte' in cond && !(value <= cond.$lte)) return false
      return true
    }
    if ('$in' in cond) {
      const set = new Set((cond.$in as any[]).map((v) => String(v)))
      return set.has(String(value))
    }
    return false
  }
  if (cond instanceof ObjectId) return String(value) === String(cond)
  return value === cond || String(value) === String(cond)
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => matchesOne(doc[key], cond))
}

export function makeMockCollection(initial: Doc[] = []) {
  const docs: Doc[] = initial.map((d) => ({ ...d }))

  return {
    _docs: () => docs,
    find(filter: Doc = {}) {
      const result = docs.filter((d) => matches(d, filter))
      let sortField: string | null = null
      let sortDir = 1
      let lim = Infinity
      return {
        limit(n: number) {
          lim = n
          return this
        },
        sort(spec: Doc) {
          const [field, dir] = Object.entries(spec)[0] as [string, number]
          sortField = field
          sortDir = dir as number
          return this
        },
        async toArray() {
          const out = [...result]
          if (sortField) {
            const f = sortField
            out.sort((a, b) => ((a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0)) * sortDir)
          }
          return out.slice(0, lim)
        },
      }
    },
    async findOne(filter: Doc = {}) {
      return docs.find((d) => matches(d, filter)) || null
    },
    async countDocuments(filter: Doc = {}) {
      return docs.filter((d) => matches(d, filter)).length
    },
    async insertOne(doc: Doc) {
      const _id = doc._id || new ObjectId()
      const stored = { ...doc, _id }
      docs.push(stored)
      return { insertedId: _id }
    },
    async deleteOne(filter: Doc) {
      const idx = docs.findIndex((d) => matches(d, filter))
      if (idx === -1) return { deletedCount: 0 }
      docs.splice(idx, 1)
      return { deletedCount: 1 }
    },
    async findOneAndUpdate(filter: Doc, update: Doc, opts: Doc = {}) {
      let doc = docs.find((d) => matches(d, filter))
      if (!doc) {
        if (!opts.upsert) return null
        doc = { _id: new ObjectId() }
        docs.push(doc)
      }
      if (update.$set) Object.assign(doc, update.$set)
      return doc
    },
  }
}

export {}
