const https = require('https')

const BOT_TOKEN = '7825994645:AAEXg7OaMw2FBOQ9loY-V96IFcYoKT2KqRc'
const CHAT_ID = '455440443'
const DEFAULT_CALORIE_LIMIT = 2200
const DEFICIT_GOAL = 500
const WARN_THRESHOLD = 0.80

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve) })
    req.on('error', resolve)
    req.write(body)
    req.end()
  })
}

async function checkAndNotify(db, date, newItemName, newItemKcal) {
  try {
    const items = await db.collection('nutrition_log').find({ date }).toArray()
    const total = items.reduce((s, e) => s + (e.kcal || 0), 0)

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
function calcWaterGoal(weightKg, strain) {
  if (!weightKg) return 2500
  let coef = 1.0
  if (strain >= 14) coef = 1.4
  else if (strain >= 10) coef = 1.2
  else if (strain >= 5) coef = 1.1
  return Math.round((weightKg * 33 * coef) / 50) * 50
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

    // Goal explanation
    const baseGoal = weight ? Math.round(weight * 33 / 50) * 50 : 2500
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

module.exports = { checkAndNotify, checkWaterAndNotify, calcWaterGoal, calcWaterGoalWithContext: getWhoopWaterContext, strainLabel, expectedPctByHour, kyivHour }
