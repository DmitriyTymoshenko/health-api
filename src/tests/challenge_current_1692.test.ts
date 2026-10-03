const { bestReps, resolveChallengeExercise, withDerivedChallengeValues } = require('../../lib/challenge-current')

describe('#1692 п.10 challenge current_value from recorded sets', () => {
  it('maps goal names', () => {
    expect(resolveChallengeExercise('Підтягування 10 разів')).toBe('Підтягування')
    expect(resolveChallengeExercise('Бруси 20 разів')).toBe('Віджимання на брусах')
    expect(resolveChallengeExercise('Weight Loss')).toBeNull()
  })
  it('bestReps takes max single-set reps', () => {
    const w = [{ exercises: [{ name: 'Підтягування', sets: [{ reps: 3 }, { reps: 6 }] }, { name: 'X', sets: [{ reps: 99 }] }] }]
    expect(bestReps(w, 'Підтягування')).toBe(6)
  })
  it('derives value, never below start, leaves other goals alone', async () => {
    const db = { collection: () => ({ find: () => ({ toArray: async () => [{ exercises: [{ name: 'Підтягування', sets: [{ reps: 5 }] }] }] }) }) }
    const goals = [
      { type: 'strength', name: 'Підтягування 10 разів', start_value: 2.5, current_value: 2.5 },
      { type: 'strength', name: 'Підтягування 10 разів', start_value: 8, current_value: 8 },
      { type: 'weight', name: 'Weight Loss', current_value: 103 },
    ]
    const out = await withDerivedChallengeValues(db, goals)
    expect(out[0].current_value).toBe(5)
    expect(out[1].current_value).toBe(8)
    expect(out[2].current_value).toBe(103)
  })
})
