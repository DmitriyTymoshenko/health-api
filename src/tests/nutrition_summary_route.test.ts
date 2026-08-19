/**
 * ROUTE-LEVEL test for GET /api/nutrition/summary (#955, from the #953 QA finding).
 *
 * WHY THIS FILE EXISTS — the "mirror test" class (#909):
 * the sat_fat/sugar MATH in lib/nutrition-targets.js is covered by 51 unit tests, and the
 * day AGGREGATION in lib/nutrition-aggregate.js has its own suite — but the WIRING in
 * routes/nutrition.js `summaryHandler` (the code that actually attaches sat_fat_goal_g /
 * sat_fat_status / sugar_goal_g / sugar_status onto the response, and feeds them the
 * stable profile basis) was covered by NOTHING. Max proved it with mutations on 2026-08-09:
 * the whole #953 deliverable could be deleted from the production route and the suite
 * stayed 407/407 green, because the test that looked like it guarded this
 * (`historical entries without sugar_g` in nutrition_targets.test.ts) re-implements
 * `entries.reduce(...)` in its own body instead of calling the route.
 *
 * So this file drives the REAL router factory — `require('../../routes/nutrition')(getDB)`
 * — over HTTP via supertest (which binds an ephemeral port in-process, the same live-run
 * pattern used to verify #953). Nothing here re-computes a sum or a ceiling: every number
 * asserted is a literal derived by hand from the stubbed profile, so if the route stops
 * attaching a field, or attaches the wrong one, this goes red.
 *
 * ACCEPTANCE (proved before commit — see the task comment for the transcripts): this file
 * turns RED on both of Max's mutations —
 *   1) delete `if (item.sugar_g == null) acc.sugar_incomplete = true`
 *      (lib/nutrition-aggregate.js — the route reaches it through aggregateDay())
 *   2) delete both `summary.sugar_goal_g` / `summary.sugar_status` lines
 *      (routes/nutrition.js summaryHandler)
 * and GREEN after each revert.
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nutritionRouter = require('../../routes/nutrition')

type Doc = Record<string, any>

/**
 * Minimal Mongo stub covering EXACTLY the three collections summaryHandler reads.
 *
 * Collection names were verified against the LIVE `health_tracker` database before this
 * stub was written (nutrition_log 866 docs · personal_profile 1 · weight_log 33) — lesson
 * #966: a stub that faithfully reproduces the route's typo is green and blind. Any other
 * collection name THROWS, so if the route later starts reading a fourth collection this
 * test fails loudly instead of silently returning undefined.
 */
function makeGetDB(opts: { entries: Doc[]; profile: Doc | null; latestWeight: Doc | null }) {
  return () => ({
    collection(name: string) {
      if (name === 'nutrition_log') {
        return {
          // Honours the filter on purpose: proves summaryHandler passes ?date= into the
          // query instead of pulling the whole collection and filtering later.
          find: (filter: Doc) => ({
            toArray: async () => opts.entries.filter((e) => e.date === filter.date),
          }),
        }
      }
      if (name === 'personal_profile') return { findOne: async () => opts.profile }
      if (name === 'weight_log') return { findOne: async () => opts.latestWeight }
      throw new Error(`summaryHandler read an unexpected collection: ${name}`)
    },
  })
}

function makeApp(opts: { entries: Doc[]; profile: Doc | null; latestWeight: Doc | null }) {
  const app = express()
  app.use(express.json())
  app.use('/api/nutrition', nutritionRouter(makeGetDB(opts)))
  return app
}

/**
 * `daily_kcal_goal: 2000` pins the ceiling basis to a round number with NO dependence on
 * TDEE/deficit/goal-mode resolution, so the two expected limits below are hand-derivable:
 *   sat_fat_goal_g = round(2000 * 0.10 / 9 kcal/g) = round(22.22) = 22
 *   sugar_goal_g   = round(2000 * 0.10 / 4 kcal/g) = 50
 *   fiber_goal_g   = round(2000 * 14 / 1000)       = 28
 *   protein_goal_g = round(80 kg * 2.0 g/kg [weight_loss default]) = 160
 */
const PROFILE: Doc = { _type: 'profile', daily_kcal_goal: 2000 }
const WEIGHT: Doc = { date: '2026-08-18', weight_kg: 80 }
const SAT_FAT_GOAL_G = 22
const SUGAR_GOAL_G = 50

describe('GET /api/nutrition/summary — route wiring of the sat_fat_* / sugar_* fields (#955)', () => {
  it('a day with full data returns all four ceiling fields, each from its OWN metric', async () => {
    const app = makeApp({
      profile: PROFILE,
      latestWeight: WEIGHT,
      entries: [
        { date: '2026-08-18', kcal: 600, protein_g: 40, carbs_g: 50, fat_g: 20, fiber_g: 5, sugar_g: 30, sat_fat_g: 8 },
        { date: '2026-08-18', kcal: 400, protein_g: 20, carbs_g: 30, fat_g: 10, fiber_g: 3, sugar_g: 25, sat_fat_g: 12 },
        // Decoy on another date — must NOT be summed in.
        { date: '2026-08-17', kcal: 9999, sugar_g: 999, sat_fat_g: 999 },
      ],
    })

    const res = await request(app).get('/api/nutrition/summary').query({ date: '2026-08-18' })

    expect(res.status).toBe(200)
    expect(res.body.date).toBe('2026-08-18')
    expect(res.body.items).toBe(2) // decoy excluded => the ?date= filter really reached the query
    expect(res.body.kcal).toBe(1000)

    // The #953 deliverable, asserted field by field.
    expect(res.body.sat_fat_g).toBe(20)
    expect(res.body.sat_fat_goal_g).toBe(SAT_FAT_GOAL_G)
    expect(res.body.sugar_g).toBe(55)
    expect(res.body.sugar_goal_g).toBe(SUGAR_GOAL_G)

    // DELIBERATELY two DIFFERENT statuses: 20/22 = 91% -> warning, 55/50 = 110% -> danger.
    // A copy-paste that fed the sugar status the sat-fat numbers (or vice versa) would be
    // invisible if both landed on the same rung of the ladder.
    expect(res.body.sat_fat_status).toBe('warning')
    expect(res.body.sugar_status).toBe('danger')

    // Both totals are complete on this day — the flags must stay false.
    expect(res.body.sat_fat_incomplete).toBe(false)
    expect(res.body.sugar_incomplete).toBe(false)

    // The goal fields (#961/#966) ride the same handler; assert they are wired too, so a
    // regression there cannot hide behind this file's ceiling focus.
    expect(res.body.protein_goal_g).toBe(160)
    expect(res.body.fiber_goal_g).toBe(28)
    expect(res.body.protein_incomplete).toBe(false)
  })

  it('a day holding legacy entries without sugar_g flags sugar_incomplete WITHOUT touching sat_fat_incomplete', async () => {
    const app = makeApp({
      profile: PROFILE,
      latestWeight: WEIGHT,
      entries: [
        { date: '2026-07-27', kcal: 500, protein_g: 30, carbs_g: 40, fat_g: 15, fiber_g: 4, sugar_g: 20, sat_fat_g: 5 },
        // LEGACY nested-items shape (pre photo-recognition quick log): no top-level
        // sugar_g at all, but a back-filled sat_fat_g. This is the real on-disk case #862
        // measured on 2026-07-27.
        { date: '2026-07-27', sat_fat_g: 4, items: [{ name: 'борщ', kcal: 300, protein: 10, fat: 5, carbs: 40 }] },
      ],
    })

    const res = await request(app).get('/api/nutrition/summary').query({ date: '2026-07-27' })

    expect(res.status).toBe(200)
    // THE assertion this whole file exists for.
    expect(res.body.sugar_incomplete).toBe(true)
    // …and it must be the SUGAR flag specifically: sat_fat_g is present on both entries,
    // so a mutation that flipped every flag to true would fail here.
    expect(res.body.sat_fat_incomplete).toBe(false)

    // The under-reported sugar total still gets a real ceiling and a real status.
    expect(res.body.sugar_g).toBe(20)
    expect(res.body.sugar_goal_g).toBe(SUGAR_GOAL_G)
    expect(res.body.sugar_status).toBe('ok') // 20/50 = 40%
    expect(res.body.sat_fat_g).toBe(9)
    expect(res.body.sat_fat_goal_g).toBe(SAT_FAT_GOAL_G)
    // Legacy nested kcal is counted (500 + 300) — the #862 fix, exercised through the route.
    expect(res.body.kcal).toBe(800)
  })

  it('an empty day answers 200 with zeroed totals and the ceilings still attached', async () => {
    const app = makeApp({ profile: PROFILE, latestWeight: WEIGHT, entries: [] })

    const res = await request(app).get('/api/nutrition/summary').query({ date: '2026-01-01' })

    expect(res.status).toBe(200)
    expect(res.body.date).toBe('2026-01-01')
    expect(res.body.items).toBe(0)
    expect(res.body.kcal).toBe(0)
    expect(res.body.sugar_g).toBe(0)
    expect(res.body.sat_fat_g).toBe(0)
    // A day with nothing logged is not an INCOMPLETE day — there is no entry missing a field.
    expect(res.body.sugar_incomplete).toBe(false)
    expect(res.body.sat_fat_incomplete).toBe(false)
    // The ceilings come from the profile, not from the entries, so they must still be here.
    expect(res.body.sugar_goal_g).toBe(SUGAR_GOAL_G)
    expect(res.body.sat_fat_goal_g).toBe(SAT_FAT_GOAL_G)
    expect(res.body.sugar_status).toBe('ok')
    expect(res.body.sat_fat_status).toBe('ok')
  })

  it('the same wiring holds on the /summary/today alias (it delegates to summaryHandler)', async () => {
    const today = new Date().toISOString().split('T')[0]
    const app = makeApp({
      profile: PROFILE,
      latestWeight: WEIGHT,
      entries: [{ date: today, kcal: 700, protein_g: 35, carbs_g: 60, fat_g: 25, fiber_g: 6, sugar_g: 60, sat_fat_g: 25 }],
    })

    const res = await request(app).get('/api/nutrition/summary/today')

    expect(res.status).toBe(200)
    expect(res.body.sugar_goal_g).toBe(SUGAR_GOAL_G)
    expect(res.body.sat_fat_goal_g).toBe(SAT_FAT_GOAL_G)
    expect(res.body.sugar_status).toBe('danger') // 60/50 = 120%
    expect(res.body.sat_fat_status).toBe('danger') // 25/22 = 114%
  })
})
