'use strict'

/**
 * #1489 (stage E of #1485, design E3): Tolerable Upper Intake Level (UL) per
 * nutrient_key, for adults (19+), all sources combined (food + supplements)
 * unless noted otherwise. Every value below was checked LIVE against its
 * source on 2026-09-22 (WebSearch against ods.od.nih.gov / EFSA — NOT from
 * memory, per the task's own acceptance requirement) — see the closing
 * `tasks_comment` on task #1489 for the verification transcript. `ul: null`
 * rows are supplements/compounds with no established Dietary Reference
 * Intake UL (not enough long-term human safety data for a numeric ceiling) —
 * their presence in this table is deliberate (so `nutrient-sum.js` can
 * surface them with a "no established UL" note instead of silently omitting
 * a row for the whole stack's ~40% non-vitamin/mineral ingredients).
 *
 * calcium: NIH ODS states 2,500 mg/day for ages 19-50 and 2,000 mg/day for
 * 51+. This table uses the single 19-50 figure (2500 mg) per the task's own
 * spec line ("calcium (2500 mg)") — a per-age UL would need the user's
 * birth_date threaded through every caller; out of scope for this stage.
 */
const UPPER_LIMITS = {
  vitamin_d: {
    ul: 4000,
    unit: 'IU',
    note: '100 mcg = 4000 IU, adults 19+',
    source_url: 'https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/',
  },
  vitamin_c: {
    ul: 2000,
    unit: 'mg',
    note: 'adults 19+; adverse effect = osmotic diarrhea',
    source_url: 'https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/',
  },
  zinc: {
    ul: 40,
    unit: 'mg',
    note: 'adults 19+, all sources',
    source_url: 'https://ods.od.nih.gov/factsheets/Zinc-HealthProfessional/',
  },
  magnesium_supplemental: {
    ul: 350,
    unit: 'mg',
    note: 'applies ONLY to supplemental/pharmacological magnesium, not food magnesium',
    source_url: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
  },
  vitamin_b6: {
    ul: 100,
    unit: 'mg',
    note: 'adults 19+ (US NIH figure — EFSA 2023 set a much lower 12 mg/day for EU adults)',
    source_url: 'https://ods.od.nih.gov/factsheets/VitaminB6-HealthProfessional/',
  },
  iron: {
    ul: 45,
    unit: 'mg',
    note: 'adults 14+, all sources; adverse effect = GI distress',
    source_url: 'https://ods.od.nih.gov/factsheets/Iron-HealthProfessional/',
  },
  selenium: {
    ul: 400,
    unit: 'mcg',
    note: 'adults 19+ (US NIH figure — EFSA 2023 set a lower 255 mcg/day for EU adults)',
    source_url: 'https://ods.od.nih.gov/factsheets/Selenium-HealthProfessional/',
  },
  vitamin_a: {
    ul: 3000,
    unit: 'mcg',
    note: 'PREFORMED vitamin A (retinol) only — does not apply to beta-carotene/carotenoids',
    source_url: 'https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/',
  },
  vitamin_e: {
    ul: 1000,
    unit: 'mg',
    note: 'adults 19+, any form of supplemental alpha-tocopherol',
    source_url: 'https://ods.od.nih.gov/factsheets/VitaminE-HealthProfessional/',
  },
  calcium: {
    ul: 2500,
    unit: 'mg',
    note: 'ages 19-50; NIH lowers this to 2000 mg/day for ages 51+ (not modeled here)',
    source_url: 'https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/',
  },
  folate_supplemental: {
    ul: 1000,
    unit: 'mcg',
    note: 'applies to folic acid from supplements/fortified food ONLY, not food folate',
    source_url: 'https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/',
  },
  niacin: {
    ul: 35,
    unit: 'mg',
    note: 'applies to supplemental niacin only, not niacin naturally in food; adverse effect = flushing',
    source_url: 'https://ods.od.nih.gov/factsheets/Niacin-HealthProfessional/',
  },
  choline: {
    ul: 3500,
    unit: 'mg',
    note: 'adults 19+, food + supplements combined',
    source_url: 'https://ods.od.nih.gov/factsheets/Choline-HealthProfessional/',
  },
  omega3_epa_dha: {
    ul: 5000,
    unit: 'mg',
    note: 'EFSA 2012 opinion — no formal UL established, but no safety concern up to ~5 g/day EPA+DHA combined supplemental intake for adults',
    source_url: 'https://efsa.onlinelibrary.wiley.com/doi/10.2903/j.efsa.2012.2815',
  },
  // No established UL — insufficient long-term human safety data for a
  // numeric ceiling. Still present so nutrient-sum.js can surface a row
  // with `ul: null` instead of silently dropping these ingredients.
  creatine: { ul: null, unit: null, note: 'no established UL', source_url: null },
  beta_alanine: { ul: null, unit: null, note: 'no established UL', source_url: null },
  eaa: { ul: null, unit: null, note: 'no established UL (individual essential amino acids)', source_url: null },
  psyllium: { ul: null, unit: null, note: 'no established UL', source_url: null },
  ashwagandha: { ul: null, unit: null, note: 'no established UL', source_url: null },
  lions_mane: { ul: null, unit: null, note: 'no established UL', source_url: null },
  ginseng: { ul: null, unit: null, note: 'no established UL', source_url: null },
}

module.exports = { UPPER_LIMITS }
