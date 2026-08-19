/**
 * Structural guard for #1088 (health-api tsc gate, umbrella #1087/guards-blind).
 *
 * Root cause of #954/#1088: a .ts file with no top-level import/export is a
 * "global script" to tsc — its top-level declarations leak into the shared
 * global scope, so an identical const/function name in two such files
 * collides with TS2451/TS2393 (measured: resolveWeightKg, LIVE_PROFILE,
 * stableDayKcalBasis all duplicated this way before #954's fix).
 *
 * IMPORTANT (measured live 2026-08-19, TypeScript 6.0.2): tsconfig's
 * `"isolatedModules": true` does NOT make `tsc --noEmit` (or ts-jest's
 * default Program-based type-checking) reject a fresh global-script file by
 * itself — a probe file with zero top-level import/export and a UNIQUE
 * identifier compiled and ran cleanly (`tsc --noEmit` exit 0, `npm test`
 * 31/31 suites green) even with isolatedModules enabled. That diagnostic
 * (historically TS1208, "cannot be compiled under isolatedModules because
 * it is considered a global script file") is only emitted by per-file
 * transpilers (`ts.transpileModule` — e.g. Babel, or ts-jest's own
 * `isolatedModules` transform option), not by tsc's full-Program checker.
 * So isolatedModules alone does not provide the "catch it the moment it's
 * added" guard this ticket asked for — this test does.
 *
 * This test scans every sibling `*.test.ts` file and fails, naming the
 * offenders, if any lacks a top-level `import`/`export` statement. It runs
 * on every `npm test` (already mandatory before every qa_review per
 * dev-protocol.md SELF-CHECK), so a new latent file is caught immediately,
 * not months later when a duplicate identifier happens to collide.
 */
import * as fs from 'fs'
import * as path from 'path'

const TESTS_DIR = __dirname
const SELF = path.basename(__filename)

function isModuleFile(filePath: string): boolean {
  const src = fs.readFileSync(filePath, 'utf8')
  return /^(import|export)\b/m.test(src)
}

describe('structural guard — every src/tests/*.test.ts must be a module', () => {
  const testFiles = fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.ts'))

  it('found the expected test files to scan (guard is not silently scanning zero files)', () => {
    expect(testFiles.length).toBeGreaterThan(0)
  })

  it('every *.test.ts has a top-level import or export (no global-script files)', () => {
    const offenders = testFiles.filter((f) => {
      if (f === SELF) return false
      return !isModuleFile(path.join(TESTS_DIR, f))
    })

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} test file(s) have no top-level import/export, so tsc ` +
          `treats them as global scripts (collision risk, class #954/#1088). ` +
          `Add 'export {};' to the end of: ${offenders.join(', ')}`
      )
    }

    expect(offenders).toEqual([])
  })
})

export {};
