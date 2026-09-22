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
  // #1489 QA-FAIL round 1 / spec amendment E3′ (Apex, task #1489 comment
  // 22.09 13:58): every row — including `ul: null` rows — MUST carry a
  // non-null `source_url` + a non-empty `note` naming what the source
  // actually states. Host allowlist widened for these 7 rows to any
  // `*.nih.gov` subdomain (ODS itself has no factsheet for the herbs) plus
  // EFSA. Every URL below was checked LIVE 2026-09-22: `curl -o /dev/null
  // -w '%{http_code}'` returns 403 for ods.od.nih.gov / efsa.onlinelibrary
  // .wiley.com (their edge WAF blocks non-browser clients — confirmed by
  // curling the ALREADY-accepted vitamin_d/omega3_epa_dha URLs above, same
  // 403) and 200 for the ncbi.nlm.nih.gov/nccih.nih.gov/pmc.ncbi.nlm.nih.gov
  // hosts; the WAF-blocked ones were confirmed live via WebSearch instead
  // (title + URL match) — table in the #1489 closing `tasks_comment`.
  creatine: {
    ul: null,
    unit: null,
    note: 'no UL set; NIH ODS "Dietary Supplements for Exercise and Athletic Performance" factsheet: creatine (3-5 g/day maintenance, up to ~20 g/day short-term loading protocols) is well tolerated in healthy adults — no formal UL established',
    source_url: 'https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-HealthProfessional/',
  },
  beta_alanine: {
    ul: null,
    unit: null,
    note: 'no UL set; NIH ODS "Dietary Supplements for Exercise and Athletic Performance" factsheet: 4-6 g/day for ~10 weeks raises muscle carnosine, with dose-dependent paresthesia (tingling) as the main reported side effect — no formal UL established',
    source_url: 'https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-HealthProfessional/',
  },
  eaa: {
    ul: null,
    unit: null,
    note: 'no UL set (individual essential amino acids); NCBI Bookshelf "Safety Concerns Regarding Supplemental Amino Acids": EAA-based supplementation generally does not raise urea/ammonia production in healthy adults, but safety data in impaired renal function is insufficient — no formal UL established',
    source_url: 'https://www.ncbi.nlm.nih.gov/books/NBK209070/',
  },
  psyllium: {
    ul: null,
    unit: null,
    note: 'no UL set; EFSA 2010 dietary-fibre health-claims opinion (ID 744 et al.) authorizes psyllium claims for glycemic/GI function at 3.5-14 g/day and satiety at 1-3 g/day, i.e. those intakes are EFSA-reviewed as beneficial, but the opinion sets no formal upper intake level',
    source_url: 'https://efsa.onlinelibrary.wiley.com/doi/10.2903/j.efsa.2010.1735',
  },
  ashwagandha: {
    ul: null,
    unit: null,
    note: 'no UL set; NCCIH ashwagandha herb page: has sedative effects and may potentiate benzodiazepines/other sedatives; long-term human safety data are limited — no formal UL established',
    source_url: 'https://www.nccih.nih.gov/health/ashwagandha',
  },
  lions_mane: {
    ul: null,
    unit: null,
    note: "no UL set; PMC toxicological assessment of Hericium erinaceus (lion's mane): a 13-week rodent feeding study found no mortality/toxicity signal at tested doses; long-term human safety data are limited — no formal UL established",
    source_url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12603391/',
  },
  ginseng: {
    ul: null,
    unit: null,
    note: 'no UL set; NCCIH "Asian Ginseng: Usefulness and Safety": short-term use at recommended amounts appears safe for most people, but long-term safety is uncertain — no formal UL established',
    source_url: 'https://www.nccih.nih.gov/health/asian-ginseng',
  },
}

module.exports = { UPPER_LIMITS }
