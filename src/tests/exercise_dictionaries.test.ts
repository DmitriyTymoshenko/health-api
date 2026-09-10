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
  getEquipmentLabelsByOurEnum,
  DICTIONARY_A_STATUS,
  DISPLAY_LABELS_UA,
  EQUIPMENT_SOURCE_TO_OURS,
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

describe('Dictionary A — reviewed final labels (#1332 QA-fail fix, #1335 final table)', () => {
  it('is flagged as Lisa-reviewed with the exact literal #1334 stage-2 greps for', () => {
    // #1334 unblock condition is a literal grep on this string — must not drift.
    expect(DICTIONARY_A_STATUS).toBe('lisa-reviewed-2026-09-10')
  })

  // Regression-prone terms called out by name in the #1332 QA-fail fix request —
  // each one previously shipped a draft value that diverged from #1335's reviewed table.
  it('force.push is "штовхання", never "жим" (push is broader than press movements)', () => {
    expect(DISPLAY_LABELS_UA.force.push).toBe('штовхання')
    expect(DISPLAY_LABELS_UA.force.push).not.toBe('жим')
  })

  it('muscles.lats is "найширші", never "широчайші" (calque from Russian)', () => {
    expect(DISPLAY_LABELS_UA.muscles.lats).toBe('найширші')
    expect(DISPLAY_LABELS_UA.muscles.lats).not.toBe('широчайші')
  })

  it('equipment.other is "інше обладнання", not a bare "інше" (must not read as "no equipment")', () => {
    expect(DISPLAY_LABELS_UA.equipment.other).toBe('інше обладнання')
  })

  it('equipment["body only"] is "власна вага", not "інше обладнання" (must not collide with "other")', () => {
    expect(DISPLAY_LABELS_UA.equipment['body only']).toBe('власна вага')
    expect(DISPLAY_LABELS_UA.equipment['body only']).not.toBe(DISPLAY_LABELS_UA.equipment.other)
  })

  it('mechanic.compound is "базова", mechanic.isolation is "ізольована" (not "багатосуглобова"/"ізолююча")', () => {
    expect(DISPLAY_LABELS_UA.mechanic.compound).toBe('базова')
    expect(DISPLAY_LABELS_UA.mechanic.isolation).toBe('ізольована')
  })

  it('muscles.adductors and muscles.abductors keep deliberately different roots (never conflated)', () => {
    expect(DISPLAY_LABELS_UA.muscles.adductors).toBe("привідні м'язи")
    expect(DISPLAY_LABELS_UA.muscles.abductors).toBe("відвідні м'язи")
    expect(DISPLAY_LABELS_UA.muscles.adductors).not.toBe(DISPLAY_LABELS_UA.muscles.abductors)
  })

  it('every Dictionary A axis has exactly the term count Lisa reviewed in #1335 (44 total)', () => {
    const counts = Object.fromEntries(
      Object.entries(DISPLAY_LABELS_UA).map(([axis, map]) => [axis, Object.keys(map as object).length])
    )
    expect(counts).toEqual({
      equipment: 12,
      category: 7,
      level: 3,
      force: 3,
      mechanic: 2,
      muscles: 17,
    })
  })

  it('no Dictionary A axis has an empty/placeholder label (no draft leftovers)', () => {
    for (const map of Object.values(DISPLAY_LABELS_UA)) {
      for (const label of Object.values(map as Record<string, string>)) {
        expect(typeof label).toBe('string')
        expect(label.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * #1334 (Ф3/#1331, ЕТАП 1б, comment #7581 §2/#7585) — RANGE-COVERAGE test for the
 * A∘B equipment-label composition. Dictionary A is keyed by the SOURCE term and only
 * 5/12 keys are byte-identical to our enum — a naive `DISPLAY_LABELS_UA.equipment[ours]`
 * lookup silently misses the other 7 (empty chip, no thrown error, no failing test
 * unless it checks the FULL range). This iterates every value in
 * `EQUIPMENT_SOURCE_TO_OURS`'s non-null range — not a spot-check of 2-3 values — so a
 * future new equipment value that breaks the composition fails loudly here.
 */
describe('getEquipmentLabelsByOurEnum — A∘B composition range coverage (#1334 ЕТАП 1б)', () => {
  const OUR_ENUM_VALUES: string[] = Array.from(
    new Set(Object.values(EQUIPMENT_SOURCE_TO_OURS).filter((v): v is string => v !== null))
  )

  it('the our-enum range has exactly 12 distinct values (1:1 composition, no collisions)', () => {
    expect(OUR_ENUM_VALUES.length).toBe(12)
  })

  it('every value in the our-enum range has EXACTLY one non-empty label', () => {
    const labels = getEquipmentLabelsByOurEnum()
    for (const oursKey of OUR_ENUM_VALUES) {
      expect(Object.prototype.hasOwnProperty.call(labels, oursKey)).toBe(true)
      expect(typeof labels[oursKey]).toBe('string')
      expect(labels[oursKey].trim().length).toBeGreaterThan(0)
    }
    // No stray keys beyond the our-enum range either.
    expect(Object.keys(labels).sort()).toEqual([...OUR_ENUM_VALUES].sort())
  })

  it('renamed/new values resolve to Dictionary A labels, not their raw source term', () => {
    const labels = getEquipmentLabelsByOurEnum()
    expect(labels.bodyweight).toBe('власна вага') // renamed from source "body only"
    expect(labels.kettlebell).toBe('гирі') // renamed from source "kettlebells"
    expect(labels.ez_curl_bar).toBe('EZ-гриф')
    expect(labels.other).toBe('інше обладнання') // must not read as "no equipment"
  })

  it('keeps the 5 pre-#1332 byte-identical keys resolvable', () => {
    const labels = getEquipmentLabelsByOurEnum()
    for (const k of ['barbell', 'dumbbell', 'cable', 'machine']) {
      expect(labels[k]).toBe(DISPLAY_LABELS_UA.equipment[k])
    }
  })

  it('throws instead of silently emitting an empty label for a missing Dictionary A entry', () => {
    const original = DISPLAY_LABELS_UA.equipment.barbell
    delete DISPLAY_LABELS_UA.equipment.barbell
    try {
      expect(() => getEquipmentLabelsByOurEnum()).toThrow()
    } finally {
      DISPLAY_LABELS_UA.equipment.barbell = original // restore — module-level shared state
    }
  })
})

// #954/#1088 structural guard: every test file needs a top-level import/export or tsc
// treats it as a global script (collision risk across the whole test tree).
export {}
