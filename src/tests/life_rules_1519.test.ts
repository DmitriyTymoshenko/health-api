/**
 * Unit tests for lib/life-rules.js — pure habit/rule logic (#1519, SPEC
 * #1518 §5/M3): "done today" (AND across active rules, neutral-unchecked
 * per Q2) and "days clean" (break habits, the exact table in SPEC §5).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { habitDoneToday, ruleCheckState, computeDaysClean } = require('../../lib/life-rules')

describe('habitDoneToday', () => {
  const ruleA = { _id: 'a' }
  const ruleB = { _id: 'b' }

  it('null when the habit has no active rules yet', () => {
    expect(habitDoneToday([], {})).toBeNull()
  })

  it('true when every active rule is done', () => {
    expect(habitDoneToday([ruleA, ruleB], { a: { done: true }, b: { done: true } })).toBe(true)
  })

  it('true when a rule is satisfied via two_minute_version instead of done', () => {
    expect(habitDoneToday([ruleA], { a: { done: false, two_minute_version: true } })).toBe(true)
  })

  it('false when at least one active rule has an explicit unmet check-in (AND across rules)', () => {
    expect(habitDoneToday([ruleA, ruleB], { a: { done: true }, b: { done: false } })).toBe(false)
  })

  it('null (neutral, not false) when a rule has NO check-in at all yet — SPEC Q2 default', () => {
    expect(habitDoneToday([ruleA, ruleB], { a: { done: true } })).toBeNull()
  })
})

describe('ruleCheckState', () => {
  it('neutral nulls when there is no check doc', () => {
    expect(ruleCheckState(undefined)).toEqual({ done: null, two_minute_version: null })
    expect(ruleCheckState(null)).toEqual({ done: null, two_minute_version: null })
  })

  it('reflects an explicit done:true', () => {
    expect(ruleCheckState({ done: true, two_minute_version: false })).toEqual({
      done: true,
      two_minute_version: false,
    })
  })

  it('reflects an explicit done:false', () => {
    expect(ruleCheckState({ done: false })).toEqual({ done: false, two_minute_version: false })
  })
})

describe('computeDaysClean — SPEC §5 table byte-for-byte', () => {
  it('created(0) -> +1 clean(1) -> +2 no-checkin(2) -> +3 failure(0) -> +4 clean(1)', () => {
    // flags array excludes the creation day itself (it is day 0, not in the array).
    const flags = [false, false, true, false]
    const running: number[] = []
    for (let i = 1; i <= flags.length; i++) {
      running.push(computeDaysClean(flags.slice(0, i)))
    }
    expect(running).toEqual([1, 2, 0, 1])
  })

  it('empty history (just created) -> 0', () => {
    expect(computeDaysClean([])).toBe(0)
  })

  it('all clean -> count equals the number of days', () => {
    expect(computeDaysClean([false, false, false, false, false])).toBe(5)
  })

  it('a failure on the very last day resets to 0 even after a long streak', () => {
    expect(computeDaysClean([false, false, false, false, true])).toBe(0)
  })
})

export {}
