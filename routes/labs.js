const { Router } = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const upload = multer({
  dest: '/tmp/health-api/uploads/',
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true)
    } else {
      cb(new Error('Only PDF files allowed'))
    }
  }
})

// Reference ranges for common biomarkers
const REFERENCE_RANGES = {
  // Вітаміни
  'vitamin_d':        { min: 75, max: 250, unit: 'нмоль/л', name: 'Вітамін D (25-OH)', range: '75–250 нмоль/л', low: 'Дефіцит — збільш дозу D3', high: 'Надлишок — зроби паузу' },
  'vitamin_b12':      { min: 148, max: 740, unit: 'пмоль/л', name: 'Вітамін B12', range: '148–740 пмоль/л', low: 'Дефіцит B12 — прийом метилкобаламіну', high: 'Норма (надлишок не токсичний)' },
  'ferritin':         { min: 30, max: 300, unit: 'нг/мл', name: 'Феритин', range: '30–300 нг/мл', low: 'Дефіцит заліза', high: 'Можливий гемохроматоз' },
  'iron':             { min: 10.6, max: 28.3, unit: 'мкмоль/л', name: 'Залізо сироватки', range: '10.6–28.3 мкмоль/л', low: 'Анемія', high: 'Перевантаження залізом' },
  // Гормони
  'testosterone':     { min: 12.1, max: 38.0, unit: 'нмоль/л', name: 'Тестостерон загальний', range: '12.1–38.0 нмоль/л', low: 'Низький — цинк, D3, сон, менше стресу', high: '' },
  'cortisol_morning': { min: 138, max: 690, unit: 'нмоль/л', name: 'Кортизол (ранковий)', range: '138–690 нмоль/л', low: 'Втома наднирників', high: 'Хронічний стрес' },
  'tsh':              { min: 0.4, max: 4.0, unit: 'мМО/л', name: 'ТТГ (щитовидна залоза)', range: '0.4–4.0 мМО/л', low: 'Гіпертиреоз', high: 'Гіпотиреоз' },
  'free_t4':          { min: 10.0, max: 25.0, unit: 'пмоль/л', name: 'Т4 вільний', range: '10.0–25.0 пмоль/л', low: 'Знижена функція щитовидної', high: 'Гіперфункція' },
  // Метаболізм
  'glucose':          { min: 3.9, max: 5.6, unit: 'ммоль/л', name: 'Глюкоза', range: '3.9–5.6 ммоль/л', low: 'Гіпоглікемія', high: 'Ризик цукрового діабету' },
  'hba1c':            { min: 4.0, max: 5.7, unit: '%', name: 'HbA1c (глікований гемоглобін)', range: '4.0–5.7%', low: '', high: 'Ризик діабету — контроль вуглеводів' },
  'insulin':          { min: 2.0, max: 25.0, unit: 'мкМО/мл', name: 'Інсулін', range: '2.0–25.0 мкМО/мл', low: '', high: 'Інсулінорезистентність' },
  // Ліпідний профіль
  'cholesterol_total': { min: 0, max: 5.2, unit: 'ммоль/л', name: 'Холестерин загальний', range: '<5.2 ммоль/л', low: '', high: 'Ризик ССЗ — Omega-3, дієта' },
  'ldl':              { min: 0, max: 3.0, unit: 'ммоль/л', name: 'LDL-холестерин (поганий)', range: '<3.0 ммоль/л', low: '', high: 'Ризик ССЗ — Omega-3, Berberine' },
  'hdl':              { min: 1.0, max: 10, unit: 'ммоль/л', name: 'HDL-холестерин (хороший)', range: '>1.0 ммоль/л', low: 'Низький HDL — Omega-3, активність', high: '' },
  'triglycerides':    { min: 0, max: 1.7, unit: 'ммоль/л', name: 'Тригліцериди', range: '<1.7 ммоль/л', low: '', high: 'Omega-3 знижує тригліцериди' },
  // Запалення
  'crp':              { min: 0, max: 5.0, unit: 'мг/л', name: 'СРБ (C-реактивний білок)', range: '<5.0 мг/л', low: '', high: 'Запалення — Omega-3, Vit C, відпочинок' },
  'homocysteine':     { min: 5, max: 15, unit: 'мкмоль/л', name: 'Гомоцистеїн', range: '5–15 мкмоль/л', low: '', high: 'Ризик серця — B12, B6, фолієва кислота' },
  // Кров (загальний аналіз)
  'hemoglobin':       { min: 130, max: 175, unit: 'г/л', name: 'Гемоглобін', range: '130–175 г/л', low: 'Анемія — залізо, B12', high: 'Згущення крові' },
  'hematocrit':       { min: 40, max: 52, unit: '%', name: 'Гематокрит', range: '40–52%', low: 'Анемія', high: 'Згущення крові' },
  'wbc':              { min: 4, max: 9, unit: 'x10⁹/л', name: 'Лейкоцити (WBC)', range: '4–9 x10⁹/л', low: 'Порушення імунітету', high: 'Запалення або інфекція' },
  'rbc':              { min: 4.0, max: 5.0, unit: 'x10¹²/л', name: 'Еритроцити (RBC)', range: '4.0–5.0 x10¹²/л', low: 'Анемія', high: 'Зневоднення або куріння' },
  'platelets':        { min: 180, max: 360, unit: 'x10⁹/л', name: 'Тромбоцити (PLT)', range: '180–360 x10⁹/л', low: 'Ризик кровотеч', high: 'Ризик тромбозу' },
  // Мінерали
  'magnesium_serum':  { min: 0.75, max: 1.0, unit: 'ммоль/л', name: 'Магній сироватки', range: '0.75–1.0 ммоль/л', low: 'Дефіцит — ZMA або Mg гліцинат', high: '' },
  'zinc_serum':       { min: 11.5, max: 18.5, unit: 'мкмоль/л', name: 'Цинк сироватки', range: '11.5–18.5 мкмоль/л', low: 'Дефіцит цинку — ZMA', high: '' },
  // Печінка / Нирки
  'alt':              { min: 7, max: 40, unit: 'Од/л', name: 'АЛТ (аланінамінотрансфераза)', range: '7–40 Од/л', low: '', high: 'Навантаження на печінку' },
  'ast':              { min: 10, max: 40, unit: 'Од/л', name: 'АСТ (аспартатамінотрансфераза)', range: '10–40 Од/л', low: '', high: 'Навантаження на печінку або серце' },
  'ggt':              { min: 8, max: 61, unit: 'Од/л', name: 'ГГТ (гама-глутамілтрансфераза)', range: '8–61 Од/л', low: '', high: 'Захворювання печінки' },
  'creatinine':       { min: 62, max: 115, unit: 'мкмоль/л', name: 'Креатинін (нирки)', range: '62–115 мкмоль/л', low: 'Зниження м\'язової маси', high: 'Порушення функції нирок' },
  // Коагуляція
  'pt':               { min: 9.8, max: 12.1, unit: 'сек', name: 'Протромбіновий час (ПЧ)', range: '9.8–12.1 сек', low: '', high: 'Порушення згортання крові' },
  'aptt':             { min: 22.7, max: 31.8, unit: 'сек', name: 'АЧТЧ', range: '22.7–31.8 сек', low: '', high: 'Порушення гемостазу' },
  'fibrinogen':       { min: 1.8, max: 3.5, unit: 'г/л', name: 'Фібриноген', range: '1.8–3.5 г/л', low: 'Ризик кровотеч', high: 'Запалення або тромбоз' },
}

// Synevo PDF parser
// Format per line: "Назва Значення Одиниця < ref_spaced > ref_spaced value_spaced нормальний/низький/високий"

const UNIT_RE = /(?:x10[⁹¹²³⁴¹²³⁰-⁹]*\/л|г\/л|мг\/л|Од\/л|сек|%|ммоль\/л|нмоль\/л|пмоль\/л|мкмоль\/л|мМО\/л|мкМО\/мл|COI|Індекс|ng\/mL|ng\/ml|pmol|nmol)/i

const PATTERNS = [
  // Вітаміни
  { key: 'vitamin_d',        patterns: ['25-oh', '25(oh)', 'вітамін d', 'vitamin d'] },
  { key: 'vitamin_b12',      patterns: ['вітамін b12', 'vitamin b12', 'кобаламін', 'cobalamin'] },
  { key: 'ferritin',         patterns: ['феритин', 'ferritin'] },
  { key: 'iron',             patterns: ['залізо сироватки', 'serum iron'] },
  // Гормони
  { key: 'testosterone',     patterns: ['тестостерон', 'testosterone'] },
  { key: 'cortisol_morning', patterns: ['кортизол', 'cortisol'] },
  { key: 'tsh',              patterns: ['тиреотропний', 'ттг', 'tsh'] },
  { key: 'free_t4',          patterns: ['т4 вільний', 'вільний т4', 'free t4', 'ft4'] },
  // Метаболізм
  { key: 'glucose',          patterns: ['глюкоза', 'glucose'] },
  { key: 'hba1c',            patterns: ['глікований гемоглобін', 'hba1c', 'hb a1c'] },
  { key: 'insulin',          patterns: ['інсулін', 'insulin'] },
  // Ліпіди
  { key: 'cholesterol_total',patterns: ['загальний холестерин', 'холестерин загальний', 'total cholesterol'] },
  { key: 'ldl',              patterns: ['лпнщ', 'ліпопротеїни низької', 'ldl'] },
  { key: 'hdl',              patterns: ['лпвщ', 'ліпопротеїни високої', 'hdl'] },
  { key: 'triglycerides',    patterns: ['тригліцерид', 'triglyceride'] },
  // Запалення
  { key: 'crp',              patterns: ['с-реактивний', 'срб', 'c-reactive', 'crp'] },
  { key: 'homocysteine',     patterns: ['гомоцистеїн', 'homocysteine'] },
  // Кров
  { key: 'hemoglobin',       patterns: ['гемоглобін', 'hemoglobin', 'haemoglobin'] },
  { key: 'hematocrit',       patterns: ['гематокрит', 'hematocrit'] },
  { key: 'wbc',              patterns: ['лейкоцити', 'leukocyte', 'wbc'] },
  { key: 'rbc',              patterns: ['еритроцити', 'erythrocyte', 'rbc'] },
  { key: 'platelets',        patterns: ['тромбоцити', 'platelet', 'plt'] },
  // Мінерали
  { key: 'magnesium_serum',  patterns: ['магній сироватки', 'serum magnesium'] },
  { key: 'zinc_serum',       patterns: ['цинк сироватки', 'serum zinc'] },
  // Печінка/Нирки
  { key: 'alt',              patterns: ['аланінамінотрансфераза'] },
  { key: 'ast',              patterns: ['аспартатамінотрансфераза'] },
  { key: 'ggt',              patterns: ['гама-глутаматтрансфераза', 'гама-глутамілтрансфераза', 'ggt'] },
  { key: 'creatinine',       patterns: ['креатинін', 'creatinine'] },
  // Коагуляція
  { key: 'pt',               patterns: ['протромбіновий час', 'prothrombin time'] },
  { key: 'aptt',             patterns: ['ачтч', 'ачтт', 'aptt', 'частковий тромбопластиновий'] },
  { key: 'fibrinogen',       patterns: ['фібриноген', 'fibrinogen'] },
]

function matchPattern(text, patterns) {
  const lower = text.toLowerCase().trim()
  for (const p of patterns) {
    if (lower.includes(p.toLowerCase())) return true
  }
  return false
}

function parseSynevoLine(line) {
  // Remove status words at end: нормальний, низький, високий, etc.
  const clean = line.replace(/\s+(нормальний|низький|високий|норма|відсутність\s+ризику|підвищений\s+ризик|негативний|позитивний).*/i, '').trim()

  // Find unit keyword position
  const unitMatch = UNIT_RE.exec(clean)
  if (unitMatch) {
    // Value is last number BEFORE the unit
    const beforeUnit = clean.slice(0, unitMatch.index).trim()
    const nums = beforeUnit.match(/-?\d+(?:[.,]\d+)?/g)
    if (nums && nums.length > 0) {
      const val = parseFloat(nums[nums.length - 1].replace(',', '.'))
      if (!isNaN(val)) return val
    }
  }

  // Fallback: first reasonable number
  const nums = clean.match(/\b(\d+(?:[.,]\d+)?)\b/g)
  if (nums) {
    for (const n of nums) {
      const v = parseFloat(n.replace(',', '.'))
      if (!isNaN(v) && v > 0) return v
    }
  }
  return null
}

function parsePdfText(text) {
  const results = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { key, patterns } of PATTERNS) {
      if (results[key]) continue
      if (!matchPattern(line, patterns)) continue

      let value = parseSynevoLine(line)
      if (value === null && lines[i+1]) value = parseSynevoLine(lines[i+1])
      if (value === null && lines[i+2]) value = parseSynevoLine(lines[i+2])

      if (value !== null && !isNaN(value) && value > 0) {
        const ref = REFERENCE_RANGES[key]
        // Sanity: must be within 20x the max reference (filter garbage)
        if (!ref || value <= ref.max * 20) {
          results[key] = value
        }
      }
    }
  }
  return results
}

function extractDateFromPdf(text) {
  const patterns = [
    /(?:дата(?:\s+(?:взяття|прийому|аналізу|реєстрації|видачі))?)\s*[:\s]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    /від\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    /\b(\d{4}[./-]\d{2}[./-]\d{2})\b/,
    /\b(\d{1,2}\.\d{1,2}\.\d{4})\b/,
  ]
  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m) {
      const raw = m[1]
      let d
      if (/^\d{4}/.test(raw)) {
        d = raw.replace(/[./]/g, '-').slice(0, 10)
      } else {
        const parts = raw.split(/[./-]/)
        if (parts.length === 3) {
          let [day, month, year] = parts
          if (year.length === 2) year = '20' + year
          d = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
        }
      }
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d
    }
  }
  return null
}

function getStatus(key, value) {
  const ref = REFERENCE_RANGES[key]
  if (!ref) return 'unknown'
  if (value < ref.min) return 'low'
  if (value > ref.max) return 'high'
  return 'normal'
}

module.exports = function (getDB) {
  const router = Router()

  // GET /api/labs — list all lab results
  router.get('/', async (req, res) => {
    try {
      const db = getDB()
      const data = await db.collection('lab_results').find({}).sort({ date: -1 }).toArray()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/labs/latest — most recent result per biomarker
  router.get('/latest', async (req, res) => {
    try {
      const db = getDB()
      const all = await db.collection('lab_results').find({}).sort({ date: -1 }).toArray()
      const latest = {}
      for (const entry of all) {
        for (const [key, val] of Object.entries(entry.values || {})) {
          if (!latest[key]) {
            latest[key] = {
              value: val,
              date: entry.date,
              source: entry.source || 'manual',
              status: getStatus(key, val),
              ref: REFERENCE_RANGES[key] || null,
            }
          }
        }
      }
      res.json(latest)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /api/labs/reference — return reference ranges
  router.get('/reference', async (req, res) => {
    res.json(REFERENCE_RANGES)
  })

  // POST /api/labs — manual entry
  router.post('/', async (req, res) => {
    try {
      const db = getDB()
      const { date, values, notes, source } = req.body
      const d = date || new Date().toISOString().split('T')[0]
      
      // Annotate with status
      const annotated = {}
      for (const [key, val] of Object.entries(values || {})) {
        annotated[key] = val
      }
      
      const doc = { date: d, values: annotated, notes, source: source || 'manual', created_at: new Date() }
      const result = await db.collection('lab_results').insertOne(doc)
      res.status(201).json({ ...doc, _id: result.insertedId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PUT /api/labs/:id — update entry
  router.put('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      const { _id, ...updates } = req.body
      const result = await db.collection('lab_results').findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { ...updates, updated_at: new Date() } },
        { returnDocument: 'after' }
      )
      if (!result) return res.status(404).json({ error: 'Not found' })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // DELETE /api/labs/:id
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDB()
      const { ObjectId } = require('mongodb')
      await db.collection('lab_results').deleteOne({ _id: new ObjectId(req.params.id) })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/labs/upload — upload and parse PDF
  router.post('/upload', upload.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    
    try {
      const pdfParse = require('pdf-parse')
      const buffer = fs.readFileSync(req.file.path)
      const data = await pdfParse(buffer)
      
      // Clean up uploaded file
      fs.unlinkSync(req.file.path)
      
      const extracted = parsePdfText(data.text)
      const pdfDate = extractDateFromPdf(data.text)
      const date = req.body.date || pdfDate || new Date().toISOString().split('T')[0]
      
      if (Object.keys(extracted).length === 0) {
        return res.json({
          parsed: false,
          detected_date: pdfDate,
          message: 'Не вдалось автоматично розпізнати показники. Введіть вручну.',
          raw_text: data.text.slice(0, 2000),
          values: {}
        })
      }
      
      // Save to DB
      const db = getDB()
      const doc = {
        date,
        values: extracted,
        source: 'pdf',
        filename: req.file.originalname,
        created_at: new Date()
      }
      const result = await db.collection('lab_results').insertOne(doc)
      
      res.json({
        parsed: true,
        found: Object.keys(extracted).length,
        detected_date: pdfDate,
        date_source: pdfDate ? 'pdf' : (req.body.date ? 'manual' : 'today'),
        entry: { ...doc, _id: result.insertedId }
      })
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
