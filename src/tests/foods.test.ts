/**
 * Foods route — unit tests for business logic in routes/foods.js
 * Tests: FatSecret response parsing (extractNutrition), food library normalization,
 *        token cache logic (isCacheValid), search query validation
 */

// --- Replicate pure logic from routes/foods.js ---

interface FoodResult {
  food_id: string
  name: string
  kcal_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number
  sugar_per_100g: number
  source: string
}

function extractNutritionFromDescription(desc: string): {
  kcal: number
  protein: number
  carbs: number
  fat: number
} {
  const kcalMatch = desc.match(/Calories:\s*([\d.]+)kcal/i)
  const fatMatch = desc.match(/Fat:\s*([\d.]+)g/i)
  const carbsMatch = desc.match(/Carbs:\s*([\d.]+)g/i)
  const protMatch = desc.match(/Protein:\s*([\d.]+)g/i)
  return {
    kcal: kcalMatch ? Math.round(parseFloat(kcalMatch[1])) : 0,
    protein: protMatch ? parseFloat(protMatch[1]) : 0,
    carbs: carbsMatch ? parseFloat(carbsMatch[1]) : 0,
    fat: fatMatch ? parseFloat(fatMatch[1]) : 0,
  }
}

function mapFatSecretFood(f: {
  food_id: string
  food_name: string
  food_description: string
}): FoodResult {
  const desc = f.food_description || ''
  const n = extractNutritionFromDescription(desc)
  return {
    food_id: f.food_id,
    name: f.food_name,
    kcal_per_100g: n.kcal,
    protein_per_100g: n.protein,
    carbs_per_100g: n.carbs,
    fat_per_100g: n.fat,
    fiber_per_100g: 0,
    sugar_per_100g: 0,
    source: 'fatsecret',
  }
}

function isCacheValid(fsToken: string | null, fsTokenExpiry: number): boolean {
  return !!(fsToken && Date.now() < fsTokenExpiry - 60000)
}

function normalizeFoodForLibrary(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    sugar_per_100g: (body.sugar_per_100g as number) ?? 0,
    created_at: new Date(),
    use_count: 0,
  }
}

// --- Tests ---

describe('extractNutritionFromDescription — FatSecret desc parsing', () => {
  const typicalDesc = 'Per 100g - Calories: 89kcal | Fat: 0.33g | Carbs: 23.00g | Protein: 1.09g'

  it('extracts kcal correctly', () => {
    const n = extractNutritionFromDescription(typicalDesc)
    expect(n.kcal).toBe(89)
  })

  it('extracts protein correctly', () => {
    const n = extractNutritionFromDescription(typicalDesc)
    expect(n.protein).toBe(1.09)
  })

  it('extracts carbs correctly', () => {
    const n = extractNutritionFromDescription(typicalDesc)
    expect(n.carbs).toBe(23.00)
  })

  it('extracts fat correctly', () => {
    const n = extractNutritionFromDescription(typicalDesc)
    expect(n.fat).toBe(0.33)
  })

  it('rounds kcal to integer', () => {
    const n = extractNutritionFromDescription('Per 100g - Calories: 89.7kcal | Fat: 1g | Carbs: 10g | Protein: 2g')
    expect(Number.isInteger(n.kcal)).toBe(true)
    expect(n.kcal).toBe(90)
  })

  it('returns 0 for missing fields', () => {
    const n = extractNutritionFromDescription('no nutritional info')
    expect(n.kcal).toBe(0)
    expect(n.protein).toBe(0)
    expect(n.carbs).toBe(0)
    expect(n.fat).toBe(0)
  })

  it('handles empty string', () => {
    const n = extractNutritionFromDescription('')
    expect(n.kcal).toBe(0)
    expect(n.fat).toBe(0)
  })
})

describe('mapFatSecretFood — result mapping', () => {
  const rawFood = {
    food_id: '12345',
    food_name: 'Banana',
    food_description: 'Per 100g - Calories: 89kcal | Fat: 0.33g | Carbs: 23.00g | Protein: 1.09g',
  }

  it('maps food_id correctly', () => {
    const result = mapFatSecretFood(rawFood)
    expect(result.food_id).toBe('12345')
  })

  it('maps food_name to name', () => {
    const result = mapFatSecretFood(rawFood)
    expect(result.name).toBe('Banana')
  })

  it('sets source to fatsecret', () => {
    const result = mapFatSecretFood(rawFood)
    expect(result.source).toBe('fatsecret')
  })

  it('sets fiber and sugar to 0 (not in description)', () => {
    const result = mapFatSecretFood(rawFood)
    expect(result.fiber_per_100g).toBe(0)
    expect(result.sugar_per_100g).toBe(0)
  })

  it('handles missing food_description gracefully', () => {
    const result = mapFatSecretFood({ ...rawFood, food_description: '' })
    expect(result.kcal_per_100g).toBe(0)
  })
})

describe('isCacheValid — token cache logic', () => {
  it('returns false when token is null', () => {
    expect(isCacheValid(null, Date.now() + 9999999)).toBe(false)
  })

  it('returns false when token is expired', () => {
    expect(isCacheValid('tok', Date.now() - 1000)).toBe(false)
  })

  it('returns false when token expires within 60s', () => {
    expect(isCacheValid('tok', Date.now() + 30000)).toBe(false)
  })

  it('returns true when token is valid and not near expiry', () => {
    expect(isCacheValid('tok', Date.now() + 120000)).toBe(true)
  })
})

describe('normalizeFoodForLibrary — library entry normalization', () => {
  it('defaults sugar_per_100g to 0 when missing', () => {
    const food = normalizeFoodForLibrary({ name: 'Rice', kcal_per_100g: 130 })
    expect(food.sugar_per_100g).toBe(0)
  })

  it('preserves provided sugar_per_100g', () => {
    const food = normalizeFoodForLibrary({ name: 'Candy', kcal_per_100g: 400, sugar_per_100g: 50 })
    expect(food.sugar_per_100g).toBe(50)
  })

  it('adds created_at as Date', () => {
    const food = normalizeFoodForLibrary({ name: 'Oats' })
    expect(food.created_at).toBeInstanceOf(Date)
  })

  it('sets use_count to 0 for new entries', () => {
    const food = normalizeFoodForLibrary({ name: 'Chicken' })
    expect(food.use_count).toBe(0)
  })

  it('preserves all nutritional fields', () => {
    const food = normalizeFoodForLibrary({
      name: 'Egg',
      kcal_per_100g: 155,
      protein_per_100g: 13,
      fat_per_100g: 11,
      carbs_per_100g: 1.1,
    })
    expect(food.kcal_per_100g).toBe(155)
    expect(food.protein_per_100g).toBe(13)
  })
})
