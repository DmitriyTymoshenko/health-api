# Health API

REST API for health dashboard. Express + MongoDB. Handles nutrition, supplements, lab results, WHOOP metrics, workouts, weight, water, steps.

## Related Repositories

| Repository | Description |
|---|---|
| **health-api** | Express + MongoDB REST API — this repo |
| **health-dashboard** | React + Vite SPA frontend |

## Git Workflow

### Branching Rules

- **NEVER push directly to `main`**
- Every change must be in a **separate branch**: `feat/<name>`, `fix/<name>`, `chore/<name>`
- Before merging into `main`: **all tests must pass** (`npm test`)

### Working on Tasks

1. `git checkout -b feat/my-feature`
2. Make changes
3. `npm test` — must be green
4. `git add -A && git commit -m "feat: ..."`
5. `git checkout main && git merge feat/my-feature`
6. `npm run deploy` — tests + push
7. `git branch -d feat/my-feature`

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Description |
|---|---|
| `feat` | New endpoint or feature |
| `fix` | Bug fix |
| `refactor` | Code restructure |
| `test` | New/updated tests |
| `chore` | Maintenance |

## Tech Stack

- **Runtime:** Node.js 22, CommonJS (`"type": "module"` is NOT set — use `require()`)
- **Framework:** Express 4
- **Database:** MongoDB 6 (Mongoose-free, raw driver)
- **TypeScript:** In `src/` only (types + middleware + tests)
- **Testing:** Jest + ts-jest
- **PDF parsing:** pdf-parse
- **File upload:** multer

## Commands

```bash
node server.js          # Start API (port 3001)
npm test                # Run Jest tests (29 tests)
npm run test:watch      # Watch mode
npm run deploy          # npm test + git push + restart
```

## Project Structure

```
server.js               # Entry point — MongoDB connect + route mounting
routes/                 # 16 JS route files (legacy, fully working)
  nutrition.js          # Food log CRUD
  weight.js             # Weight log
  water.js              # Water intake
  steps.js              # Steps
  supplements.js        # Legacy supplement log
  supplement_catalog.js # Catalog + cycles + intake + knowledge
  labs.js               # Lab results + PDF upload
  metrics.js            # WHOOP daily metrics
  workouts.js           # Workouts
  goals.js              # Goals
  foods.js              # Food search database
  settings.js           # User settings
  whoop.js              # WHOOP sync
  activity.js           # Activity plans
  notes.js              # Notes
  activity_plan.js      # Activity plan CRUD
src/
  types/index.ts        # TypeScript interfaces for all DB documents
  middleware/validate.ts # normalizeNutrition, requireFields, validateDate, normalizeSupplementId
  tests/
    validate.test.ts    # 17 tests — middleware
    nutrition.test.ts   # 6 tests — nutrition normalization
    supplement_catalog.test.ts # 6 tests — supplement logic + cycle calculations
```

## MongoDB Collections

| Collection | Description |
|---|---|
| `nutrition_log` | Food entries |
| `weight_log` | Weight measurements |
| `water_log` | Water intake |
| `steps` | Daily steps |
| `supplements_log` | Legacy supplement log |
| `supplement_catalog` | Supplement catalog |
| `supplement_cycles` | Intake cycles (8wk on / 4wk off) |
| `supplement_intake` | Daily intake tracking |
| `supplement_knowledge` | Full composition of each supplement |
| `lab_results` | Lab test results |
| `daily_metrics` | WHOOP recovery/HRV/sleep/strain |
| `workouts` | Workout sessions |
| `goals` | Health goals |
| `user_settings` | User profile and settings |

## Critical Rules

### supplement_id is always a Number

```js
// ✅ Correct
{ supplement_id: 3, date: '2026-03-31' }

// ❌ Wrong — will break intake lookup
{ supplement_id: '3', date: '2026-03-31' }
```

Use `normalizeSupplementId` middleware on all intake endpoints.

### Nutrition fields — support both formats

The API accepts both `protein` AND `protein_g`. Always apply `normalizeNutrition` middleware on POST /api/nutrition. It converts:
- `protein` → `protein_g`
- `fat` → `fat_g`
- `carbs` → `carbs_g`
- `name` → `food_name`
- missing `date` → today

### Adding new routes

1. Create `routes/my-route.js` (CommonJS, `module.exports = function(getDB) { ... }`)
2. Mount in `server.js`: `app.use('/api/my-route', require('./routes/my-route')(getDB))`
3. Write test in `src/tests/my-route.test.ts`
4. Run `npm test` to verify

### Restarting after route changes

```bash
fuser -k 3001/tcp 2>/dev/null && sleep 1 && cd /tmp/health-api && node server.js &
```

## TypeScript

TypeScript is only in `src/` — for types, middleware, and tests. The route files (`routes/*.js`) stay as CommonJS and are **not** migrated.

When adding new middleware:
1. Write in `src/middleware/myMiddleware.ts`
2. Add tests in `src/tests/myMiddleware.test.ts`
3. Import in route files with `const { myMiddleware } = require('../src/middleware/myMiddleware')`

## Testing

```bash
npm test
```

Tests must be **green before any merge to main**. If you change middleware or business logic, update the relevant test file.

Adding new tests:
- Place in `src/tests/*.test.ts`
- Use Jest + ts-jest (no supertest needed for middleware unit tests — mock req/res manually)

## Deployment

```bash
npm run deploy
# Runs: npm test → git add/commit/push → systemctl restart via health-deploy.sh
```

Systemd service: `health-api` (port 3001)

## Session Memory

At the start of every session, check `MEMORY.md` in the workspace. It contains current project state and recent decisions.

**After completing work:** update `MEMORY.md` and commit with `chore: update memory`.
