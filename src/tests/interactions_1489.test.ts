/**
 * #1489 (stage E of #1485, design E5): lib/interactions.js — checkStack.
 * Fixture matches the task's own E5 acceptance text: "Iron(morning) +
 * Zinc(morning), interaction conflict -> 1 warning з обома id; Zinc
 * перенесений у evening -> 0."
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkStack } = require('../../lib/interactions')

describe('checkStack — E5 acceptance', () => {
  it('same-slot conflict (Iron morning + Zinc morning) -> 1 result with both ids, same_slot:true', () => {
    const activeItems = [
      { id: 1, name: 'Iron', schedule: 'morning' },
      { id: 2, name: 'Zinc', schedule: 'morning' },
    ]
    const knowledgeById = new Map([
      [
        1,
        {
          catalog_id: 1,
          active_ingredients: [{ name: 'Iron', nutrient_key: 'iron', amount_per_dose: 18, unit: 'mg' }],
          interactions: [{ with: 'zinc', kind: 'conflict', rule: 'Iron and zinc compete for absorption — separate by 2h', source: 'NIH ODS Iron' }],
        },
      ],
      [
        2,
        {
          catalog_id: 2,
          active_ingredients: [{ name: 'Zinc', nutrient_key: 'zinc', amount_per_dose: 15, unit: 'mg' }],
        },
      ],
    ])
    const results = checkStack(activeItems, knowledgeById)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ a: 1, b: 2, kind: 'conflict', same_slot: true })
  })

  it('moving Zinc to evening (different slot from Iron) -> 0 results', () => {
    const activeItems = [
      { id: 1, name: 'Iron', schedule: 'morning' },
      { id: 2, name: 'Zinc', schedule: 'evening' },
    ]
    const knowledgeById = new Map([
      [
        1,
        {
          catalog_id: 1,
          active_ingredients: [{ name: 'Iron', nutrient_key: 'iron', amount_per_dose: 18, unit: 'mg' }],
          interactions: [{ with: 'zinc', kind: 'conflict', rule: 'Iron and zinc compete for absorption', source: 'NIH ODS Iron' }],
        },
      ],
      [2, { catalog_id: 2, active_ingredients: [{ name: 'Zinc', nutrient_key: 'zinc', amount_per_dose: 15, unit: 'mg' }] }],
    ])
    const results = checkStack(activeItems, knowledgeById)
    expect(results).toHaveLength(0)
  })

  it('a synergy same-slot pair is returned with kind:"synergy" (a hint, not a warning — caller decides styling)', () => {
    const activeItems = [
      { id: 1, name: 'Vitamin D3', schedule: 'morning' },
      { id: 2, name: 'Vitamin K2', schedule: 'morning' },
    ]
    const knowledgeById = new Map([
      [
        1,
        {
          catalog_id: 1,
          active_ingredients: [{ name: 'Vitamin D3', nutrient_key: 'vitamin_d', amount_per_dose: 2000, unit: 'IU' }],
          interactions: [{ with: 'vitamin_k2', kind: 'synergy', rule: 'D3 works better with K2 for calcium transport', source: 'general nutrition' }],
        },
      ],
      [2, { catalog_id: 2, active_ingredients: [{ name: 'Vitamin K2', nutrient_key: 'vitamin_k2', amount_per_dose: 100, unit: 'mcg' }] }],
    ])
    const results = checkStack(activeItems, knowledgeById)
    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe('synergy')
  })

  it('rule.with can match by catalog_id (number) instead of nutrient_key', () => {
    const activeItems = [
      { id: 1, name: 'A', schedule: 'morning' },
      { id: 8, name: 'ZMA', schedule: 'morning' },
    ]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [], interactions: [{ with: 8, kind: 'conflict', rule: 'direct id match', source: 'test' }] }],
      [8, { catalog_id: 8, active_ingredients: [] }],
    ])
    const results = checkStack(activeItems, knowledgeById)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ a: 1, b: 8, kind: 'conflict' })
  })

  it('no knowledge.interactions on either item (stage F not filled yet, live state today: 0/14) -> 0 results, no throw', () => {
    const activeItems = [
      { id: 1, name: 'A', schedule: 'morning' },
      { id: 2, name: 'B', schedule: 'morning' },
    ]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [] }],
      [2, { catalog_id: 2, active_ingredients: [] }],
    ])
    expect(checkStack(activeItems, knowledgeById)).toEqual([])
  })

  it('a pair is never reported twice even if both items declare the interaction', () => {
    const activeItems = [
      { id: 1, name: 'A', schedule: 'morning' },
      { id: 2, name: 'B', schedule: 'morning' },
    ]
    const knowledgeById = new Map([
      [1, { catalog_id: 1, active_ingredients: [{ name: 'X', nutrient_key: 'x', amount_per_dose: 1, unit: 'mg' }], interactions: [{ with: 2, kind: 'conflict', rule: 'r', source: 's' }] }],
      [2, { catalog_id: 2, active_ingredients: [{ name: 'Y', nutrient_key: 'y', amount_per_dose: 1, unit: 'mg' }], interactions: [{ with: 1, kind: 'conflict', rule: 'r', source: 's' }] }],
    ])
    expect(checkStack(activeItems, knowledgeById)).toHaveLength(1)
  })
})

export {}
