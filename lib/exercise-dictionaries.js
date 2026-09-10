'use strict'

/**
 * #1332 (Ф1 of #1331 umbrella) — TWO separate curated dictionaries for the
 * free-exercise-db import. Do NOT merge them into one map — they answer different
 * questions and have different acceptance bars (see #1331 comment #7551 §2):
 *
 *   Dictionary A — DISPLAY. Source English term → Ukrainian label, for showing the
 *   876-exercise catalog to the owner (Ф3, #1334). 44 terms across 6 axes (equipment,
 *   category, level, force, mechanic, muscles) — exactly the list Phil counted in
 *   #1331 comment #7549. PENDING Lisa's review (requested via Phil, #1331 §8) — ships
 *   with a reasonable first-pass translation, flagged `DICTIONARY_A_STATUS` below, and
 *   is NOT read by anything filter/safety-relevant. A later review only edits values
 *   here, never the shape.
 *
 *   Dictionary B — FILTERING/GROUPING. Source raw value → OUR internal enum, used to
 *   populate exercises_catalog.equipment/muscle_group AND (guarded, see
 *   resolveLibraryEquipmentOverwrite below) to correct exercises_library's 32 existing
 *   documents. Rule (owner-lid decision, #1331 #7551 §2): EXTEND our enum, never
 *   collapse a source value into an existing one that means something else
 *   (`kettlebells → dumbbell` would make the equipment filter lie — that IS bug #1310).
 *   Every mapping function throws on an unrecognized input instead of silently
 *   defaulting to 'other' — a silent fallback for a KNOWN value is explicitly the FAIL
 *   condition in #1332 acceptance #2. An actually-new, not-yet-seen source value should
 *   fail loudly during migration, not get invented meaning here.
 */

// ---------------------------------------------------------------------------
// Dictionary A — display (EN -> UA). 44 terms, one flat namespaced-by-axis map.
// PENDING REVIEW — see file header. Do not treat as ground truth for filtering.
// ---------------------------------------------------------------------------
const DICTIONARY_A_STATUS = 'pending-lisa-review' // #1331 §8 — flip to 'reviewed' once Lisa signs off

const DISPLAY_LABELS_UA = {
  equipment: {
    'body only': "Власна вага",
    machine: "Тренажер",
    other: "Інше",
    'foam roll': "Ролер (foam roll)",
    kettlebells: "Гиря",
    dumbbell: "Гантелі",
    cable: "Блок (кабель)",
    barbell: "Штанга",
    bands: "Гумові петлі",
    'medicine ball': "Медичний м'яч",
    'exercise ball': "Фітбол",
    'e-z curl bar': "EZ-гриф",
  },
  category: {
    strength: "Силові",
    stretching: "Розтяжка",
    plyometrics: "Плайометрика",
    strongman: "Стронгмен",
    powerlifting: "Пауерліфтинг",
    cardio: "Кардіо",
    'olympic weightlifting': "Важка атлетика",
  },
  level: {
    beginner: "Початковий",
    intermediate: "Середній",
    expert: "Просунутий",
  },
  force: {
    pull: "Тяга",
    push: "Жим",
    static: "Статика",
  },
  mechanic: {
    compound: "Багатосуглобова",
    isolation: "Ізолююча",
  },
  muscles: {
    abdominals: "Прес",
    hamstrings: "Задня поверхня стегна",
    adductors: "Привідні м'язи стегна",
    quadriceps: "Квадрицепс",
    biceps: "Біцепс",
    shoulders: "Плечі",
    chest: "Груди",
    'middle back': "Середина спини",
    calves: "Литки",
    glutes: "Сідниці",
    'lower back': "Поперек",
    lats: "Широчайші",
    triceps: "Трицепс",
    traps: "Трапеції",
    forearms: "Передпліччя",
    neck: "Шия",
    abductors: "Відвідні м'язи стегна",
  },
}

// ---------------------------------------------------------------------------
// Dictionary B — filtering/grouping (source raw value -> our internal enum)
// ---------------------------------------------------------------------------

// Our pre-#1332 enum (5 values, live in health-dashboard Workouts.jsx EQUIPMENT_LABELS)
// stays a SUBSET after this map — no existing value is renamed or removed.
const NULL_KEY = '__NULL__'

const EQUIPMENT_SOURCE_TO_OURS = {
  // Already-ours, byte-identical in source and our enum
  barbell: 'barbell',
  dumbbell: 'dumbbell',
  cable: 'cable',
  machine: 'machine',
  // The ONE renaming, on the SOURCE side (owner-approved, #1331 #7551 §2)
  'body only': 'bodyweight',
  // New values — ADDED to our enum, never folded into an existing one
  kettlebells: 'kettlebell',
  bands: 'bands',
  'medicine ball': 'medicine_ball',
  'exercise ball': 'exercise_ball',
  'foam roll': 'foam_roll',
  'e-z curl bar': 'ez_curl_bar',
  other: 'other',
  // Source doesn't know (8.8% of 876, live-measured #1332) — mapped to null explicitly.
  // The MIGRATION GUARD (resolveLibraryEquipmentOverwrite) is what stops this null from
  // ever erasing an existing non-empty exercises_library value — this map only records
  // that "source says nothing" is itself a defined, expected outcome, not an error.
  [NULL_KEY]: null,
}

const MUSCLE_SOURCE_TO_GROUP = {
  chest: 'chest',
  lats: 'back',
  'middle back': 'back',
  'lower back': 'back',
  traps: 'back',
  quadriceps: 'legs',
  hamstrings: 'legs',
  glutes: 'legs',
  calves: 'legs',
  adductors: 'legs',
  abductors: 'legs',
  abdominals: 'core',
  biceps: 'biceps',
  triceps: 'triceps',
  shoulders: 'shoulders',
  // New groups (owner-lid decision, #1331 #7551 §2) — NOT folded into 'other'
  forearms: 'forearms',
  neck: 'neck',
}

/**
 * Dictionary B lookup — equipment. Throws on an unrecognized source value (including
 * anything other than exactly `null`/`undefined` for "unknown") so a genuinely new
 * source value fails the migration loudly instead of silently landing in 'other'.
 * @param {string|null|undefined} srcEquipment
 * @returns {string|null} our enum value, or null if source itself doesn't know
 */
function mapEquipmentToOurs(srcEquipment) {
  const key = srcEquipment === null || srcEquipment === undefined ? NULL_KEY : srcEquipment
  if (!Object.prototype.hasOwnProperty.call(EQUIPMENT_SOURCE_TO_OURS, key)) {
    throw new Error(`exercise-dictionaries: unmapped source equipment value ${JSON.stringify(srcEquipment)} — add an explicit Dictionary B entry before migrating`)
  }
  return EQUIPMENT_SOURCE_TO_OURS[key]
}

/**
 * Dictionary B lookup — muscle. Throws on an unrecognized source value (see above).
 * @param {string} srcMuscle one of the 17 free-exercise-db primaryMuscles/secondaryMuscles values
 * @returns {string} our muscle_group enum value (7 original + forearms + neck)
 */
function mapMuscleToGroup(srcMuscle) {
  if (!Object.prototype.hasOwnProperty.call(MUSCLE_SOURCE_TO_GROUP, srcMuscle)) {
    throw new Error(`exercise-dictionaries: unmapped source muscle value ${JSON.stringify(srcMuscle)} — add an explicit Dictionary B entry before migrating`)
  }
  return MUSCLE_SOURCE_TO_GROUP[srcMuscle]
}

/**
 * Resolve our exercises_library.muscle_group for a catalog-mapped exercise from the
 * source's primaryMuscles array — first primary muscle wins (our schema is
 * one-group-per-exercise; free-exercise-db can list several primaries, e.g. Deadlift ->
 * hamstrings+lower back+... — first entry matches the dataset's own ordering
 * convention of "main mover first").
 * @param {string[]} primaryMuscles
 * @returns {string|null}
 */
function resolvePrimaryMuscleGroup(primaryMuscles) {
  if (!primaryMuscles || primaryMuscles.length === 0) return null
  return mapMuscleToGroup(primaryMuscles[0])
}

/**
 * THE GUARD (#1332 step 6 / #1310 fix precondition). Decides the final `equipment`
 * value to write onto an EXISTING exercises_library document during migration.
 * Never lets a source `null` (source doesn't know) erase an existing non-empty value —
 * without this, migrating #1332 would silently reproduce bug #1310 at scale (77/876
 * source rows are equipment:null).
 * @param {string|null|undefined} currentValue current exercises_library.equipment
 * @param {string|null} mappedSourceValue already passed through mapEquipmentToOurs()
 * @returns {string|null} what to actually write
 */
function resolveLibraryEquipmentOverwrite(currentValue, mappedSourceValue) {
  const hasCurrent = currentValue !== null && currentValue !== undefined && currentValue !== ''
  if (mappedSourceValue === null) {
    // Source doesn't know. Keep ours if we have one; otherwise stay null (unchanged).
    return hasCurrent ? currentValue : null
  }
  return mappedSourceValue
}

module.exports = {
  DICTIONARY_A_STATUS,
  DISPLAY_LABELS_UA,
  EQUIPMENT_SOURCE_TO_OURS,
  MUSCLE_SOURCE_TO_GROUP,
  NULL_KEY,
  mapEquipmentToOurs,
  mapMuscleToGroup,
  resolvePrimaryMuscleGroup,
  resolveLibraryEquipmentOverwrite,
}
