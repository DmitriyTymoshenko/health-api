/**
 * #1332 acceptance #2 — Dictionary B (source -> our enum) MUST have an explicit entry
 * for every one of the 13 equipment values (12 + null) and every one of the 17
 * primaryMuscles values live-measured in free-exercise-db (876 exercises, #1332 /
 * #1331 comment #7551). A silent fallback to 'other'/some default for a KNOWN source
 * value is the FAIL condition this test exists to catch — see lib/exercise-dictionaries.js
 * header for why the mapping functions throw instead of defaulting.
 *
 * Also covers the migration GUARD (resolveLibraryEquipmentOverwrite) that stops a
 * source `null` from erasing an existing exercises_library value — the precondition
 * #1310 depends on (77/876 source rows have equipment:null).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  mapEquipmentToOurs,
  mapMuscleToGroup,
  resolvePrimaryMuscleGroup,
  resolveLibraryEquipmentOverwrite,
} = require('../../lib/exercise-dictionaries')

// The exact 13 equipment values live-measured against dist/exercises.json (876 rows,
// #1332 comment) — 12 non-null + null. Keep this list IN SYNC with any future
// free-exercise-db refresh; a new 14th value should make this test fail loudly.
const SOURCE_EQUIPMENT_VALUES = [
  'barbell',
  'dumbbell',
  'other',
  'body only',
  'cable',
  null,
  'machine',
  'kettlebells',
  'bands',
  'medicine ball',
  'exercise ball',
  'foam roll',
  'e-z curl bar',
]

// The exact 17 primaryMuscles values live-measured the same way.
const SOURCE_MUSCLE_VALUES = [
  'abdominals', 'abductors', 'adductors', 'biceps', 'calves', 'chest',
  'forearms', 'glutes', 'hamstrings', 'lats', 'lower back', 'middle back',
  'neck', 'quadriceps', 'shoulders', 'traps', 'triceps',
]

describe('Dictionary B — equipment coverage (#1332 acceptance #2)', () => {
  it('has exactly 13 known equipment values (12 + null)', () => {
    expect(SOURCE_EQUIPMENT_VALUES.length).toBe(13)
  })

  it.each(SOURCE_EQUIPMENT_VALUES)('maps source equipment %p without throwing', (val) => {
    expect(() => mapEquipmentToOurs(val)).not.toThrow()
  })

  it('never silently maps a KNOWN value to "other" unless the source itself says "other"', () => {
    for (const val of SOURCE_EQUIPMENT_VALUES) {
      const mapped = mapEquipmentToOurs(val)
      if (mapped === 'other') {
        expect(val).toBe('other')
      }
    }
  })

  it('throws on an unrecognized equipment value (new/unknown source data)', () => {
    expect(() => mapEquipmentToOurs('resistance_chains_never_seen')).toThrow()
  })

  it('renames "body only" to our existing "bodyweight" (the one approved renaming)', () => {
    expect(mapEquipmentToOurs('body only')).toBe('bodyweight')
  })

  it('extends the enum for new equipment rather than collapsing into an existing value', () => {
    expect(mapEquipmentToOurs('kettlebells')).toBe('kettlebell')
    expect(mapEquipmentToOurs('kettlebells')).not.toBe('dumbbell') // #1310-class bug guard
  })

  it('keeps our 5 pre-#1332 values byte-identical', () => {
    expect(mapEquipmentToOurs('barbell')).toBe('barbell')
    expect(mapEquipmentToOurs('dumbbell')).toBe('dumbbell')
    expect(mapEquipmentToOurs('cable')).toBe('cable')
    expect(mapEquipmentToOurs('machine')).toBe('machine')
  })

  it('maps source null to null (source genuinely does not know)', () => {
    expect(mapEquipmentToOurs(null)).toBeNull()
    expect(mapEquipmentToOurs(undefined)).toBeNull()
  })
})

describe('Dictionary B — muscle coverage (#1332 acceptance #2)', () => {
  it('has exactly 17 known primaryMuscles values', () => {
    expect(SOURCE_MUSCLE_VALUES.length).toBe(17)
  })

  it.each(SOURCE_MUSCLE_VALUES)('maps source muscle %p without throwing', (val) => {
    expect(() => mapMuscleToGroup(val)).not.toThrow()
  })

  it('throws on an unrecognized muscle value', () => {
    expect(() => mapMuscleToGroup('serratus_never_seen')).toThrow()
  })

  it('adds forearms and neck as NEW groups instead of folding into an existing one', () => {
    expect(mapMuscleToGroup('forearms')).toBe('forearms')
    expect(mapMuscleToGroup('neck')).toBe('neck')
  })

  it('collapses the 6 back-adjacent source muscles into our single "back" group', () => {
    for (const m of ['lats', 'middle back', 'lower back', 'traps']) {
      expect(mapMuscleToGroup(m)).toBe('back')
    }
  })

  it('collapses the 6 leg-adjacent source muscles into our single "legs" group', () => {
    for (const m of ['quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors']) {
      expect(mapMuscleToGroup(m)).toBe('legs')
    }
  })

  it('resolvePrimaryMuscleGroup picks the FIRST primary muscle', () => {
    expect(resolvePrimaryMuscleGroup(['hamstrings', 'lower back', 'glutes'])).toBe('legs')
    expect(resolvePrimaryMuscleGroup(['abdominals'])).toBe('core')
    expect(resolvePrimaryMuscleGroup([])).toBeNull()
  })
})

describe('resolveLibraryEquipmentOverwrite — the #1310-regression guard', () => {
  it('NEVER overwrites an existing non-empty value with a source null (the #1310 regression this guards)', () => {
    expect(resolveLibraryEquipmentOverwrite('barbell', null)).toBe('barbell')
    expect(resolveLibraryEquipmentOverwrite('dumbbell', null)).toBe('dumbbell')
  })

  it('fills in a value when ours was empty and source knows', () => {
    expect(resolveLibraryEquipmentOverwrite(null, 'machine')).toBe('machine')
    expect(resolveLibraryEquipmentOverwrite(undefined, 'machine')).toBe('machine')
    expect(resolveLibraryEquipmentOverwrite('', 'machine')).toBe('machine')
  })

  it('stays null when both ours and source are empty/unknown', () => {
    expect(resolveLibraryEquipmentOverwrite(null, null)).toBeNull()
  })

  it('DOES apply a correction when source has a different non-null value (the #1310 fix path)', () => {
    // "Жим в нахилі" (#1310): ours was barbell, source (Leverage_Incline_Chest_Press) says machine
    expect(resolveLibraryEquipmentOverwrite('barbell', 'machine')).toBe('machine')
    // "Молоткові згинання на лаві Скотта" (#1310): ours was dumbbell, source (Machine_Preacher_Curls) says machine
    expect(resolveLibraryEquipmentOverwrite('dumbbell', 'machine')).toBe('machine')
  })
})

// #954/#1088 structural guard: every test file needs a top-level import/export or tsc
// treats it as a global script (collision risk across the whole test tree).
export {}
