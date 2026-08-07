const express = require('express')
const cors = require('cors')
const { MongoClient } = require('mongodb')
const fs = require('fs')
const path = require('path')

const pkg = require('./package.json')

const app = express()
const PORT = 3001
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017'
const DB_NAME = 'health_tracker'

// #872 Finding #1: default express.json() body limit is 100kb. A real phone photo is 2-5MB, and
// base64-encoding it (as PhotoRecognize.jsx does before POSTing to /api/nutrition/recognize)
// inflates that by ~4/3 — so EVERY real-world photo was rejected with a raw 413 before reaching
// any route handler (a mini-thumbnail was the only thing that ever worked). Raised for all
// routes (single-owner tool, not a public API) rather than scoped per-route, because
// express.json() runs once at the app level before routing and a route-scoped override would
// re-read an already-consumed stream. Env-overridable so it can be tuned without a code change.
const JSON_BODY_LIMIT = process.env.HEALTH_API_JSON_LIMIT || '10mb'

app.use(cors())
app.use(express.json({ limit: JSON_BODY_LIMIT }))

let db

async function connectDB() {
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  db = client.db(DB_NAME)
  console.log('Connected to MongoDB')

  // Create indexes
  await db.collection('daily_metrics').createIndex({ date: 1 }, { unique: true })
  await db.collection('nutrition_log').createIndex({ date: 1 })
  await db.collection('nutrition_log').createIndex({ date: 1, meal_type: 1 })
  await db.collection('supplements_log').createIndex({ date: 1 })
  await db.collection('water_log').createIndex({ date: 1 })
  await db.collection('water_log').createIndex({ timestamp: 1 })
  await db.collection('workouts').createIndex({ date: -1 })
  await db.collection('weight_log').createIndex({ date: -1 })
  await db.collection('goals').createIndex({ type: 1 })
  await db.collection('notes').createIndex({ date: -1 })
  await db.collection('notes').createIndex({ tags: 1 })

  console.log('Indexes created')
  return db
}

function getDB() {
  if (!db) throw new Error('Database not connected')
  return db
}

// Seed data from fitness.json
async function seedData() {
  try {
    const fitnessPath = '/root/.config/health/fitness.json'
    if (!fs.existsSync(fitnessPath)) {
      console.log('fitness.json not found, skipping seed')
      return
    }

    const raw = fs.readFileSync(fitnessPath, 'utf8')
    const data = JSON.parse(raw)
    const today = new Date().toISOString().split('T')[0]

    // Seed weight log
    if (data.weight_log && data.weight_log.length > 0) {
      const weightColl = db.collection('weight_log')
      for (const entry of data.weight_log) {
        await weightColl.updateOne(
          { date: entry.date, weight_kg: entry.weight_kg },
          { $setOnInsert: { date: entry.date, weight_kg: entry.weight_kg, note: entry.note || '' } },
          { upsert: true }
        )
      }
      console.log(`Seeded ${data.weight_log.length} weight entries`)
    }

    // Seed nutrition log
    if (data.nutrition_log) {
      const nutritionColl = db.collection('nutrition_log')
      for (const [date, dayData] of Object.entries(data.nutrition_log)) {
        if (dayData.meals) {
          for (const meal of dayData.meals) {
            await nutritionColl.updateOne(
              { date, food_name: meal.name, meal_type: meal.meal, amount_g: meal.amount_g },
              {
                $setOnInsert: {
                  date,
                  meal_type: meal.meal,
                  food_name: meal.name,
                  food_id: meal.food_id || null,
                  amount_g: meal.amount_g,
                  kcal: meal.kcal,
                  protein_g: meal.protein || 0,
                  carbs_g: meal.carbs || 0,
                  fat_g: meal.fat || 0,
                  fiber_g: meal.fiber || 0,
                  sat_fat_g: meal.sat_fat || 0,
                }
              },
              { upsert: true }
            )
          }
        }
      }
      console.log('Seeded nutrition log')
    }

    // Seed daily log (water + vitamins)
    if (data.daily_log) {
      for (const [date, dayLog] of Object.entries(data.daily_log)) {
        // Water
        if (dayLog.water_ml) {
          const waterColl = db.collection('water_log')
          await waterColl.updateOne(
            { date, source: 'seed' },
            {
              $setOnInsert: {
                date,
                amount_ml: dayLog.water_ml,
                timestamp: new Date(date),
                source: 'seed',
              }
            },
            { upsert: true }
          )
        }

        // Vitamins / supplements from goals
        if (data.goals && data.goals.vitamins) {
          const suppColl = db.collection('supplements_log')
          const vitamins = data.goals.vitamins
          const allMorning = vitamins.morning || []
          for (const vit of allMorning) {
            await suppColl.updateOne(
              { date, supplement_name: vit, timing: 'morning' },
              {
                $setOnInsert: {
                  date,
                  supplement_name: vit,
                  timing: 'morning',
                  taken: dayLog.vitamins_morning === true,
                }
              },
              { upsert: true }
            )
          }
          const allEvening = vitamins.evening || []
          for (const vit of allEvening) {
            await suppColl.updateOne(
              { date, supplement_name: vit, timing: 'evening' },
              {
                $setOnInsert: {
                  date,
                  supplement_name: vit,
                  timing: 'evening',
                  taken: dayLog.vitamins_evening === true,
                }
              },
              { upsert: true }
            )
          }
          const allPreWorkout = vitamins.pre_workout || []
          for (const vit of allPreWorkout) {
            await suppColl.updateOne(
              { date, supplement_name: vit, timing: 'pre_workout' },
              {
                $setOnInsert: {
                  date,
                  supplement_name: vit,
                  timing: 'pre_workout',
                  taken: dayLog.eaa_taken === true,
                }
              },
              { upsert: true }
            )
          }
          const allPreMeal = vitamins.pre_meal || []
          for (const vit of allPreMeal) {
            await suppColl.updateOne(
              { date, supplement_name: vit, timing: 'pre_meal' },
              {
                $setOnInsert: {
                  date,
                  supplement_name: vit,
                  timing: 'pre_meal',
                  taken: false,
                }
              },
              { upsert: true }
            )
          }
        }
      }
      console.log('Seeded daily log (water + supplements)')
    }

    // Seed goals
    if (data.goals) {
      const goalsColl = db.collection('goals')
      const goals = [
        {
          name: 'Weight Loss',
          type: 'weight',
          target_value: data.goals.weight?.target_kg,
          start_value: data.goals.weight?.start_kg,
          current_value: data.goals.weight?.start_kg,
          unit: 'kg',
          deadline: data.goals.weight?.deadline,
          created_at: new Date(data.goals.weight?.created || today),
        },
        {
          name: 'Daily Calories',
          type: 'calories',
          target_value: data.goals.calories?.daily_limit_kcal,
          start_value: data.goals.calories?.daily_limit_kcal,
          current_value: null,
          unit: 'kcal',
          deadline: data.goals.calories?.deadline,
          created_at: new Date(data.goals.calories?.created || today),
        },
        {
          name: 'Daily Water',
          type: 'water',
          target_value: data.goals.water?.daily_ml,
          start_value: 0,
          current_value: null,
          unit: 'ml',
          deadline: null,
          created_at: new Date(today),
        },
        {
          name: 'Protein Goal',
          type: 'protein',
          target_value: data.goals.macros?.protein_g,
          start_value: 0,
          current_value: null,
          unit: 'g',
          deadline: null,
          created_at: new Date(today),
        },
      ]

      for (const goal of goals) {
        await goalsColl.updateOne(
          { type: goal.type },
          { $setOnInsert: goal },
          { upsert: true }
        )
      }
      console.log('Seeded goals')
    }

    // Seed workouts
    if (data.workouts && data.workouts.length > 0) {
      const workoutsColl = db.collection('workouts')
      for (const w of data.workouts) {
        await workoutsColl.updateOne(
          { date: w.date, name: w.name },
          { $setOnInsert: w },
          { upsert: true }
        )
      }
      console.log(`Seeded ${data.workouts.length} workouts`)
    }

    console.log('Seed complete')
  } catch (err) {
    console.error('Seed error:', err.message)
  }
}

// Mount routes
app.use('/api/metrics', require('./routes/metrics')(getDB))
app.use('/api/nutrition', require('./routes/nutrition')(getDB))
app.use('/api/supplements', require('./routes/supplements')(getDB))
app.use('/api/catalog', require('./routes/supplement_catalog')(getDB))
app.use('/api/labs', require('./routes/labs')(getDB))
app.use('/api/water', require('./routes/water')(getDB))
app.use('/api/workouts', require('./routes/workouts')(getDB))
app.use('/api/weight', require('./routes/weight')(getDB))
app.use('/api/steps', require('./routes/steps')(getDB))
app.use('/api/goals', require('./routes/goals')(getDB))
app.use('/api/foods', require('./routes/foods')(getDB))
app.use('/api/notes', require('./routes/notes')(getDB))
app.use('/api/activity', require('./routes/activity')(getDB))
app.use('/api/whoop', require('./routes/whoop')(getDB))
app.use('/api/settings', require('./routes/settings')(getDB))
app.use('/api/activity-plan', require('./routes/activity_plan')(getDB))
app.use('/api/body_measurements', require('./routes/body_measurements')(getDB))
app.use('/api/meal-templates', require('./routes/meal_templates')(getDB))
app.use('/api/nutrition/recognize', require('./routes/nutrition_recognize')(getDB))
app.use('/api/habits', require('./routes/habits')(getDB))
app.use('/api/profile', require('./routes/personal_profile')(getDB))
app.use('/api/recommendations', require('./routes/recommendations')(getDB))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }))

// Version info (SPEC-001, REQ-1, REQ-2)
app.get('/api/version', (req, res) => res.json({
  version: pkg.version,
  name: pkg.name,
  uptime: Math.floor(process.uptime())
}))

// #872 Finding #1: express's default 413 response for an over-limit body is HTML
// ("PayloadTooLargeError: request entity too large<br> &nbsp; &nbsp;at ..."), not JSON — so
// `await res.json()` in the frontend threw "Unexpected token" instead of showing the real
// reason. body-parser errors (thrown by express.json() before any route handler runs) land here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload too large',
      hint: `File exceeds the ${JSON_BODY_LIMIT} request limit`,
    })
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }
  console.error('[server] unhandled error:', err?.message || err)
  res.status(500).json({ error: 'Internal server error' })
})

// Start (skip when required as a module, e.g. by tests via supertest — see
// src/tests/server_body_limit.test.ts)
if (require.main === module) {
  connectDB()
    .then(async () => {
      await seedData()
      app.listen(PORT, () => {
        console.log(`Health API running on http://localhost:${PORT}`)
      })
    })
    .catch((err) => {
      console.error('Failed to connect to MongoDB:', err)
      process.exit(1)
    })
}

module.exports = app
