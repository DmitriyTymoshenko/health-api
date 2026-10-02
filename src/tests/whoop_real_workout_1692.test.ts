import { isRealWhoopWorkout } from '../../lib/whoop-real-workout'

describe('#1692 п.8 isRealWhoopWorkout', () => {
  it('rejects short or light sessions', () => {
    expect(isRealWhoopWorkout({ duration_min: 30, strain: 8 })).toBe(false)
    expect(isRealWhoopWorkout({ duration_min: 60, strain: 4 })).toBe(false)
    expect(isRealWhoopWorkout({ duration_min: null, strain: null })).toBe(false)
    expect(isRealWhoopWorkout(null)).toBe(false)
  })
  it('accepts >=40min and strain>=6', () => {
    expect(isRealWhoopWorkout({ duration_min: 40, strain: 6 })).toBe(true)
    expect(isRealWhoopWorkout({ duration_min: 75, strain: 11.2 })).toBe(true)
  })
})
