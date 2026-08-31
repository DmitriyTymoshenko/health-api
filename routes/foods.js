const { Router } = require('express')
const https = require('https')
const querystring = require('querystring')

// ─── FatSecret ────────────────────────────────────────────────────────────────
const FS_CLIENT_ID = 'a3e1c466ef824eec8eab99cb379aa327'
const FS_CLIENT_SECRET = '578b6071811a473f901bc02611f86865'
const FS_TOKEN_URL = 'https://oauth.fatsecret.com/connect/token'
const FS_API_URL = 'https://platform.fatsecret.com/rest/server.api'

let fsToken = null
let fsTokenExpiry = 0

async function getFatSecretToken() {
  if (fsToken && Date.now() < fsTokenExpiry - 60000) return fsToken
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({ grant_type: 'client_credentials', scope: 'basic' })
    const auth = Buffer.from(`${FS_CLIENT_ID}:${FS_CLIENT_SECRET}`).toString('base64')
    const url = new URL(FS_TOKEN_URL)
    const opts = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }
    }
    const req = https.request(opts, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          fsToken = json.access_token
          fsTokenExpiry = Date.now() + (json.expires_in || 86400) * 1000
          resolve(fsToken)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function searchFatSecret(query) {
  const token = await getFatSecretToken()
  return new Promise((resolve, reject) => {
    const params = querystring.stringify({
      method: 'foods.search', search_expression: query, format: 'json', max_results: 5,
    })
    const url = new URL(FS_API_URL)
    const opts = {
      hostname: url.hostname, path: `${url.pathname}?${params}`, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    }
    const req = https.request(opts, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const foods = json?.foods?.food || []
          const arr = Array.isArray(foods) ? foods : [foods]
          const results = arr.map(f => {
            const desc = f.food_description || ''
            const kcalMatch = desc.match(/Calories:\s*([\d.]+)kcal/i)
            const fatMatch  = desc.match(/Fat:\s*([\d.]+)g/i)
            const carbsMatch = desc.match(/Carbs:\s*([\d.]+)g/i)
            const protMatch = desc.match(/Protein:\s*([\d.]+)g/i)
            return {
              food_id: f.food_id, name: f.food_name,
              kcal_per_100g:    kcalMatch  ? Math.round(parseFloat(kcalMatch[1]))  : 0,
              protein_per_100g: protMatch  ? parseFloat(protMatch[1])  : 0,
              carbs_per_100g:   carbsMatch ? parseFloat(carbsMatch[1]) : 0,
              fat_per_100g:     fatMatch   ? parseFloat(fatMatch[1])   : 0,
              fiber_per_100g: 0, sugar_per_100g: 0, salt_per_100g: 0,
              source: 'fatsecret',
            }
          })
          resolve(results.filter(r => r.kcal_per_100g > 0))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ─── Level 1: Open Food Facts ─────────────────────────────────────────────────
async function searchOpenFoodFacts(query) {
  // NOTE: URLSearchParams encodes commas → %2C which breaks OFF `fields` param.
  // Build URL manually so commas stay literal.
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + '?search_terms=' + encodeURIComponent(query)
    + '&search_simple=1&json=1&page_size=5'
    + '&fields=product_name,brands,nutriments'
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'HealthDashboard/1.0 (health tracking app)' },
  })
  const json = await res.json()
  const products = (json?.products || []).filter(p => p.product_name)

  return products.map(p => {
    const n = p.nutriments || {}
    const kcal = n['energy-kcal_100g'] ?? (n['energy_100g'] ? Math.round(n['energy_100g'] / 4.184) : 0)
    return {
      food_id: p._id || null,
      name: [p.brands, p.product_name].filter(Boolean).join(' — ').trim(),
      brand: p.brands || null,
      kcal_per_100g:    Math.round(kcal || 0),
      protein_per_100g: +((n.proteins_100g      || 0).toFixed(1)),
      carbs_per_100g:   +((n.carbohydrates_100g || 0).toFixed(1)),
      fat_per_100g:     +((n.fat_100g           || 0).toFixed(1)),
      fiber_per_100g:   +((n.fiber_100g         || 0).toFixed(1)),
      sugar_per_100g:   +((n.sugars_100g        || 0).toFixed(1)),
      salt_per_100g:    +((n.salt_100g          || 0).toFixed(2)),
      source: 'openfoodfacts',
    }
  }).filter(p => p.kcal_per_100g > 0 || p.protein_per_100g > 0)
}

// ─── Level 3: USDA FoodData Central (free, no key) ───────────────────────────
async function searchUSDA(query) {
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?' + new URLSearchParams({
    query, dataType: 'Branded,Foundation', pageSize: 5, api_key: 'DEMO_KEY',
  })
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const json = await res.json()
  const foods = json?.foods || []

  return foods.map(f => {
    const get = (name) => {
      const n = (f.foodNutrients || []).find(x => x.nutrientName === name)
      return n ? +n.value.toFixed(1) : 0
    }
    return {
      food_id: f.fdcId, name: f.description, brand: f.brandOwner || null,
      kcal_per_100g:    Math.round(get('Energy')),
      protein_per_100g: get('Protein'),
      carbs_per_100g:   get('Carbohydrate, by difference'),
      fat_per_100g:     get('Total lipid (fat)'),
      fiber_per_100g:   get('Fiber, total dietary'),
      sugar_per_100g:   get('Sugars, total including NLEA'),
      salt_per_100g:    0,
      source: 'usda',
    }
  }).filter(p => p.kcal_per_100g > 0)
}

// ─── Level 4: Web search (DuckDuckGo HTML parse) ─────────────────────────────
async function searchWeb(query) {
  const searchQ = `${query} calories nutrition facts per 100g`
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQ)}`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  const html = await res.text()

  // Collect all snippet text
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())

  // Collect nutrition values across ALL snippets (not just first match)
  const combined = snippets.join(' ')
  const num = (re) => { const m = combined.match(re); return m ? parseFloat(m[1]) : 0 }

  const kcal    = num(/(\d+(?:\.\d+)?)\s*(?:cal|kcal|calories)/i)
  const protein = num(/protein[:\s,]+(\d+(?:\.\d+)?)\s*g/i)
  const carbs   = num(/carb(?:ohydrate)?s?[:\s,]+(\d+(?:\.\d+)?)\s*g/i)
  const fat     = num(/(?:^|[^a-z])fat[:\s,]+(\d+(?:\.\d+)?)\s*g/i)
  const fiber   = num(/fiber[:\s,]+(\d+(?:\.\d+)?)\s*g/i)
  const sugar   = num(/sugar[s]?[:\s,]+(\d+(?:\.\d+)?)\s*g/i)

  if (kcal > 0) {
    return [{
      food_id: null, name: query, brand: null,
      kcal_per_100g:    Math.round(kcal),
      protein_per_100g: +protein.toFixed(1),
      carbs_per_100g:   +carbs.toFixed(1),
      fat_per_100g:     +fat.toFixed(1),
      fiber_per_100g:   +fiber.toFixed(1),
      sugar_per_100g:   +sugar.toFixed(1),
      salt_per_100g: 0,
      source: 'web',
      web_search_url: `https://duckduckgo.com/?q=${encodeURIComponent(searchQ)}`,
    }]
  }
  return []
}

// ─── Router ───────────────────────────────────────────────────────────────────
module.exports = function (getDB) {
  const router = Router()

  // GET /api/foods/search-external?q=query
  // Chain: Open Food Facts → Web search → USDA → FatSecret (generic fallback)
  router.get('/search-external', async (req, res) => {
    const query = (req.query.q || '').trim()
    if (!query) return res.json([])

    let results = []
    let source = null

    // 1. Open Food Facts — full nutrition (fiber, sugar, salt), best for branded EU/UA products
    try {
      results = await searchOpenFoodFacts(query)
      if (results.length) source = 'openfoodfacts'
    } catch (e) { console.warn('[foods] OFF error:', e.message) }

    // 2. Web search (DuckDuckGo) — branded products not in OFF (e.g. Roshen, local brands)
    if (!results.length) {
      try {
        results = await searchWeb(query)
        if (results.length) source = 'web'
      } catch (e) { console.warn('[foods] Web search error:', e.message) }
    }

    // 3. USDA FoodData Central — US branded products
    if (!results.length) {
      try {
        results = await searchUSDA(query)
        if (results.length) source = 'usda'
      } catch (e) { console.warn('[foods] USDA error:', e.message) }
    }

    // 4. FatSecret — generic/common foods (banana, rice, chicken)
    if (!results.length) {
      try {
        results = await searchWeb(query)
        if (results.length) source = 'web'
      } catch (e) { console.warn('[foods] Web search error:', e.message) }
    }

    res.json({ source: source || 'none', results })
  })

  // GET /api/foods/search?q=banana — local library
  router.get('/search', async (req, res) => {
    try {
      const db = getDB()
      const query = req.query.q || ''
      if (!query) return res.json({ source: 'library', count: 0, results: [] })

      const local = await db.collection('foods_library')
        .find({ $or: [
          { name:    { $regex: query, $options: 'i' } },
          { name_ua: { $regex: query, $options: 'i' } },
          { brand:   { $regex: query, $options: 'i' } },
          { aliases: { $regex: query, $options: 'i' } },
        ]})
        .sort({ use_count: -1 })
        .limit(10)
        .toArray()

      res.json({ source: 'library', count: local.length, results: local.map(f => ({ ...f, source: 'library' })) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/foods — save to library
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      // #931: reject bodies with no non-empty `name` BEFORE any DB write. Without this,
      // `...req.body` silently insert()s a document with no `name` at all — every future
      // reader that does `.name.*` on foods_library (#926) is a landmine waiting on it.
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
      if (!name) {
        return res.status(400).json({ error: 'name is required and must be a non-empty string' })
      }
      const food = {
        ...req.body,
        name,
        fiber_per_100g: req.body.fiber_per_100g ?? 0,
        sugar_per_100g: req.body.sugar_per_100g ?? 0,
        salt_per_100g:  req.body.salt_per_100g  ?? 0,
        created_at: new Date(), use_count: 0,
      }
      const existing = await db.collection('foods_library').findOne({
        name: { $regex: `^${food.name}$`, $options: 'i' }
      })
      if (existing) {
        await db.collection('foods_library').updateOne(
          { _id: existing._id },
          { $inc: { use_count: 1 }, $set: { updated_at: new Date() } }
        )
        return res.json({ ...existing, updated: true })
      }
      const result = await db.collection('foods_library').insertOne(food)
      res.status(201).json({ ...food, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/foods?search=query — list all saved, with optional search filter
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const search = (req.query.search || '').trim()
      const filter = search
        ? { $or: [
            { name:    { $regex: search, $options: 'i' } },
            { name_ua: { $regex: search, $options: 'i' } },
            { brand:   { $regex: search, $options: 'i' } },
          ]}
        : {}
      const foods = await db.collection('foods_library').find(filter).sort({ use_count: -1 }).limit(50).toArray()
      res.json(foods)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/foods/:id
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const result = await db.collection('foods_library').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { ...req.body, updated_at: new Date() } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/foods/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      await db.collection('foods_library').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
