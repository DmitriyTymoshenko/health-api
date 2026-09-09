/**
 * Unit tests — lib/workout-log-parser.js (#1314). Fixtures are the owner's OWN
 * reference session (#1291 "РЕФЕРЕНС ВЛАСНИКА", verified live 09.09), not invented
 * round numbers — this is the exact text format Dmytro dictates in Telegram.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseSetToken, splitSetTokens, parseWorkoutLogText } = require('../../lib/workout-log-parser')

describe('parseSetToken — reps FIRST, weight SECOND (owner reference, reverse of gym convention)', () => {
  it('8х80 -> reps 8, weight_input 80 (Cyrillic х)', () => {
    expect(parseSetToken('8х80')).toEqual({ reps: 8, weight_input: 80 })
  })

  it('8x80 -> same result with Latin x', () => {
    expect(parseSetToken('8x80')).toEqual({ reps: 8, weight_input: 80 })
  })

  it('8×80 -> same result with multiplication sign', () => {
    expect(parseSetToken('8×80')).toEqual({ reps: 8, weight_input: 80 })
  })

  it('asymmetric pair: 8х80 must NOT equal 80х8 (order is part of the contract)', () => {
    expect(parseSetToken('8х80')).toEqual({ reps: 8, weight_input: 80 })
    expect(parseSetToken('80х8')).toEqual({ reps: 80, weight_input: 8 })
  })

  it('decimal weight (dumbbell 37.5kg style)', () => {
    expect(parseSetToken('10х37.5')).toEqual({ reps: 10, weight_input: 37.5 })
  })

  it('decimal weight with comma', () => {
    expect(parseSetToken('10х37,5')).toEqual({ reps: 10, weight_input: 37.5 })
  })

  it('whitespace around the x is tolerated', () => {
    expect(parseSetToken(' 8 х 80 ')).toEqual({ reps: 8, weight_input: 80 })
  })

  it('rejects garbage / non-matching tokens', () => {
    expect(parseSetToken('abc')).toBeNull()
    expect(parseSetToken('')).toBeNull()
    expect(parseSetToken('8-80')).toBeNull()
  })

  it('rejects zero/negative reps or weight', () => {
    expect(parseSetToken('0х80')).toBeNull()
    expect(parseSetToken('8х0')).toBeNull()
  })
})

describe('splitSetTokens — owner\'s "·" delimiter, with fallbacks', () => {
  it('splits on the middle dot', () => {
    expect(splitSetTokens('8х80  · 7х80  · 6х80')).toEqual(['8х80', '7х80', '6х80'])
  })

  it('falls back to comma when no middle dot present', () => {
    expect(splitSetTokens('8х80, 7х80, 6х80')).toEqual(['8х80', '7х80', '6х80'])
  })

  it('falls back to whitespace-run splitting when neither delimiter is present', () => {
    expect(splitSetTokens('8х52 8х66 8х73 8х73')).toEqual(['8х52', '8х66', '8х73', '8х73'])
  })

  it('single set, no delimiter needed', () => {
    expect(splitSetTokens('10х235')).toEqual(['10х235'])
  })
})

describe('parseWorkoutLogText — the owner\'s full reference session (#1291)', () => {
  const REFERENCE = [
    'Жим під нахилом:   8х80  · 7х80  · 6х80',
    'Тяга блока:        8х52  · 8х66  · 8х73  · 8х73',
    'Розводка:          10х235 · 10х235 · 10х235',
    'Біцепс скота:      6х160 · 6х160 · 6х145',
  ].join('\n')

  it('parses all 4 exercises with correct reps/weight order and count', () => {
    const { entries, skipped } = parseWorkoutLogText(REFERENCE)
    expect(skipped).toEqual([])
    expect(entries).toHaveLength(4)

    expect(entries[0]).toEqual({
      name: 'Жим під нахилом',
      sets: [
        { reps: 8, weight_input: 80 },
        { reps: 7, weight_input: 80 },
        { reps: 6, weight_input: 80 },
      ],
    })

    expect(entries[1]).toEqual({
      name: 'Тяга блока',
      sets: [
        { reps: 8, weight_input: 52 },
        { reps: 8, weight_input: 66 },
        { reps: 8, weight_input: 73 },
        { reps: 8, weight_input: 73 },
      ],
    })

    expect(entries[2].sets).toHaveLength(3)
    expect(entries[3].sets.map((s: any) => s.weight_input)).toEqual([160, 160, 145]) // trailing drop preserved, not "fixed"
  })

  it('exercise name is trimmed and the FIRST colon splits name/sets (name may not contain ":")', () => {
    const { entries } = parseWorkoutLogText('  Жим лежачи  :  8х80')
    expect(entries[0].name).toBe('Жим лежачи')
  })

  it('blank lines are ignored, not treated as errors', () => {
    const { entries, skipped } = parseWorkoutLogText('\nЖим лежачи: 8х80\n\n')
    expect(entries).toHaveLength(1)
    expect(skipped).toEqual([])
  })

  it('a line with no colon is skipped with reason no_colon, does not abort the rest', () => {
    const { entries, skipped } = parseWorkoutLogText('щось без двокрапки\nЖим лежачи: 8х80')
    expect(entries).toHaveLength(1)
    expect(skipped).toEqual([{ line: 'щось без двокрапки', reason: 'no_colon' }])
  })

  it('a line with a colon but no valid set tokens is skipped, reason unparseable_sets', () => {
    const { entries, skipped } = parseWorkoutLogText('Жим лежачи: не сьогодні')
    expect(entries).toHaveLength(0)
    expect(skipped).toEqual([{ line: 'Жим лежачи: не сьогодні', reason: 'unparseable_sets' }])
  })

  it('empty text yields no entries, no crash', () => {
    expect(parseWorkoutLogText('')).toEqual({ entries: [], skipped: [] })
    expect(parseWorkoutLogText(undefined as unknown as string)).toEqual({ entries: [], skipped: [] })
  })

  it('a partially-bad token is dropped but the good sets on the same line are kept, and it is flagged', () => {
    const { entries, skipped } = parseWorkoutLogText('Жим лежачи: 8х80 · щось · 7х80')
    expect(entries).toHaveLength(1)
    expect(entries[0].sets).toEqual([{ reps: 8, weight_input: 80 }, { reps: 7, weight_input: 80 }])
    expect(skipped).toEqual([{ line: 'Жим лежачи: 8х80 · щось · 7х80', reason: 'partial_unparseable_sets' }])
  })
})

export {}
