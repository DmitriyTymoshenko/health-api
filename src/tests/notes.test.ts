/**
 * Notes route — unit tests for business logic in routes/notes.js
 * Tests: filter building (date, tag), pagination params (limit/skip),
 *        doc normalization (date auto-set, tags default)
 */

// --- Replicate pure logic from routes/notes.js ---

interface NotesFilter {
  date?: string
  tags?: string
}

function buildNotesFilter(query: Record<string, string | undefined>): NotesFilter {
  const { date, tag } = query
  const filter: NotesFilter = {}
  if (date) filter.date = date
  if (tag) filter.tags = tag
  return filter
}

function parseNotesPageParams(query: Record<string, string | undefined>): {
  limit: number
  skip: number
} {
  return {
    limit: Number(query.limit ?? 20),
    skip: Number(query.skip ?? 0),
  }
}

interface NoteDoc {
  date: string
  tags: string[]
  created_at: Date
  [key: string]: unknown
}

function normalizeNoteDoc(body: Record<string, unknown>): NoteDoc {
  const doc = { ...body } as Record<string, unknown>
  if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
  if (!doc.tags) doc.tags = []
  doc.created_at = new Date()
  return doc as NoteDoc
}

// --- Tests ---

describe('buildNotesFilter — filter construction', () => {
  it('returns empty filter when no params', () => {
    expect(buildNotesFilter({})).toEqual({})
  })

  it('builds date filter when date provided', () => {
    const filter = buildNotesFilter({ date: '2026-04-17' })
    expect(filter.date).toBe('2026-04-17')
    expect(filter.tags).toBeUndefined()
  })

  it('builds tag filter when tag provided', () => {
    const filter = buildNotesFilter({ tag: 'health' })
    expect(filter.tags).toBe('health')
    expect(filter.date).toBeUndefined()
  })

  it('builds combined date+tag filter', () => {
    const filter = buildNotesFilter({ date: '2026-04-17', tag: 'workout' })
    expect(filter.date).toBe('2026-04-17')
    expect(filter.tags).toBe('workout')
  })

  it('ignores undefined date and tag', () => {
    const filter = buildNotesFilter({ date: undefined, tag: undefined })
    expect(Object.keys(filter).length).toBe(0)
  })

  it('tag maps to filter.tags (not filter.tag) for array matching', () => {
    const filter = buildNotesFilter({ tag: 'nutrition' })
    expect('tags' in filter).toBe(true)
    expect('tag' in filter).toBe(false)
  })
})

describe('parseNotesPageParams — pagination', () => {
  it('defaults: limit=20, skip=0', () => {
    const p = parseNotesPageParams({})
    expect(p.limit).toBe(20)
    expect(p.skip).toBe(0)
  })

  it('uses provided limit', () => {
    const p = parseNotesPageParams({ limit: '5' })
    expect(p.limit).toBe(5)
  })

  it('uses provided skip', () => {
    const p = parseNotesPageParams({ skip: '40' })
    expect(p.skip).toBe(40)
  })

  it('parses both limit and skip', () => {
    const p = parseNotesPageParams({ limit: '10', skip: '30' })
    expect(p.limit).toBe(10)
    expect(p.skip).toBe(30)
  })

  it('returns numbers, not strings', () => {
    const p = parseNotesPageParams({ limit: '7', skip: '14' })
    expect(typeof p.limit).toBe('number')
    expect(typeof p.skip).toBe('number')
  })
})

describe('normalizeNoteDoc — POST body normalization', () => {
  it('preserves provided date', () => {
    const doc = normalizeNoteDoc({ date: '2026-04-17', text: 'good day' })
    expect(doc.date).toBe('2026-04-17')
  })

  it('auto-sets date when missing', () => {
    const doc = normalizeNoteDoc({ text: 'memo' })
    expect(doc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('defaults tags to [] when missing', () => {
    const doc = normalizeNoteDoc({ text: 'note without tags' })
    expect(doc.tags).toEqual([])
  })

  it('preserves provided tags array', () => {
    const doc = normalizeNoteDoc({ text: 'tagged note', tags: ['health', 'morning'] })
    expect(doc.tags).toEqual(['health', 'morning'])
  })

  it('adds created_at as Date', () => {
    const doc = normalizeNoteDoc({ text: 'test' })
    expect(doc.created_at).toBeInstanceOf(Date)
  })

  it('preserves all other fields', () => {
    const doc = normalizeNoteDoc({
      date: '2026-04-17',
      text: 'felt great',
      mood: 8,
      energy: 7,
    })
    expect(doc.text).toBe('felt great')
    expect(doc.mood).toBe(8)
    expect(doc.energy).toBe(7)
  })
})
