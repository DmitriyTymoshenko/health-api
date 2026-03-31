const { MongoClient } = require('mongodb')

const client = new MongoClient('mongodb://localhost:27017')

const knowledge = [
  {
    catalog_id: 1,
    name: 'GymBeam Vitamin D3',
    active_ingredients: [
      { name: 'Vitamin D3', amount_per_dose: 2000, unit: 'IU', equivalent_mg: 0.05 }
    ],
    covers: ['vitamin_d', 'D3'],
    notes: 'Підтримує імунітет, засвоєння кальцію, настрій. 2000 IU — помірна доза, добре для підтримки.'
  },
  {
    catalog_id: 2,
    name: 'GymBeam Omega 3',
    active_ingredients: [
      { name: 'Fish oil', amount_per_dose: 2000, unit: 'mg' },
      { name: 'EPA+DHA', amount_per_dose: 600, unit: 'mg' }
    ],
    covers: ['omega3', 'EPA', 'DHA', 'fish_oil'],
    notes: '600мг EPA+DHA на 2 капс — достатньо для базової підтримки (норма 500-1000мг EPA+DHA). При запаленнях корисно збільшити до 3-4 капс.'
  },
  {
    catalog_id: 3,
    name: 'Amix Creatine HCl',
    active_ingredients: [
      { name: 'Creatine HCl', amount_per_dose: 3000, unit: 'mg' }
    ],
    covers: ['creatine'],
    cycle: { duration_weeks: 8, pause_weeks: 4 },
    notes: 'HCl форма — краще засвоєння, менша затримка води ніж моногідрат. 3г = еквівалент ~5г моногідрату.'
  },
  {
    catalog_id: 4,
    name: 'GymBeam Vitality Complex',
    active_ingredients: [
      { name: 'Vitamin B1', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Vitamin B2', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Vitamin B3', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Vitamin B5', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Vitamin B6', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Vitamin B7 (Biotin)', amount_per_dose: null, unit: 'mcg', note: 'RDA' },
      { name: 'Vitamin B9 (Folic acid)', amount_per_dose: null, unit: 'mcg', note: 'RDA' },
      { name: 'Vitamin B12', amount_per_dose: null, unit: 'mcg', note: 'RDA' },
      { name: 'Vitamin C', amount_per_dose: 80, unit: 'mg', note: 'RDA only — athletes need 500-1000mg' },
      { name: 'Vitamin E', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Vitamin A', amount_per_dose: null, unit: 'mcg', note: 'RDA' },
      { name: 'Magnesium', amount_per_dose: 75, unit: 'mg', note: 'Partial — ZMA covers rest' },
      { name: 'Zinc', amount_per_dose: 8, unit: 'mg', note: 'Partial — ZMA covers rest' },
      { name: 'Iron', amount_per_dose: null, unit: 'mg', note: 'RDA' },
      { name: 'Selenium', amount_per_dose: null, unit: 'mcg', note: 'RDA' },
      { name: 'Chromium', amount_per_dose: null, unit: 'mcg', note: 'RDA — helps blood glucose' },
      { name: 'CoQ10', amount_per_dose: 20, unit: 'mg', note: 'Trace dose — therapeutic needs 100-200mg' },
      { name: 'Alpha-lipoic acid', amount_per_dose: null, unit: 'mg', note: 'Trace' },
      { name: 'DigeZyme (digestive enzymes)', amount_per_dose: null, unit: 'mg' },
      { name: 'Hesperidin', amount_per_dose: null, unit: 'mg' },
      { name: 'Choline bitartrate', amount_per_dose: null, unit: 'mg' },
      { name: 'Echinacea extract', amount_per_dose: null, unit: 'mg' },
      { name: 'Rosehip extract', amount_per_dose: null, unit: 'mg' },
      { name: 'Grape Seed extract 95% OPC', amount_per_dose: null, unit: 'mg' }
    ],
    covers: ['vitamin_b1','vitamin_b2','vitamin_b3','vitamin_b5','vitamin_b6','biotin','folic_acid','vitamin_b12','vitamin_c','vitamin_e','vitamin_a','magnesium_partial','zinc_partial','iron','selenium','chromium','coq10_trace','choline'],
    coverage_gaps: [
      { nutrient: 'vitamin_c', reason: 'Only ~80mg (RDA). Athletes need 500-1000mg', recommend_extra: '500mg Vitamin C separately' },
      { nutrient: 'coq10', reason: 'Only ~20mg (trace). Therapeutic dose 100-200mg', recommend_extra: 'CoQ10 100mg if HRV < 40' }
    ],
    notes: '24 інгредієнти. Відмінна база. Слабкі місця: Vit C і CoQ10 в неефективних дозах для активного атлета.'
  },
  {
    catalog_id: 5,
    name: 'NOW Organic Spirulina',
    active_ingredients: [
      { name: 'Spirulina', amount_per_dose: 3000, unit: 'mg', note: '6 tablets' }
    ],
    covers: ['spirulina', 'plant_protein', 'chlorophyll', 'iodine_partial', 'iron_plant'],
    notes: 'Водорость — білок 60-70%, B12 (неактивна форма), залізо, антиоксиданти. 3-6 табл = 1.5-3г.'
  },
  {
    catalog_id: 6,
    name: 'NOW Psyllium Husk Caps',
    active_ingredients: [
      { name: 'Psyllium Husk', amount_per_dose: 2500, unit: 'mg', note: '5 capsules' }
    ],
    covers: ['fiber', 'psyllium', 'soluble_fiber'],
    notes: 'Розчинна клітковина. Уповільнює засвоєння вуглеводів, знижує апетит, підтримує мікрофлору кишківника. Приймати за 15-20 хв до їжі з великою кількістю води.'
  },
  {
    catalog_id: 7,
    name: 'Applied Nutrition Amino Fuel EAA',
    active_ingredients: [
      { name: 'Essential Amino Acids (EAA)', amount_per_dose: 10000, unit: 'mg', note: '1 scoop' },
      { name: 'Leucine', amount_per_dose: null, unit: 'mg' },
      { name: 'Isoleucine', amount_per_dose: null, unit: 'mg' },
      { name: 'Valine', amount_per_dose: null, unit: 'mg' }
    ],
    covers: ['eaa', 'bcaa', 'leucine', 'isoleucine', 'valine', 'amino_acids'],
    notes: 'Всі 9 незамінних амінокислот. Кращий вибір ніж BCAA — підтримує синтез білка, зменшує катаболізм під час тренування.'
  },
  {
    catalog_id: 8,
    name: 'VPLab ZMA',
    active_ingredients: [
      { name: 'Zinc (aspartate)', amount_per_dose: 30, unit: 'mg' },
      { name: 'Magnesium (aspartate)', amount_per_dose: 450, unit: 'mg' },
      { name: 'Vitamin B6', amount_per_dose: 10.5, unit: 'mg' }
    ],
    covers: ['zinc', 'magnesium', 'vitamin_b6_extra'],
    notes: 'Класична ZMA формула. Zinc 30мг = 200% RDA. Mg 450мг = ~100% RDA для чоловіків. Приймати натщесерце перед сном (не з молоком/Ca).'
  }
]

async function run() {
  await client.connect()
  const db = client.db('health_tracker')
  
  // Clear and reseed
  await db.collection('supplement_knowledge').deleteMany({})
  await db.collection('supplement_knowledge').insertMany(knowledge)
  await db.collection('supplement_knowledge').createIndex({ catalog_id: 1 }, { unique: true })
  
  console.log(`Seeded ${knowledge.length} supplement knowledge entries`)
  
  // Verify
  const count = await db.collection('supplement_knowledge').countDocuments()
  console.log(`Total in DB: ${count}`)
  
  await client.close()
}

run().catch(console.error)
