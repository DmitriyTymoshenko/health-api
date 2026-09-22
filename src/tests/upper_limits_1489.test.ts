/**
 * #1489 (stage E of #1485, design E3): data/upper-limits.js. Acceptance:
 * every entry has `unit` + `source_url` from ods.od.nih.gov or
 * efsa.europa.eu (efsa.onlinelibrary.wiley.com is EFSA's own journal host —
 * treated as an EFSA source) — UNLESS `ul` is explicitly null (no
 * established UL), in which case unit/source_url may also be null.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UPPER_LIMITS } = require('../../data/upper-limits')

const NO_UL_KEYS = ['creatine', 'beta_alanine', 'eaa', 'psyllium', 'ashwagandha', 'lions_mane', 'ginseng']

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

  it('every row with a numeric ul has a unit AND a source_url from ods.od.nih.gov or an EFSA host', () => {
    for (const [key, row] of Object.entries<any>(UPPER_LIMITS)) {
      if (row.ul == null) continue
      expect(typeof row.unit).toBe('string')
      expect(row.unit.length).toBeGreaterThan(0)
      expect(typeof row.source_url).toBe('string')
      expect(row.source_url).toMatch(/ods\.od\.nih\.gov|efsa\.europa\.eu|efsa\.onlinelibrary\.wiley\.com/)
    }
  })

  it('the no-established-UL compounds are present with ul:null (not silently omitted)', () => {
    for (const key of NO_UL_KEYS) {
      expect(UPPER_LIMITS).toHaveProperty(key)
      expect(UPPER_LIMITS[key].ul).toBeNull()
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
