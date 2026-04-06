const { calcWaterGoal, strainLabel, expectedPctByHour } = require('../../notify')

describe('calcWaterGoal', () => {
  it('returns 2500 when weight is null', () => {
    expect(calcWaterGoal(null, 0)).toBe(2500)
    expect(calcWaterGoal(undefined, 10)).toBe(2500)
  })

  it('calculates base goal from weight (no strain)', () => {
    // 80kg * 33 = 2640, rounded to 2650
    expect(calcWaterGoal(80, 0)).toBe(2650)
    // 70kg * 33 = 2310, rounded to 2300
    expect(calcWaterGoal(70, 0)).toBe(2300)
  })

  it('applies 1.1x coefficient for strain 5-9', () => {
    // 80kg * 33 * 1.1 = 2904, round to 2900
    expect(calcWaterGoal(80, 5)).toBe(2900)
    expect(calcWaterGoal(80, 9)).toBe(2900)
  })

  it('applies 1.2x coefficient for strain 10-13', () => {
    // 80kg * 33 * 1.2 = 3168, round to 3150
    expect(calcWaterGoal(80, 10)).toBe(3150)
    expect(calcWaterGoal(80, 13)).toBe(3150)
  })

  it('applies 1.4x coefficient for strain 14+', () => {
    // 80kg * 33 * 1.4 = 3696, round to 3700
    expect(calcWaterGoal(80, 14)).toBe(3700)
    expect(calcWaterGoal(80, 20)).toBe(3700)
  })

  it('rounds to nearest 50ml', () => {
    // 65kg * 33 = 2145, round to 2150
    expect(calcWaterGoal(65, 0)).toBe(2150)
  })
})

describe('strainLabel', () => {
  it('returns correct labels for strain ranges', () => {
    expect(strainLabel(0)).toContain('мінімальний')
    expect(strainLabel(4)).toContain('мінімальний')
    expect(strainLabel(5)).toContain('легкий')
    expect(strainLabel(10)).toContain('середній')
    expect(strainLabel(14)).toContain('високий')
    expect(strainLabel(18)).toContain('екстремальний')
    expect(strainLabel(21)).toContain('екстремальний')
  })
})

describe('expectedPctByHour', () => {
  it('returns 0 before 9:00', () => {
    expect(expectedPctByHour(6)).toBe(0)
    expect(expectedPctByHour(8)).toBe(0)
  })

  it('returns 30 at 9-11', () => {
    expect(expectedPctByHour(9)).toBe(30)
    expect(expectedPctByHour(11)).toBe(30)
  })

  it('returns 50 at 12-14', () => {
    expect(expectedPctByHour(12)).toBe(50)
    expect(expectedPctByHour(14)).toBe(50)
  })

  it('returns 70 at 15-17', () => {
    expect(expectedPctByHour(15)).toBe(70)
    expect(expectedPctByHour(17)).toBe(70)
  })

  it('returns 90 at 18-20', () => {
    expect(expectedPctByHour(18)).toBe(90)
    expect(expectedPctByHour(20)).toBe(90)
  })

  it('returns 100 at 21+', () => {
    expect(expectedPctByHour(21)).toBe(100)
    expect(expectedPctByHour(23)).toBe(100)
  })
})
