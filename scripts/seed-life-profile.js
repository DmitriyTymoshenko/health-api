#!/usr/bin/env node
'use strict'

/**
 * scripts/seed-life-profile.js — one-off seed for the `life_profile` singleton
 * (task #1519, SPEC #1518 §3/§6/Q3). Hand-transcribed from the vault's
 * canonical Dmytro profile note (EN, JD 51.01), translated to Ukrainian for
 * this record because `life_profile` is USER-FACING content rendered on
 * Dmytro's own `/me` dashboard (CLAUDE.md: UA for user-facing output), not an
 * agent-instruction distillate.
 *
 * Source: `EN/00-09 System & Personal/01 About/dmytro-profile.md` (JD 51.01),
 * sections "Top 5 Strengths (CliftonStrengths)", "Dominant type", "Leadership
 * Style", "Balance Formula" — read live via obsidian_read 2026-10-01, content
 * unchanged since 2026-10-01 (`updated_at` front-matter).
 *
 * Idempotent: filters on the singleton (empty filter `{}`) with upsert, so a
 * re-run updates the same one document instead of duplicating it.
 *
 * Usage:
 *   MONGO_URL=... node scripts/seed-life-profile.js
 */

const { MongoClient } = require('mongodb')

const MONGO_URL = process.env.MONGO_URL
if (!MONGO_URL) {
  console.error('MONGO_URL env var is required (same var health-api.service uses)')
  process.exit(1)
}

const PROFILE_DOC = {
  version: 1,
  source: 'vault:EN/00-09 System & Personal/01 About/dmytro-profile.md#51.01',
  strengths: [
    {
      key: 'learner',
      name: 'Learner',
      description: 'Постійно вчиться, тестує ідеї, кайфує від самого процесу пізнання.',
    },
    {
      key: 'analytical',
      name: 'Analytical',
      description: 'Рішення через логіку й факти, завжди питає «чому» і «як».',
    },
    {
      key: 'relator',
      name: 'Relator',
      description: 'Довіра як основа стосунків; цінує чесність і глибину, не поверхневість.',
    },
    {
      key: 'individualization',
      name: 'Individualization',
      description: 'Бачить унікальне в кожному процесі, людині, продукті.',
    },
    {
      key: 'deliberative',
      name: 'Deliberative',
      description: 'Зважені рішення, прораховує ризики, «повільно, але правильно».',
    },
  ],
  dominant_domain: 'Стратегічне мислення',
  leadership_style: 'Аналітик-стратег, «архітектор систем»',
  balance_formula: {
    label: 'Аналітика + Дія + Довіра = Ріст',
    components: [
      { key: 'analytics', label: 'Аналітика', description: 'дає силу приймати розумні рішення' },
      { key: 'action', label: 'Дія через команду', description: 'не дає зупинитись' },
      { key: 'trust', label: 'Довіра', description: 'створює стабільність і енергію команди' },
    ],
  },
}

async function run() {
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  try {
    const db = client.db('health_tracker')
    const result = await db.collection('life_profile').updateOne(
      {},
      { $set: { ...PROFILE_DOC, updated_at: new Date() } },
      { upsert: true }
    )
    console.log(
      result.upsertedId
        ? `Inserted life_profile singleton _id=${result.upsertedId}`
        : `Updated existing life_profile singleton (matched=${result.matchedCount})`
    )
  } finally {
    await client.close()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
