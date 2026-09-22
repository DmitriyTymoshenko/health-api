const https = require('https')
// #873 Частина 4: reuse the shared macroContribution (BASE RULE) — the previous
// flat `e.kcal || 0` sum silently undercounted legacy nested items[] records
// (#862 class), same defect as goals.js/nutrition.js/recommendations.js.
const { macroContribution } = require('./lib/nutrition-aggregate')

const BOT_TOKEN = process.env.TELEGRAM_BOT_LISA || ''
const CHAT_ID = process.env.OWNER_TELEGRAM_ID || ''
const DEFAULT_CALORIE_LIMIT = 2200
const DEFICIT_GOAL = 500
const WARN_THRESHOLD = 0.80

// #1487 (stage B of #1485, design D8): resolves `true`/`false` per the HTTP
// status of the Telegram API response, so a caller that needs to know
// "did the message actually go out" (lib/cycle-notify.js — a flag must only
// be written AFTER a confirmed send, or a failed send silently looks
// delivered forever) can gate on it. `checkAndNotify`/`checkWaterAndNotify`
// below already call this fire-and-forget and never inspected the resolved
// value — this change is additive to the resolved value only, no call-site
// here changes, and `water-notify.test.ts` never touches `sendTelegram`
// directly (grepped before changing this — only pure functions from this
// file are imported there: calcWaterGoal/strainLabel/expectedPctByHour).
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      console.warn('[notify] TELEGRAM_BOT_LISA/OWNER_TELEGRAM_ID missing — alert skipped')
      return resolve(false)
    }
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let ok = res.statusCode >= 200 && res.statusCode < 300
      res.on('data', () => {})
      res.on('end', () => resolve(ok))
    })
    req.on('error', () => resolve(false))
    req.write(body)
    req.end()
  })
}

async function checkAndNotify(db, date, newItemName, newItemKcal) {
  try {
    const items = await db.collection('nutrition_log').find({ date }).toArray()
    const total = items.reduce((s, e) => s + macroContribution(e).kcal, 0)

    // Get today's WHOOP calories burned
    const cycle = await db.collection('whoop_cycles').findOne({ date })
    const burned = cycle?.calories_burned || DEFAULT_CALORIE_LIMIT
    const dynamicLimit = Math.max(burned - DEFICIT_GOAL, DEFAULT_CALORIE_LIMIT)

    const pct = Math.round((total / dynamicLimit) * 100)
    const left = dynamicLimit - total
    const limitSource = cycle?.calories_burned ? `WHOOP (${burned} ккал − ${DEFICIT_GOAL})` : 'стандартний'

    if (total > dynamicLimit) {
      await sendTelegram(
        `🔴 <b>Ліміт калорій перевищено!</b>\n` +
        `З'їдено: <b>${total} ккал</b> з ${dynamicLimit} ккал (${limitSource})\n` +
        `Перевищення: +${Math.abs(left)} ккал\n` +
        `📝 ${newItemName} (${newItemKcal} ккал)`
      )
    } else if (pct >= WARN_THRESHOLD * 100) {
      await sendTelegram(
        `⚠️ <b>Увага! ${pct}% бюджету</b>\n` +
        `З'їдено: <b>${total} ккал</b> з ${dynamicLimit} ккал (${limitSource})\n` +
        `Залишилось: <b>${left} ккал</b>\n` +
        `📝 ${newItemName} (${newItemKcal} ккал)`
      )
    }
  } catch (e) {
    // Silent fail
  }
}

// Dynamic water goal: weight * 33ml * strain coefficient
// #1298 R4 (owner decision 18.09 ~11:55): flat "1 L per 30 kg body weight",
// no strain multiplier. Today.jsx now shows this exact number (rounded to
// 0.1 L) as a pure info line with the literal "1 л на 30 кг" caption, so the
// API and the UI must resolve the SAME value — the old strain coefficient
// made this formula diverge from that flat statement. `strain` stays a
// parameter for call-site compatibility (checkWaterAndNotify below,
// lib/targets-resolver.js's resolveWaterGoalMl) but no longer affects the goal.
function calcWaterGoal(weightKg, strain) {
  if (!weightKg) return 2500
  return Math.round(weightKg * 1000 / 30)
}

// Human-readable strain level label
function strainLabel(strain) {
  if (strain >= 18) return '🔴 екстремальний'
  if (strain >= 14) return '🟠 високий'
  if (strain >= 10) return '🟡 середній'
  if (strain >= 5) return '🟢 легкий'
  return '⚪ мінімальний'
}

// Expected % of water goal by hour of day (Kyiv timezone)
function expectedPctByHour(hour) {
  if (hour < 9) return 0
  if (hour < 12) return 30
  if (hour < 15) return 50
  if (hour < 18) return 70
  if (hour < 21) return 90
  return 100
}

// Get current hour in Kyiv timezone
function kyivHour() {
  const now = new Date()
  const kyiv = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }))
  return kyiv.getHours()
}

// Get full WHOOP context for water notification
async function getWhoopWaterContext(db, date) {
  const [cycle, recovery, weightLog] = await Promise.all([
    db.collection('whoop_cycles').findOne({ date }),
    db.collection('whoop_recovery').findOne({ date }),
    db.collection('weight_log').find().sort({ date: -1 }).limit(1).toArray()
  ])

  const weight = weightLog[0]?.weight_kg || null
  const strain = cycle?.strain || 0
  const recoveryScore = recovery?.recovery_score ?? null

  return { weight, strain, recoveryScore }
}

async function checkWaterAndNotify(db, date) {
  try {
    const waterLog = await db.collection('water_log').find({ date }).toArray()
    const totalMl = waterLog.reduce((s, e) => s + (e.amount_ml || 0), 0)

    const { weight, strain, recoveryScore } = await getWhoopWaterContext(db, date)
    const goalMl = calcWaterGoal(weight, strain)
    const pct = Math.round((totalMl / goalMl) * 100)
    const left = goalMl - totalMl

    const hour = kyivHour()
    const expectedPct = expectedPctByHour(hour)

    // Build WHOOP context line
    const whoopParts = []
    if (strain > 0) whoopParts.push(`Strain: ${strain.toFixed(1)} ${strainLabel(strain)}`)
    if (recoveryScore !== null) whoopParts.push(`Recovery: ${recoveryScore}%`)
    const whoopLine = whoopParts.length
      ? `\n📊 ${whoopParts.join(' · ')}`
      : ''

    // #1298 R4: calcWaterGoal no longer has a strain multiplier (flat 1L/30kg),
    // so a "ціль підвищена через strain" explanation can never fire anymore —
    // baseGoal computed via the SAME function (strain arg ignored) instead of a
    // second hardcoded copy of the old formula, so this is provably always ''.
    const baseGoal = calcWaterGoal(weight, 0)
    const goalExplain = goalMl > baseGoal
      ? `\n📈 Ціль підвищена: ${baseGoal}→${goalMl}мл (strain ${strain.toFixed(1)})`
      : ''

    // Milestone notifications: celebrate progress
    if (pct >= 100 && totalMl > 0) {
      await sendTelegram(
        `✅ <b>Ціль води досягнута!</b>\n` +
        `Випито: <b>${totalMl}мл</b> з ${goalMl}мл (${pct}%)${whoopLine}`
      )
      return
    }

    // Behind schedule: actual % significantly below expected %
    const behindThreshold = 15 // notify if behind by 15%+
    if (expectedPct > 0 && pct < expectedPct - behindThreshold) {
      const behindMl = Math.round(goalMl * (expectedPct / 100)) - totalMl
      await sendTelegram(
        `💧 <b>Вода: ${totalMl}мл з ${goalMl}мл (${pct}%)</b>\n` +
        `⏰ До ${hour}:00 очікувалось ~${expectedPct}% — відставання <b>${behindMl}мл</b>\n` +
        `Залишилось: <b>${left}мл</b>. Пий більше! 🚰${whoopLine}${goalExplain}`
      )
      return
    }

    // Critical low: less than 25% after 15:00
    if (hour >= 15 && pct < 25) {
      await sendTelegram(
        `🔴 <b>Критично мало води!</b>\n` +
        `Випито: <b>${totalMl}мл</b> з ${goalMl}мл (${pct}%)\n` +
        `Залишилось: <b>${left}мл</b> до кінця дня${whoopLine}${goalExplain}`
      )
      return
    }

    // Standard low: less than 50% total
    if (totalMl < goalMl * 0.5 && hour >= 9) {
      await sendTelegram(
        `💧 <b>Вода: ${totalMl}мл з ${goalMl}мл (${pct}%)</b>\n` +
        `Залишилось: <b>${left}мл</b>. Пий більше! 🚰${whoopLine}${goalExplain}`
      )
    }
  } catch (e) {}
}

module.exports = { checkAndNotify, checkWaterAndNotify, calcWaterGoal, calcWaterGoalWithContext: getWhoopWaterContext, strainLabel, expectedPctByHour, kyivHour, sendTelegram }
