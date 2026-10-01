/**
 * ajv-backed validator for the SINGLE life_* contract schema
 * (`contracts/life-contracts.schema.json`, repo root) — task #1530.
 *
 * Root cause this closes: #1520/#1524 drift between health-api's real
 * `/api/life/*` response shape and me-dashboard's mock layer was invisible
 * to tests because each side hand-typed its OWN expected shape. This file
 * (and its me-dashboard twin, `me-dashboard/src/tests/utils/validateLifeContract.js`)
 * both compile the SAME JSON file — a drift on either side now fails a test
 * instead of silently shipping.
 *
 * Reads the schema from disk (fs + JSON.parse) rather than a static
 * `import`/`require('../../../contracts/...json')` — the schema lives
 * OUTSIDE this project's `tsconfig.json` `rootDir`/`include` ("./src"), so a
 * static TS import would pull it into the compiled program's rootDir
 * calculation; reading it as a plain file at runtime sidesteps that
 * entirely and needs no tsconfig change.
 */

import * as fs from 'fs'
import * as path from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ajv = require('ajv')

const SCHEMA_PATH = path.join(__dirname, '../../../../contracts/life-contracts.schema.json')
const SCHEMA_KEY = 'life-contracts'

let schema: any
try {
  schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
} catch (err: any) {
  throw new Error(`validateLifeContract: cannot read ${SCHEMA_PATH}: ${err.message}`)
}

const ajv = new Ajv({ allErrors: true, strict: false })
ajv.addSchema(schema, SCHEMA_KEY)

const compiled: Record<string, any> = {}

function getValidator(defName: string) {
  if (!compiled[defName]) {
    const v = ajv.getSchema(`${SCHEMA_KEY}#/definitions/${defName}`)
    if (!v) throw new Error(`validateLifeContract: unknown contract definition "${defName}"`)
    compiled[defName] = v
  }
  return compiled[defName]
}

/**
 * Throws with the ajv error list + the offending payload if `data` does not
 * match `contracts/life-contracts.schema.json#/definitions/<defName>`.
 * Use directly in a route test: `assertMatchesContract('TodayResponse', res.body)`.
 */
export function assertMatchesContract(defName: string, data: unknown): void {
  const validate = getValidator(defName)
  const valid = validate(data)
  if (!valid) {
    throw new Error(
      `Contract violation — ${SCHEMA_KEY}#/definitions/${defName}:\n` +
        ajv.errorsText(validate.errors, { separator: '\n' }) +
        `\nActual data:\n${JSON.stringify(data, null, 2)}`
    )
  }
}
