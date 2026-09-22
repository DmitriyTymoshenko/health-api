'use strict'

// #1490 (stage F of #1485, design shared with stage E / #1489): the ONE
// canonical nutrient_key dictionary — both #1489 (Noah, stack engine:
// lib/nutrient-sum.js UPPER_LIMITS join + lib/interactions.js matching) and
// #1490 (Martin, this stage: active_ingredients[].nutrient_key +
// interactions[].with) key against nutrient_key. Whoever merges first
// creates this file; the other rebases onto it instead of keeping a second,
// inline copy (owner-flagged collision risk in both tasks' handoffs).
//
// NUTRIENT_SYNONYMS maps a raw `active_ingredients[].name` (lowercased, with
// any "(...)" qualifier stripped — the salt/form doesn't change which key
// applies, e.g. "Zinc (aspartate)" -> "zinc") to its canonical nutrient_key.
// normalizeNutrientKey() is the SAME fallback logic #1489's
// lib/nutrient-sum.js already implements inline — kept identical here so a
// rebase is a mechanical "import from here instead" with no behaviour
// change: unmatched names degrade to a generic slug (still stable, just not
// present in data/upper-limits.js, so a stack-sum row for it reports
// `ul: null` rather than a warning).
const NUTRIENT_SYNONYMS = {
  'vitamin d3': 'vitamin_d',
  'vitamin d': 'vitamin_d',
  'vitamin c': 'vitamin_c',
  'vitamin b1': 'vitamin_b1',
  'vitamin b2': 'vitamin_b2',
  'vitamin b3': 'niacin',
  niacin: 'niacin',
  'vitamin b5': 'vitamin_b5',
  'vitamin b6': 'vitamin_b6',
  'vitamin b7': 'biotin',
  'vitamin b7 (biotin)': 'biotin',
  biotin: 'biotin',
  'vitamin b9': 'folate_supplemental',
  'vitamin b9 (folic acid)': 'folate_supplemental',
  folate: 'folate_supplemental',
  'folic acid': 'folate_supplemental',
  'vitamin b12': 'vitamin_b12',
  'vitamin a': 'vitamin_a',
  'vitamin e': 'vitamin_e',
  zinc: 'zinc',
  magnesium: 'magnesium_supplemental',
  iron: 'iron',
  selenium: 'selenium',
  calcium: 'calcium',
  chromium: 'chromium',
  choline: 'choline',
  'choline bitartrate': 'choline',
  coq10: 'coq10',
  'alpha-lipoic acid': 'alpha_lipoic_acid',
  'digezyme': 'digezyme',
  'digezyme (digestive enzymes)': 'digezyme',
  hesperidin: 'hesperidin',
  'echinacea extract': 'echinacea',
  'rosehip extract': 'rosehip',
  'grape seed extract 95% opc': 'grape_seed_extract',
  'fish oil': 'fish_oil',
  'epa+dha': 'omega3_epa_dha',
  epa: 'omega3_epa_dha',
  dha: 'omega3_epa_dha',
  'omega-3': 'omega3_epa_dha',
  'omega 3': 'omega3_epa_dha',
  creatine: 'creatine',
  'creatine hcl': 'creatine',
  'creatine monohydrate': 'creatine',
  'beta-alanine': 'beta_alanine',
  'beta alanine': 'beta_alanine',
  'essential amino acids (eaa)': 'eaa',
  'essential amino acids': 'eaa',
  eaa: 'eaa',
  leucine: 'leucine',
  isoleucine: 'isoleucine',
  valine: 'valine',
  spirulina: 'spirulina',
  'psyllium husk': 'psyllium',
  psyllium: 'psyllium',
  'withania somnifera root extract': 'ashwagandha',
  ashwagandha: 'ashwagandha',
  "lion's mane": 'lions_mane',
  'lions mane': 'lions_mane',
  "lion's mane extract": 'lions_mane',
  ginseng: 'ginseng',
  'asian ginseng': 'ginseng',
}

/**
 * @param {string} name raw active_ingredients[].name from supplement_knowledge
 * @returns {string} a stable grouping key — a data/upper-limits.js key when a
 *   synonym matches, otherwise a generic slug (still stable, just has no UL
 *   row — the stack-sum engine reports `ul: null` for it, not a warning).
 */
function normalizeNutrientKey(name) {
  if (!name || typeof name !== 'string') return 'unknown'
  const stripped = name.replace(/\([^)]*\)/g, '').trim().toLowerCase()
  if (NUTRIENT_SYNONYMS[stripped]) return NUTRIENT_SYNONYMS[stripped]
  const slug = stripped.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return slug || 'unknown'
}

module.exports = { NUTRIENT_SYNONYMS, normalizeNutrientKey }
