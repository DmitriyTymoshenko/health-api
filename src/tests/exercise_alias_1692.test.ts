export {}
const { canonicalizeExercises, resolveAliases } = require('../../lib/exercise-alias')

function fakeCol(docs: any[]) {
  const match = (d: any, q: any) => {
    if (q.name?.$regex) return q.name.$regex.test(d.name)
    if (q.aliases?.$regex) return (d.aliases || []).some((a: string) => q.aliases.$regex.test(a))
    return false
  }
  return { findOne: async (q: any) => docs.find(d => match(d, q)) || null }
}

describe('exercise alias layer (#1692 п.2)', () => {
  const col = fakeCol([
    { name: 'Тяга блока широким хватом', aliases: ['Тяга блоку широким хватом'] },
    { name: 'Планка' },
  ])
  it('maps alias (case-insensitive) to canonical', async () => {
    const out = await canonicalizeExercises(col, [{ name: 'тяга блоку широким хватом', sets: [] }, { name: 'Планка' }])
    expect(out.map((e: any) => e.name)).toEqual(['Тяга блока широким хватом', 'Планка'])
  })
  it('canonical name wins over alias; unknown stays', async () => {
    const m = await resolveAliases(col, ['Планка', 'Нова вправа'])
    expect(m.size).toBe(0)
  })
  it('no-ops on empty', async () => {
    expect(await canonicalizeExercises(col, [])).toEqual([])
  })
})
