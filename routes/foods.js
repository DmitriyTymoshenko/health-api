const { Router } = require('express')
const https = require('https')
const querystring = require('querystring')

// FatSecret credentials
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
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
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
      method: 'foods.search',
      search_expression: query,
      format: 'json',
      max_results: 10,
    })
    const url = new URL(FS_API_URL)
    const opts = {
      hostname: url.hostname,
      path: `${url.pathname}?${params}`,
      method: 'GET',
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
            // Parse serving description to get per-100g values
            const desc = f.food_description || ''
            // Format: "Per 100g - Calories: 89kcal | Fat: 0.33g | Carbs: 23.00g | Protein: 1.09g"
            const kcalMatch = desc.match(/Calories:\s*([\d.]+)kcal/i)
            const fatMatch = desc.match(/Fat:\s*([\d.]+)g/i)
            const carbsMatch = desc.match(/Carbs:\s*([\d.]+)g/i)
            const protMatch = desc.match(/Protein:\s*([\d.]+)g/i)
            return {
              food_id: f.food_id,
              name: f.food_name,
              kcal_per_100g: kcalMatch ? Math.round(parseFloat(kcalMatch[1])) : 0,
              protein_per_100g: protMatch ? parseFloat(protMatch[1]) : 0,
              carbs_per_100g: carbsMatch ? parseFloat(carbsMatch[1]) : 0,
              fat_per_100g: fatMatch ? parseFloat(fatMatch[1]) : 0,
              fiber_per_100g: 0,
              source: 'fatsecret',
            }
          })
          resolve(results)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

module.exports = function (getDB) {
  const router = Router()

  // GET /api/foods/search-external?q=query - FatSecret proxy
  router.get('/search-external', async (req, res) => {
    try {
      const query = req.query.q || ''
      if (!query) return res.json([])
      const results = await searchFatSecret(query)
      res.json(results)
    } catch (err) {
      console.error('FatSecret search error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/foods/search?q=banana - search local library
  router.get('/search', async (req, res) => {
    try {
      const db = getDB()
      const query = req.query.q || ''
      if (!query) return res.json([])

      const local = await db.collection('foods_library')
        .find({ $or: [
          { name: { $regex: query, $options: 'i' } },
          { name_ua: { $regex: query, $options: 'i' } },
          { aliases: { $regex: query, $options: 'i' } }
        ]})
        .limit(10)
        .toArray()

      const mapped = local.map(f => ({
        ...f,
        source: 'library',
      }))

      res.json({ source: 'library', count: mapped.length, results: mapped })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/foods - save food to library
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const food = {
        ...req.body,
        created_at: new Date(),
        use_count: 0
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

  // GET /api/foods - list all saved foods
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const foods = await db.collection('foods_library')
        .find({})
        .sort({ use_count: -1 })
        .limit(50)
        .toArray()
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
