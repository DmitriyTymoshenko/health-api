#!/usr/bin/env node
/**
 * scripts/seed-foods-aliases-1225.js — one-off alias seeding for the 15 `foods_library`
 * documents that have no `aliases` field at all (task #1225, Finding C).
 *
 * WHY this exists: /api/foods/search already matches on `aliases` (routes/foods.js:255),
 * and 169/184 documents already carry curated synonyms ("banana"/"бананчик",
 * "granola"/"гранола" etc.). The remaining 15 documents were never seeded — that gap,
 * not a missing search algorithm, is why "хлібці" finds nothing for the product whose
 * real name is "Протеїнові кукурудзяні коржики (вафлі) з бобовими"
 * (`_id 6a8d6be5381fe0859ec2c6b5`). No fuzzy/stemming/$text change can bridge that pair —
 * "хлібці" and "коржики"/"вафлі" share zero trigrams (Apex triage, task #1225 comment
 * #6900) — this is pure synonymy, closed only by data, not by a smarter matcher.
 *
 * SAFETY (Level 2 — mass UPDATE of 15 rows, per rules/tasks-protocol.md):
 *   - Defaults to DRY-RUN. Nothing is written unless `--apply` is passed explicitly.
 *   - Idempotent: any target `_id` that ALREADY has an `aliases` field (seeded by someone
 *     else in the meantime, or a re-run after a partial apply) is SKIPPED, never overwritten.
 *   - `--apply` requires this script to have been explicitly approved (owner "затверджено"
 *     via Apex/Dmytro) BEFORE it is ever run for real — see task #1225 constraints.
 *
 * Usage:
 *   node scripts/seed-foods-aliases-1225.js              # dry-run (default)
 *   node scripts/seed-foods-aliases-1225.js --dry-run     # dry-run (explicit, same as default)
 *   node scripts/seed-foods-aliases-1225.js --apply        # actually writes — ONLY after approval
 */
const { MongoClient, ObjectId } = require('mongodb')

const MONGO_URL = process.env.MONGO_URL
if (!MONGO_URL) {
  console.error('MONGO_URL env var is required (same var health-api.service uses)')
  process.exit(1)
}

// Style matches the 169 already-seeded documents: lowercase, short colloquial terms,
// Cyrillic + Latin/transliteration where the product is commonly typed either way.
const SEED_ALIASES = [
  { _id: '69ca331b9f6784c2be371878', name: 'Желе Фанні із сироватки',
    aliases: ['желе фанні', 'фанні желе', 'whey jelly'] },
  { _id: '6a2acfd83666d35ffcb42b48', name: "Голубці (з рисом та м'ясом)",
    aliases: ['голубці', 'голубец', 'cabbage rolls'] },
  { _id: '6a2acfd83666d35ffcb42b49', name: 'Курячий рулет',
    aliases: ['курячий рулет', 'рулет з курки', 'chicken roll'] },
  { _id: '6a2acfd83666d35ffcb42b4a', name: 'Сир твердий (Голландський)',
    aliases: ['голландський сир', 'твердий сир', 'dutch cheese'] },
  { _id: '6a2c145231ec98cb68a68a7b', name: 'Valio Pro Feel Protein Dessert Apple Pie',
    aliases: ['pro feel', 'valio pro feel', 'яблучний пиріг', 'профіл'] },
  { _id: '6a2d07fd31ec98cb68a68a92', name: 'Jugurt Protein+ Mango',
    aliases: ['югурт', 'jugurt', 'манго йогурт', 'протеїновий йогурт манго'] },
  { _id: '6a4fc3f34bb7059c8a62a915', name: 'Протеїнова гранола Protein Go',
    aliases: ['гранола', 'протеїнова гранола', 'protein go granola'] },
  { _id: '6a4fc3f34bb7059c8a62a916', name: 'Кокосове молоко Alpro Coconut Original',
    aliases: ['кокосове молоко', 'coconut milk', 'алпро кокосове'] },
  { _id: '6a8d6bbb381fe0859ec2c6b4', name: 'Philadelphia Original Cream Cheese',
    aliases: ['філадельфія', 'philadelphia', 'вершковий сир', 'cream cheese'] },
  // TARGET of #1225 — MUST carry "хлібці"/"коржики"/"вафлі" per Apex triage acceptance.
  { _id: '6a8d6be5381fe0859ec2c6b5', name: 'Protein corn waffles with legumes',
    aliases: ['хлібці', 'коржики', 'вафлі', 'кукурудзяні коржики', 'corn waffles'] },
  { _id: '6a8d6c3c381fe0859ec2c6b6', name: 'Philadelphia Protein',
    aliases: ['філадельфія протеїн', 'philadelphia protein', 'протеїновий сир'] },
  { _id: '6a8d6cec381fe0859ec2c6b7', name: 'Курячий рулет з сиром',
    aliases: ['курячий рулет з сиром', 'рулет з сиром', 'chicken roll cheese'] },
  { _id: '6a8d705f381fe0859ec2c6be', name: 'Zott Protein Yogurt Coconut',
    aliases: ['zott кокос', 'цот йогурт', 'protein yogurt coconut', 'йогурт кокос'] },
  { _id: '6a8db5f7381fe0859ec2c6c7', name: 'FitWin Crunch Bar Лічі-Полуниця',
    aliases: ['fitwin crunch', 'фітвін кранч', 'crunch bar лічі полуниця'] },
  { _id: '6a8ef4f2381fe0859ec2c6e1', name: 'NOW Foods Psyllium Husk Caps 500mg',
    aliases: ['псиліум', 'psyllium', 'лушпиння подорожника', 'клітковина now'] },
]

async function main() {
  const apply = process.argv.includes('--apply')
  const mode = apply ? 'APPLY (writing to DB)' : 'DRY-RUN (no writes)'

  const client = new MongoClient(MONGO_URL)
  await client.connect()
  const db = client.db('health_tracker')
  const col = db.collection('foods_library')

  let planned = 0
  let applied = 0
  let skipped = 0

  console.log(`seed-foods-aliases-1225: ${mode} — ${SEED_ALIASES.length} target documents\n`)

  for (const item of SEED_ALIASES) {
    const _id = new ObjectId(item._id)
    const existing = await col.findOne({ _id })
    if (!existing) {
      console.log(`  [MISSING] ${item._id} "${item.name}" — no such document in foods_library, skipping`)
      skipped++
      continue
    }
    if (existing.aliases !== undefined) {
      console.log(`  [SKIP]    ${item._id} "${item.name}" — already has aliases (idempotent guard), skipping`)
      skipped++
      continue
    }

    planned++
    if (apply) {
      await col.updateOne({ _id }, { $set: { aliases: item.aliases, aliases_seeded_1225: new Date() } })
      applied++
      console.log(`  [APPLIED] ${item._id} "${item.name}" -> aliases: ${JSON.stringify(item.aliases)}`)
    } else {
      console.log(`  [PLANNED] ${item._id} "${item.name}" -> aliases: ${JSON.stringify(item.aliases)}`)
    }
  }

  console.log(`\nsummary: planned=${planned} applied=${applied} skipped=${skipped} mode=${mode}`)
  if (!apply) {
    console.log('Nothing was written. Re-run with --apply ONLY after explicit "затверджено" approval (task #1225).')
  }

  await client.close()
}

main().catch((err) => {
  console.error('seed-foods-aliases-1225 failed:', err)
  process.exit(1)
})
