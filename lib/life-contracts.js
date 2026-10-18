'use strict'
const Ajv = require('ajv')
const path = require('path')
const schema = require(path.join(__dirname, '../../contracts/life-contracts.schema.json'))
const ajv = new Ajv({ allErrors: true, strict: false })
ajv.addSchema(schema, 'life')

function validateBody(name) {
  const validate = ajv.getSchema(`life#/definitions/${name}`)
  if (!validate) throw new Error(`Missing life contract: ${name}`)
  return (req, res, next) => {
    if (!validate(req.body || {})) return res.status(400).json({ error: ajv.errorsText(validate.errors) })
    next()
  }
}
module.exports = { validateBody }
