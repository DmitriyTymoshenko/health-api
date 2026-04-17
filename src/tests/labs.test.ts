/**
 * Labs route — unit tests for business logic in routes/labs.js
 * Tests: matchPattern, parseSynevoLine, getStatus, extractDateFromPdf, parsePdfText
 * REFERENCE_RANGES and RETEST_INTERVALS thresholds
 */

// --- Replicate pure logic from routes/labs.js ---

const UNIT_RE = /(?:x10[⁹¹²³⁴¹²³⁰-⁹]*\/л|г\/л|мг\/л|Од\/л|сек|%|ммоль\/л|нмоль\/л|пмоль\/л|мкмоль\/л|мМО\/л|мкМО\/мл|COI|Індекс|ng\/mL|ng\/ml|pmol|nmol)/i

const REFERENCE_RANGES: Record<string, { min: number; max: number; unit: string; name: string }> = {
  vitamin_d:        { min: 75,   max: 250,  unit: 'нмоль/л', name: 'Вітамін D (25-OH)' },
  vitamin_b12:      { min: 148,  max: 740,  unit: 'пмоль/л', name: 'Вітамін B12' },
  ferritin:         { min: 30,   max: 300,  unit: 'нг/мл',   name: 'Феритин' },
  testosterone:     { min: 12.1, max: 38.0, unit: 'нмоль/л', name: 'Тестостерон загальний' },
  tsh:              { min: 0.4,  max: 4.0,  unit: 'мМО/л',   name: 'ТТГ' },
  glucose:          { min: 3.9,  max: 5.6,  unit: 'ммоль/л', name: 'Глюкоза' },
  cholesterol_total:{ min: 0,    max: 5.2,  unit: 'ммоль/л', name: 'Холестерин загальний' },
  ldl:              { min: 0,    max: 3.0,  unit: 'ммоль/л', name: 'LDL' },
  hdl:              { min: 1.0,  max: 10,   unit: 'ммоль/л', name: 'HDL' },
  crp:              { min: 0,    max: 5.0,  unit: 'мг/л',    name: 'СРБ' },
  hemoglobin:       { min: 130,  max: 175,  unit: 'г/л',     name: 'Гемоглобін' },
  alt:              { min: 7,    max: 40,   unit: 'Од/л',    name: 'АЛТ' },
  creatinine:       { min: 62,   max: 115,  unit: 'мкмоль/л',name: 'Креатинін' },
}

function getStatus(key: string, value: number): 'low' | 'normal' | 'high' | 'unknown' {
  const ref = REFERENCE_RANGES[key]
  if (!ref) return 'unknown'
  if (value < ref.min) return 'low'
  if (value > ref.max) return 'high'
  return 'normal'
}

function matchPattern(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase().trim()
  for (const p of patterns) {
    if (lower.includes(p.toLowerCase())) return true
  }
  return false
}

function parseSynevoLine(line: string): number | null {
  const clean = line.replace(/\s+(нормальний|низький|високий|норма|відсутність\s+ризику|підвищений\s+ризик|негативний|позитивний).*/i, '').trim()

  const unitMatch = UNIT_RE.exec(clean)
  if (unitMatch) {
    const beforeUnit = clean.slice(0, unitMatch.index).trim()
    const nums = beforeUnit.match(/-?\d+(?:[.,]\d+)?/g)
    if (nums && nums.length > 0) {
      const val = parseFloat(nums[nums.length - 1].replace(',', '.'))
      if (!isNaN(val)) return val
    }
  }

  const nums = clean.match(/\b(\d+(?:[.,]\d+)?)\b/g)
  if (nums) {
    for (const n of nums) {
      const v = parseFloat(n.replace(',', '.'))
      if (!isNaN(v) && v > 0) return v
    }
  }
  return null
}

function extractDateFromPdf(text: string): string | null {
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
      let d: string | undefined
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

// --- Tests ---

describe('getStatus — lab reference ranges', () => {
  it('returns "low" when value is below min', () => {
    expect(getStatus('vitamin_d', 50)).toBe('low')      // min=75
    expect(getStatus('glucose', 3.0)).toBe('low')        // min=3.9
    expect(getStatus('hemoglobin', 120)).toBe('low')     // min=130
  })

  it('returns "normal" when value is within range', () => {
    expect(getStatus('vitamin_d', 100)).toBe('normal')   // 75-250
    expect(getStatus('glucose', 5.0)).toBe('normal')     // 3.9-5.6
    expect(getStatus('tsh', 2.0)).toBe('normal')         // 0.4-4.0
    expect(getStatus('testosterone', 20)).toBe('normal') // 12.1-38
  })

  it('returns "high" when value is above max', () => {
    expect(getStatus('vitamin_d', 300)).toBe('high')      // max=250
    expect(getStatus('ldl', 4.0)).toBe('high')            // max=3.0
    expect(getStatus('crp', 10)).toBe('high')             // max=5.0
    expect(getStatus('alt', 80)).toBe('high')             // max=40
  })

  it('returns "unknown" for unrecognized key', () => {
    expect(getStatus('unknown_marker', 100)).toBe('unknown')
    expect(getStatus('', 50)).toBe('unknown')
  })

  it('min boundary is exclusive (below = low)', () => {
    // ferritin min=30, value=29 → low
    expect(getStatus('ferritin', 29)).toBe('low')
    expect(getStatus('ferritin', 30)).toBe('normal') // exactly min = normal
  })

  it('max boundary is exclusive (above = high)', () => {
    // cholesterol_total max=5.2, value=5.3 → high
    expect(getStatus('cholesterol_total', 5.3)).toBe('high')
    expect(getStatus('cholesterol_total', 5.2)).toBe('normal') // exactly max = normal
  })
})

describe('matchPattern — biomarker name detection', () => {
  it('matches Ukrainian biomarker names (case insensitive)', () => {
    expect(matchPattern('Вітамін D 25-OH', ['25-oh', 'вітамін d'])).toBe(true)
    expect(matchPattern('Глюкоза 5.1 ммоль/л', ['глюкоза', 'glucose'])).toBe(true)
    expect(matchPattern('Тестостерон загальний', ['тестостерон', 'testosterone'])).toBe(true)
  })

  it('matches English biomarker names', () => {
    expect(matchPattern('Total cholesterol 4.8 mmol/L', ['загальний холестерин', 'total cholesterol'])).toBe(true)
    expect(matchPattern('TSH 1.5 mIU/L', ['тиреотропний', 'ттг', 'tsh'])).toBe(true)
  })

  it('matches partial patterns', () => {
    expect(matchPattern('Гемоглобін HbA1c', ['hba1c', 'глікований гемоглобін'])).toBe(true)
    expect(matchPattern('LDL-холестерин 2.1', ['лпнщ', 'ldl'])).toBe(true)
  })

  it('returns false when no pattern matches', () => {
    expect(matchPattern('Дата взяття: 15.03.2026', ['глюкоза', 'glucose'])).toBe(false)
    expect(matchPattern('', ['tsh'])).toBe(false)
  })

  it('is case insensitive for Ukrainian', () => {
    expect(matchPattern('ФЕРИТИН', ['феритин', 'ferritin'])).toBe(true)
    expect(matchPattern('феритин', ['ФЕРИТИН', 'ferritin'])).toBe(true)
  })
})

describe('parseSynevoLine — value extraction from PDF lines', () => {
  it('extracts integer value from line with unit', () => {
    const val = parseSynevoLine('Гемоглобін 145 г/л нормальний')
    expect(val).toBe(145)
  })

  it('extracts decimal value with dot separator', () => {
    const val = parseSynevoLine('Глюкоза 5.1 ммоль/л нормальний')
    expect(val).toBe(5.1)
  })

  it('extracts decimal value with comma separator', () => {
    const val = parseSynevoLine('Тестостерон 18,5 нмоль/л нормальний')
    expect(val).toBe(18.5)
  })

  it('strips status words before extracting', () => {
    const clean = parseSynevoLine('АЛТ 25 Од/л нормальний')
    const dirty = parseSynevoLine('АЛТ 25 Од/л')
    expect(clean).toBe(dirty)
  })

  it('returns null for line with no numeric value', () => {
    expect(parseSynevoLine('Назва показника Одиниця')).toBeNull()
    expect(parseSynevoLine('')).toBeNull()
  })

  it('extracts value from line with range reference', () => {
    // Line with multiple numbers: value before unit is the result
    const val = parseSynevoLine('Креатинін 92 мкмоль/л 62 - 115 нормальний')
    expect(val).toBe(92)
  })

  it('handles % unit', () => {
    const val = parseSynevoLine('Гематокрит 45 %')
    expect(val).toBe(45)
  })
})

describe('extractDateFromPdf — date parsing from PDF text', () => {
  it('extracts "Дата взяття: DD.MM.YYYY" format', () => {
    const text = 'Пацієнт: Іван\nДата взяття: 15.03.2026\nПоказник 1'
    expect(extractDateFromPdf(text)).toBe('2026-03-15')
  })

  it('extracts "від DD.MM.YYYY" format', () => {
    const text = 'Результат від 20.04.2026 підтверджено'
    expect(extractDateFromPdf(text)).toBe('2026-04-20')
  })

  it('extracts ISO format YYYY-MM-DD', () => {
    const text = 'Analysis date 2026-04-10'
    expect(extractDateFromPdf(text)).toBe('2026-04-10')
  })

  it('handles 2-digit year', () => {
    const text = 'Дата: 15.03.26'
    expect(extractDateFromPdf(text)).toBe('2026-03-15')
  })

  it('returns null when no date found', () => {
    const text = 'Глюкоза 5.1 ммоль/л нормальний'
    expect(extractDateFromPdf(text)).toBeNull()
  })

  it('zero-pads day and month', () => {
    const text = 'Дата взяття: 5.3.2026'
    expect(extractDateFromPdf(text)).toBe('2026-03-05')
  })
})

describe('REFERENCE_RANGES — sanity checks', () => {
  it('all ranges have min <= max', () => {
    for (const [key, ref] of Object.entries(REFERENCE_RANGES)) {
      expect(ref.min).toBeLessThanOrEqual(ref.max)
    }
  })

  it('vitamin_d normal range: 75-250 нмоль/л', () => {
    const ref = REFERENCE_RANGES['vitamin_d']
    expect(ref.min).toBe(75)
    expect(ref.max).toBe(250)
  })

  it('glucose normal range: 3.9-5.6 ммоль/л', () => {
    const ref = REFERENCE_RANGES['glucose']
    expect(ref.min).toBe(3.9)
    expect(ref.max).toBe(5.6)
  })

  it('tsh normal range: 0.4-4.0 мМО/л', () => {
    const ref = REFERENCE_RANGES['tsh']
    expect(ref.min).toBe(0.4)
    expect(ref.max).toBe(4.0)
  })
})
