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
  // Vitamins
  'vitamin_d':      { min: 75, max: 250, unit: 'nmol/L', name: 'Вітамін D (25-OH)', low: 'Дефіцит D3 — збільш дозу', high: 'Токсичність' },
  'vitamin_b12':    { min: 148, max: 740, unit: 'pmol/L', name: 'Вітамін B12', low: 'Дефіцит B12', high: 'OK (надлишок не токсичний)' },
  'ferritin':       { min: 30, max: 300, unit: 'ng/mL', name: 'Феритин (залізо)', low: 'Дефіцит заліза', high: 'Гемохроматоз?' },
  'iron':           { min: 10.6, max: 28.3, unit: 'μmol/L', name: 'Залізо сироватки', low: 'Анемія', high: '' },
  // Hormones
  'testosterone':   { min: 12.1, max: 38.0, unit: 'nmol/L', name: 'Тестостерон загальний', low: 'Низький тест — цинк, D3, сон', high: '' },
  'cortisol_morning': { min: 138, max: 690, unit: 'nmol/L', name: 'Кортизол (ранковий)', low: 'Втома наднирників', high: 'Хронічний стрес' },
  'tsh':            { min: 0.4, max: 4.0, unit: 'mIU/L', name: 'ТТГ (щитовидна)', low: 'Гіпертиреоз', high: 'Гіпотиреоз' },
  'free_t4':        { min: 10.0, max: 25.0, unit: 'pmol/L', name: 'Т4 вільний', low: '', high: '' },
  // Metabolic
  'glucose':        { min: 3.9, max: 5.6, unit: 'mmol/L', name: 'Глюкоза', low: 'Гіпоглікемія', high: 'Ризик діабету' },
  'hba1c':          { min: 4.0, max: 5.7, unit: '%', name: 'HbA1c (глікований гемоглобін)', low: '', high: 'Ризик діабету' },
  'insulin':        { min: 2.0, max: 25.0, unit: 'mIU/L', name: 'Інсулін', low: '', high: 'Інсулінорезистентність' },
  // Lipids
  'cholesterol_total': { min: 0, max: 5.2, unit: 'mmol/L', name: 'Холестерин загальний', low: '', high: 'Ризик ССЗ' },
  'ldl':            { min: 0, max: 3.0, unit: 'mmol/L', name: 'LDL (поганий)', low: '', high: 'Ризик ССЗ — Omega3!' },
  'hdl':            { min: 1.0, max: 10, unit: 'mmol/L', name: 'HDL (хороший)', low: 'Низький HDL — Omega3!', high: '' },
  'triglycerides':  { min: 0, max: 1.7, unit: 'mmol/L', name: 'Тригліцериди', low: '', high: 'Omega3 допоможе' },
  // Inflammation
  'crp':            { min: 0, max: 5.0, unit: 'mg/L', name: 'CRP (запалення)', low: '', high: 'Запалення — Omega3, Vit C, відпочинок' },
  'homocysteine':   { min: 5, max: 15, unit: 'μmol/L', name: 'Гомоцистеїн', low: '', high: 'Ризик серця — B12, B6, фолат' },
  // Blood count
  'hemoglobin':     { min: 130, max: 175, unit: 'g/L', name: 'Гемоглобін', low: 'Анемія — залізо, B12', high: '' },
  'hematocrit':     { min: 40, max: 52, unit: '%', name: 'Гематокрит', low: 'Анемія', high: '' },
  // Minerals
  'magnesium_serum':{ min: 0.75, max: 1.0, unit: 'mmol/L', name: 'Магній сироватки', low: 'Дефіцит магнію', high: '' },
  'zinc_serum':     { min: 11.5, max: 18.5, unit: 'μmol/L', name: 'Цинк сироватки', low: 'Дефіцит цинку', high: '' },
  // Liver / Kidney
  'alt':            { min: 7, max: 40, unit: 'U/L', name: 'АЛТ (печінка)', low: '', high: 'Навантаження на печінку' },
  'ast':            { min: 10, max: 40, unit: 'U/L', name: 'АСТ (печінка)', low: '', high: 'Навантаження на печінку' },
  'creatinine':     { min: 62, max: 115, unit: 'μmol/L', name: 'Креатинін (нирки)', low: '', high: 'Функція нирок' },
}

// Pattern matchers for PDF text extraction
const PATTERNS = [
  { key: 'vitamin_d',   patterns: ['25-oh', '25(oh)d', 'vitamin d', 'вітамін d', '25-hydroxyvitamin'] },
  { key: 'vitamin_b12', patterns: ['b12', 'cobalamin', 'кобаламін', 'вітамін b12'] },
  { key: 'ferritin',    patterns: ['ferritin', 'феритин'] },
  { key: 'iron',        patterns: [/^iron$/, /^залізо$/, 'serum iron'] },
  { key: 'testosterone',patterns: ['testosterone', 'тестостерон'] },
  { key: 'cortisol_morning', patterns: ['cortisol', 'кортизол'] },
  { key: 'tsh',         patterns: [/^tsh$/, 'тиреотропний', 'ттг'] },
  { key: 'free_t4',     patterns: ['free t4', 'ft4', 'т4 вільний', 'вільний т4'] },
  { key: 'glucose',     patterns: ['glucose', 'глюкоза'] },
  { key: 'hba1c',       patterns: ['hba1c', 'hb a1c', 'glycated', 'глікований'] },
  { key: 'insulin',     patterns: ['insulin', 'інсулін'] },
  { key: 'cholesterol_total', patterns: ['total cholesterol', 'холестерин загальний', 'загальний холестерин'] },
  { key: 'ldl',         patterns: [/ldl/, 'лпнщ', 'ліпопротеїни низької'] },
  { key: 'hdl',         patterns: [/hdl/, 'лпвщ', 'ліпопротеїни високої'] },
  { key: 'triglycerides',patterns: ['triglyceride', 'тригліцерид'] },
  { key: 'crp',         patterns: ['c-reactive', 'срб', 'с-реактивний'] },
  { key: 'homocysteine',patterns: ['homocysteine', 'гомоцистеїн'] },
  { key: 'hemoglobin',  patterns: ['hemoglobin', 'haemoglobin', 'гемоглобін', /^hgb$/, /^hb$/] },
  { key: 'hematocrit',  patterns: ['hematocrit', 'haematocrit', 'гематокрит', /^hct$/] },
  { key: 'magnesium_serum', patterns: ['magnesium', 'магній'] },
  { key: 'zinc_serum',  patterns: ['zinc serum', 'цинк сироватки'] },
  { key: 'alt',         patterns: [/^alt$/, /^алт$/, 'alanine aminotransferase', 'аланінамінотрансфераза'] },
  { key: 'ast',         patterns: [/^ast$/, /^аст$/, 'aspartate aminotransferase', 'аспартатамінотрансфераза'] },
  { key: 'creatinine',  patterns: ['creatinine', 'креатинін'] },
]

function matchPattern(text, patterns) {
  const lower = text.toLowerCase().trim()
  for (const p of patterns) {
    if (p instanceof RegExp) { if (p.test(lower)) return true }
    else if (lower.includes(p.toLowerCase())) return true
  }
  return false
}

function extractValue(line) {
  // Match: "12.5", "< 5.0", "> 100", "5,6"
  const m = line.match(/[<>]?\s*([\d]+[.,]?[\d]*)\s*(nmol|pmol|mmol|ng|μg|μmol|mIU|mU|g\/|U\/|mg|%|IU)?/i)
  if (m) {
    const val = parseFloat(m[1].replace(',', '.'))
    if (!isNaN(val)) return val
  }
  return null
}

function extractDateFromPdf(text) {
  // Try common date formats from Ukrainian/Russian lab reports
  const patterns = [
    // Сінево: "Дата: 25.03.2026" або "Дата взяття: 25.03.2026"
    /(?:дата(?:\s+(?:взяття|прийому|аналізу|реєстрації|видачі))?)\s*[:\s]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    // "від 25.03.2026"
    /від\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    // ISO або загальний формат на початку рядка
    /\b(\d{4}[./-]\d{2}[./-]\d{2})\b/,
    // DD.MM.YYYY
    /\b(\d{1,2}\.\d{1,2}\.\d{4})\b/,
  ]

  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m) {
      const raw = m[1]
      // Normalize to YYYY-MM-DD
      let d
      if (/^\d{4}/.test(raw)) {
        // Already YYYY-... format
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

function parsePdfText(text) {
  const results = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { key, patterns } of PATTERNS) {
      if (matchPattern(line, patterns)) {
        // Try to find value in same line or next 2 lines
        let value = extractValue(line)
        if (!value && lines[i+1]) value = extractValue(lines[i+1])
        if (!value && lines[i+2]) value = extractValue(lines[i+2])
        
        if (value && !results[key]) {
          results[key] = value
        }
      }
    }
  }
  return results
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
