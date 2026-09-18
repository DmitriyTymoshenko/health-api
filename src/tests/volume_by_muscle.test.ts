// eslint-disable-next-line @typescript-eslint/no-var-requires
const { periodBounds, summarizeVolumeByMuscle } = require('../../lib/volume-by-muscle')

const MUSCLE_ORDER = ['chest', 'back', 'shoulders', 'legs', 'biceps', 'triceps', 'core', 'forearms', 'neck', 'other']

describe('periodBounds', () => {
  it('week is Monday-Sunday in Kyiv and prev is the prior 7-day week', () => {
    expect(periodBounds('week', '2026-09-17')).toEqual({
      period: 'week',
      from: '2026-09-14',
      to: '2026-09-20',
      prevFrom: '2026-09-07',
      prevTo: '2026-09-13',
    })
  })

  it('month is the calendar month and prev is the previous calendar month', () => {
    expect(periodBounds('month', '2026-09-17')).toEqual({
      period: 'month',
      from: '2026-09-01',
      to: '2026-09-30',
      prevFrom: '2026-08-01',
      prevTo: '2026-08-31',
    })
  })

  it('rejects invalid period and impossible date', () => {
    expect(periodBounds('day', '2026-09-17').error).toBe('period must be week or month')
    expect(periodBounds('week', '2026-02-31').error).toBe('date must be YYYY-MM-DD')
  })
})

describe('summarizeVolumeByMuscle', () => {
  it('sums weight_kg × reps by live library muscle group and sorts by muscle order', () => {
    const result = summarizeVolumeByMuscle([
      { date: '2026-09-17', exercises: [
        { name: 'Жим гантелей лежачи', sets: [{ weight_kg: 30, reps: 8 }, { weight_kg: 30, reps: 8 }, { weight_kg: 30, reps: 8 }] },
        { name: 'Тяга верхнього блоку', sets: [{ weight_kg: 52, reps: 12 }] },
      ] },
    ], [
      { name: 'Жим гантелей лежачи', muscle_group: 'chest' },
      { name: 'Тяга верхнього блоку', muscle_group: 'back' },
    ], MUSCLE_ORDER)

    expect(result).toEqual({
      total_kg: 1344,
      workouts_count: 1,
      groups: [
        { muscle_group: 'chest', volume_kg: 720, sets: 3, exercises_count: 1 },
        { muscle_group: 'back', volume_kg: 624, sets: 1, exercises_count: 1 },
      ],
    })
  })

  it('unknown/null muscle group falls into other and bodyweight zero-volume sets are not shown', () => {
    const result = summarizeVolumeByMuscle([
      { date: '2026-09-17', exercises: [
        { name: 'Нова вправа', sets: [{ weight_kg: 20, reps: 10 }] },
        { name: 'Підтягування', sets: [{ weight_kg: 0, reps: 12 }, { reps: 10 }] },
      ] },
    ], [
      { name: 'Нова вправа', muscle_group: null },
      { name: 'Підтягування', muscle_group: 'back' },
    ], MUSCLE_ORDER)

    expect(result).toEqual({
      total_kg: 200,
      workouts_count: 1,
      groups: [
        { muscle_group: 'other', volume_kg: 200, sets: 1, exercises_count: 1 },
      ],
    })
  })

  it('empty period is a zero summary', () => {
    expect(summarizeVolumeByMuscle([], [], MUSCLE_ORDER)).toEqual({
      total_kg: 0,
      workouts_count: 0,
      groups: [],
    })
  })
})

export {}
