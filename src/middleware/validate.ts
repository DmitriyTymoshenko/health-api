import { Request, Response, NextFunction } from 'express'

// #1297: this file used to hold the ONLY implementation of these middlewares —
// but as a `.ts` file it was NEVER actually loadable at runtime: `health-api.service`
// runs `node server.js` directly (no build step; `dist/` is gitignored, nothing
// requires it), and every route file is plain CommonJS JS. `grep requireFields|
// validateDate|normalizeNutrition routes/` found zero hits — the middleware was
// fully written and unit-tested here, and fully disconnected from the app.
//
// The canonical, runtime-loadable implementation now lives in `lib/validate.js`
// (plain JS, `require`d directly by the route files). This module re-exports it
// so the existing typed tests (`src/tests/supplement_catalog.test.ts` imports
// `normalizeSupplementId` from here) keep passing unchanged — no behaviour
// difference, just a single source of truth instead of two.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const impl = require('../../lib/validate') as {
  requireFields: (...fields: string[]) => (req: Request, res: Response, next: NextFunction) => void
  requireAnyField: (...fields: string[]) => (req: Request, res: Response, next: NextFunction) => void
  validateDate: (req: Request, res: Response, next: NextFunction) => void
  normalizeNutrition: (req: Request, res: Response, next: NextFunction) => void
  normalizeSupplementId: (req: Request, res: Response, next: NextFunction) => void
}

export const requireFields = impl.requireFields
export const requireAnyField = impl.requireAnyField
export const validateDate = impl.validateDate
export const normalizeNutrition = impl.normalizeNutrition
export const normalizeSupplementId = impl.normalizeSupplementId
