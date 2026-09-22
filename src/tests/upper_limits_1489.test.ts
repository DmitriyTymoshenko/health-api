/**
 * #1489 (stage E of #1485, design E3, amended E3′ after QA-FAIL round 1 —
 * task #1489 comment 22.09 13:58): EVERY row of `data/upper-limits.js`
 * (numeric-UL rows AND `ul: null` no-established-UL rows alike) must carry
 * a non-null `source_url` from an allowed host, and every `ul: null` row
 * must additionally carry a non-empty `note` describing what the cited
 * source actually states. Round 1 shipped 7 `ul: null` rows with
 * `source_url: null` because this test's own acceptance had been narrowed
 * to "UNLESS ul is null" — that narrowing is the bug this file fixes.
 * No `continue`/skip on any row.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UPPER_LIMITS } = require('../../data/upper-limits')

const NO_UL_KEYS = ['creatine', 'beta_alanine', 'eaa', 'psyllium', 'ashwagandha', 'lions_mane', 'ginseng']

// Widened per E3′: ods.od.nih.gov (factsheets) | any *.nih.gov subdomain
// (nccih.nih.gov, ncbi.nlm.nih.gov, pmc.ncbi.nlm.nih.gov — the herbs/EAA
// rows have no ODS factsheet) | efsa.europa.eu | efsa.onlinelibrary.wiley.com
const ALLOWED_SOURCE_HOST = /(^|\.)nih\.gov$|(^|\.)efsa\.europa\.eu$|(^|\.)efsa\.onlinelibrary\.wiley\.com$/

function hostOf(url: string): string {
  return new URL(url).hostname
}

describe('data/upper-limits.js — E3 acceptance', () => {
  it('has the required nutrient_key rows with the values checked live 2026-09-22 against NIH ODS / EFSA', () => {
    expect(UPPER_LIMITS.vitamin_d.ul).toBe(4000)
    expect(UPPER_LIMITS.vitamin_c.ul).toBe(2000)
    expect(UPPER_LIMITS.zinc.ul).toBe(40)
    expect(UPPER_LIMITS.magnesium_supplemental.ul).toBe(350)
    expect(UPPER_LIMITS.vitamin_b6.ul).toBe(100)
    expect(UPPER_LIMITS.iron.ul).toBe(45)
    expect(UPPER_LIMITS.selenium.ul).toBe(400)
    expect(UPPER_LIMITS.vitamin_a.ul).toBe(3000)
    expect(UPPER_LIMITS.vitamin_e.ul).toBe(1000)
    expect(UPPER_LIMITS.calcium.ul).toBe(2500)
    expect(UPPER_LIMITS.folate_supplemental.ul).toBe(1000)
    expect(UPPER_LIMITS.niacin.ul).toBe(35)
    expect(UPPER_LIMITS.choline.ul).toBe(3500)
    expect(UPPER_LIMITS.omega3_epa_dha.ul).toBe(5000)
  })

  it('every row with a numeric ul has a non-empty unit AND a source_url from an allowed host', () => {
    for (const [key, row] of Object.entries<any>(UPPER_LIMITS)) {
      if (row.ul == null) continue
      expect(typeof row.unit).toBe('string')
      expect(row.unit.length).toBeGreaterThan(0)
      expect(typeof row.source_url).toBe('string')
      expect(hostOf(row.source_url)).toMatch(ALLOWED_SOURCE_HOST)
    }
  })

  it('the no-established-UL compounds are present with ul:null, unit:null, and a REAL source_url + non-empty note (E3′ — no exemption for ul:null rows)', () => {
    expect(NO_UL_KEYS.length).toBeGreaterThan(0)
    for (const key of NO_UL_KEYS) {
      expect(UPPER_LIMITS).toHaveProperty(key)
      const row = UPPER_LIMITS[key]
      expect(row.ul).toBeNull()
      expect(row.unit).toBeNull()
      expect(typeof row.source_url).toBe('string')
      expect(row.source_url.length).toBeGreaterThan(0)
      expect(hostOf(row.source_url)).toMatch(ALLOWED_SOURCE_HOST)
      expect(typeof row.note).toBe('string')
      expect(row.note.length).toBeGreaterThan(0)
    }
  })

  it('every row in the table (no skip) has a non-empty note and, if source_url is set, it resolves to an allowed host', () => {
    for (const [key, row] of Object.entries<any>(UPPER_LIMITS)) {
      expect(typeof row.note).toBe('string')
      expect(row.note.length).toBeGreaterThan(0)
      expect(row.source_url).not.toBeNull()
      expect(hostOf(row.source_url)).toMatch(ALLOWED_SOURCE_HOST)
    }
  })

  it('vitamin_d unit is IU (matches the dose text unit used live, e.g. catalog id 1 "2000 IU")', () => {
    expect(UPPER_LIMITS.vitamin_d.unit).toBe('IU')
  })

  it('omega3_epa_dha cites the EFSA 2012 opinion, not an NIH page (NIH has no formal EPA/DHA UL)', () => {
    expect(UPPER_LIMITS.omega3_epa_dha.source_url).toContain('efsa')
  })
})

export {}
