const { calcWaterGoal, strainLabel, expectedPctByHour } = require('../../notify')

// #1298 R4 (owner decision 18.09 ~11:55): calcWaterGoal is now a flat "1 L per
// 30 kg body weight", no strain multiplier — Today.jsx shows this exact
// number with the literal "1 л на 30 кг" caption, so the formula can no
// longer diverge from that statement for any strain value.
describe('calcWaterGoal', () => {
  it('returns 2500 when weight is null', () => {
    expect(calcWaterGoal(null, 0)).toBe(2500)
    expect(calcWaterGoal(undefined, 10)).toBe(2500)
  })

  it('calculates goal from weight alone: weightKg * 1000 / 30, rounded to the nearest ml', () => {
    // 80kg * 1000 / 30 = 2666.67 -> 2667
    expect(calcWaterGoal(80, 0)).toBe(2667)
    // 70kg * 1000 / 30 = 2333.33 -> 2333
    expect(calcWaterGoal(70, 0)).toBe(2333)
    // 92.9kg (audit #1298 example weight) * 1000 / 30 = 3096.67 -> 3097 ("≈3.1л" on Today)
    expect(calcWaterGoal(92.9, 0)).toBe(3097)
    // 93.9kg (unified_targets_1295 fixture weight) -> exact multiple of 30, no rounding
    expect(calcWaterGoal(93.9, 0)).toBe(3130)
  })

  it('strain no longer affects the goal — same weight, any strain, same result', () => {
    expect(calcWaterGoal(80, 5)).toBe(2667)
    expect(calcWaterGoal(80, 10)).toBe(2667)
    expect(calcWaterGoal(80, 14)).toBe(2667)
    expect(calcWaterGoal(80, 20)).toBe(2667)
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

export {};
