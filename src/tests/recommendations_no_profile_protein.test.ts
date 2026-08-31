/**
 * ROUTE-LEVEL test for GET /api/recommendations and GET /api/recommendations/weekly (#967).
 *
 * WHAT #967 FOUND: when `personal_profile` has NO document at all, both handlers build a
 * local "no profile" default object literal that hardcodes `daily_protein_goal_g: 150`.
 * That field is not a neutral placeholder — `resolveProteinGoalG()` (lib/nutrition-targets.js)
 * treats ANY non-null `profile.daily_protein_goal_g` as an EXPLICIT OWNER OVERRIDE that wins
 * outright over the per-kg dynamic calculation (#961/#966/#968's whole point). So the
 * "no profile exists" branch was silently forcing everyone into the literal 150g target,
 * even though `personal_profile.js`'s OWN real-profile default already uses
 * `daily_protein_goal_g: null // auto-calculate` for exactly this reason.
 *
 * This test proves the no-profile branch now falls through to the dynamic calc instead of
 * returning the literal. With weight_log = 80kg and no profile (so goal mode defaults to
 * `weight_loss`, rate 2.0 g/kg — see PROFILE/WEIGHT constants in nutrition_summary_route.test.ts,
 * same numbers), the expected target is round(80 * 2.0) = 160g, NOT 150g.
 *
 * RED-FIRST: reverting the fix (restoring `daily_protein_goal_g: 150` in the no-profile
 * default) makes both assertions below fail with the received value 150 instead of 160 —
 * verified live before this file was committed (see task #967 comment for the transcript).
 */
import request from 'supertest'
import express from 'express'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const recommendationsRouter = require('../../routes/recommendations')

type Doc = Record<string, any>

/**
 * Minimal Mongo stub covering exactly the collections both handlers read.
 * personal_profile returns null on purpose — that is the branch under test.
 * Unknown collection names throw (lesson #966: a stub must not silently mask a route
 * reading a collection nobody stubbed).
 */
function makeGetDB(opts: { latestWeight: Doc | null }) {
  return () => ({
    collection(name: string) {
      if (name === 'nutrition_log') {
        return {
          find: () => ({ toArray: async () => [] }),
        }
      }
      if (name === 'personal_profile') return { findOne: async () => null }
      if (name === 'user_settings') return { findOne: async () => null }
      if (name === 'whoop_cycles') {
        return {
          findOne: async () => null,
          find: () => ({ toArray: async () => [] }),
        }
      }
      if (name === 'weight_log') return { findOne: async () => opts.latestWeight }
      throw new Error(`recommendations route read an unexpected collection: ${name}`)
    },
  })
}

function makeApp(opts: { latestWeight: Doc | null }) {
  const app = express()
  app.use(express.json())
  app.use('/api/recommendations', recommendationsRouter(makeGetDB(opts)))
  return app
}

const WEIGHT: Doc = { date: '2026-08-31', weight_kg: 80 }
const EXPECTED_DYNAMIC_PROTEIN_G = 160 // round(80kg * 2.0 g/kg weight_loss default), NOT the old 150 literal

describe('GET /api/recommendations[/weekly] — no-profile default must not force protein_goal_g=150 (#967)', () => {
  it('GET / with no personal_profile document computes protein_target dynamically from weight, not the 150 literal', async () => {
    const app = makeApp({ latestWeight: WEIGHT })

    const res = await request(app).get('/api/recommendations').query({ date: '2026-08-31' })

    expect(res.status).toBe(200)
    expect(res.body.summary.protein_target).toBe(EXPECTED_DYNAMIC_PROTEIN_G)
    expect(res.body.summary.protein_target).not.toBe(150)
  })

  it('GET /weekly with no personal_profile document computes target_protein dynamically from weight, not the 150 literal', async () => {
    const app = makeApp({ latestWeight: WEIGHT })

    const res = await request(app).get('/api/recommendations/weekly')

    expect(res.status).toBe(200)
    expect(res.body.week_summary.target_protein).toBe(EXPECTED_DYNAMIC_PROTEIN_G)
    expect(res.body.week_summary.target_protein).not.toBe(150)
  })
})
