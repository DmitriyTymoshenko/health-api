/**
 * Unit tests for lib/recs-generate.js (#1488, stage C of #1485).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildRecsPrompt, toRawCandidate, RECS_RESPONSE_SCHEMA } = require('../../lib/recs-generate')

const ACTIVE_STACK = [
  { id: 1, short_name: 'Creatine HCl', name: 'Amix Creatine HCl', schedule: 'morning', dose: '3г' },
  { id: 2, short_name: 'Vitamin D3', name: 'GymBeam Vitamin D3', schedule: 'morning', dose: '2000 IU' },
]
const KNOWLEDGE = new Map([
  [1, { catalog_id: 1, continuous: false, cycle: { duration_weeks: 8, pause_weeks: 4 } }],
  [2, { catalog_id: 2, continuous: true, cycle: null }],
])
const LATEST_LABS = {
  ferritin: { value: 45, date: '2026-09-10', age_days: 12, source: 'pdf', status: 'normal', ref: { unit: 'нг/мл' } },
  vitamin_d: { value: 50, date: '2026-08-08', age_days: 45, source: 'pdf', status: 'low', ref: { unit: 'нмоль/л' } },
}
const WHOOP_LATEST = { date: '2026-09-22', recovery_score: 76, hrv_rmssd: 81.5, sleep_performance: 84, sleep_deep_hours: 1.5, strain: 0.19, spo2_percentage: 96 }

describe('buildRecsPrompt', () => {
  it('embeds the active stack with each supplement\'s continuous/cycle regime', () => {
    const prompt = buildRecsPrompt({ activeStack: ACTIVE_STACK, knowledgeByCatalogId: KNOWLEDGE, latestLabs: LATEST_LABS, whoopLatest: WHOOP_LATEST, corpusText: 'CORPUS' })
    expect(prompt).toContain('Creatine HCl')
    expect(prompt).toContain('cycled (8w on / 4w off)')
    expect(prompt).toContain('Vitamin D3')
    expect(prompt).toContain('continuous')
  })

  it('marks a lab result older than 30 days as [STALE] with a no-dosing instruction', () => {
    const prompt = buildRecsPrompt({ activeStack: [], knowledgeByCatalogId: new Map(), latestLabs: LATEST_LABS, whoopLatest: null, corpusText: 'CORPUS' })
    expect(prompt).toMatch(/vitamin_d:.*\[STALE/)
    expect(prompt).not.toMatch(/ferritin:.*\[STALE/)
  })

  it('embeds WHOOP fields using the REAL daily_metrics field names (not the old hrv/spo2/resting_hr names)', () => {
    const prompt = buildRecsPrompt({ activeStack: [], knowledgeByCatalogId: new Map(), latestLabs: {}, whoopLatest: WHOOP_LATEST, corpusText: 'CORPUS' })
    expect(prompt).toContain('Recovery 76%')
    expect(prompt).toContain('HRV 82ms')
    expect(prompt).toContain('SpO2 96%')
  })

  it('handles an empty stack / no labs / no WHOOP gracefully', () => {
    const prompt = buildRecsPrompt({ activeStack: [], knowledgeByCatalogId: new Map(), latestLabs: {}, whoopLatest: null, corpusText: 'CORPUS' })
    expect(prompt).toContain('empty')
    expect(prompt).toContain('no lab results')
    expect(prompt).toContain('No recent WHOOP')
  })

  it('embeds the full corpus text verbatim', () => {
    const prompt = buildRecsPrompt({ activeStack: [], knowledgeByCatalogId: new Map(), latestLabs: {}, whoopLatest: null, corpusText: 'UNIQUE_CORPUS_MARKER_XYZ' })
    expect(prompt).toContain('UNIQUE_CORPUS_MARKER_XYZ')
  })
})

describe('toRawCandidate', () => {
  it('attaches the lab entry by lab_marker, with unit/date/age_days from latestLabs', () => {
    const item = { key: 'vitd', name: 'Vitamin D3 boost', reason: 'low vitamin D', source: 'lab', lab_marker: 'vitamin_d', verdict: { kind: 'confirms', by: 'external', ref: 'https://examine.com/x' }, suggested_dose: '4000 IU', suggested_schedule: 'morning', continuous: true }
    const out = toRawCandidate(item, LATEST_LABS)
    expect(out.lab).toEqual({ marker: 'vitamin_d', value: 50, unit: 'нмоль/л', test_date: '2026-08-08', age_days: 45 })
  })

  it('lab is null when the item has no lab_marker', () => {
    const item = { key: 'x', name: 'X', reason: 'y', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' }, suggested_dose: 'z', suggested_schedule: 'morning', continuous: true }
    const out = toRawCandidate(item, LATEST_LABS)
    expect(out.lab).toBeNull()
  })

  it('builds a suggested.knowledge block matching stage B\'s POST /catalog {knowledge} contract for a cycled item', () => {
    const item = { key: 'x', name: 'Beta-Alanine', reason: 'y', source: 'koliada', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' }, suggested_dose: '3г', suggested_schedule: 'pre_workout', continuous: false, cycle_duration_weeks: 6, cycle_pause_weeks: 2 }
    const out = toRawCandidate(item, {})
    expect(out.suggested).toMatchObject({
      short_name: 'Beta-Alanine', dose: '3г', schedule: 'pre_workout',
      knowledge: { continuous: false, cycle: { duration_weeks: 6, pause_weeks: 2 }, purchase_verified: false },
    })
  })

  it('a continuous item gets cycle:null in suggested.knowledge regardless of stray duration fields', () => {
    const item = { key: 'x', name: 'X', reason: 'y', source: 'whoop', verdict: { kind: 'neutral', by: 'external', ref: 'https://examine.com/x' }, suggested_dose: 'z', suggested_schedule: 'morning', continuous: true, cycle_duration_weeks: 8 }
    const out = toRawCandidate(item, {})
    expect(out.suggested.knowledge.cycle).toBeNull()
  })
})

describe('RECS_RESPONSE_SCHEMA', () => {
  it('requires the core fields on each item', () => {
    expect(RECS_RESPONSE_SCHEMA.properties.items.items.required).toEqual(
      expect.arrayContaining(['key', 'name', 'reason', 'source', 'verdict', 'suggested_dose', 'suggested_schedule', 'continuous'])
    )
  })
})

export {}
