'use strict'
// Fill only missing metadata from an unambiguous sibling; never overwrite or delete.
const { MongoClient } = require('mongodb')
async function main() {
  const client = await MongoClient.connect(process.env.MONGO_URL)
  try {
    const col = client.db().collection('exercises_library')
    const docs = await col.find({}).toArray()
    const plan = docs.filter(d => !d.equipment && d.catalog_id).flatMap(d => {
      const values = [...new Set(docs.filter(s => s.catalog_id === d.catalog_id && s.equipment).map(s => s.equipment))]
      return values.length === 1 ? [{id:d._id,name:d.name,equipment:values[0]}] : []
    })
    console.log(JSON.stringify({plan:plan.map(({id,...p})=>p),count:plan.length}))
    if (process.argv.includes('--apply')) {
      const approved = Number(process.env.EQUIPMENT_APPROVED_COUNT)
      if (plan.length !== approved || plan.length > 10) throw new Error('count changed or mass-update approval required')
      for (const p of plan) {
        const result = await col.updateOne({_id:p.id,equipment:null},{$set:{equipment:p.equipment}})
        if (result.modifiedCount !== 1) throw new Error('concurrent metadata change')
      }
      console.log(JSON.stringify({applied:plan.length,remaining:await col.countDocuments({_id:{$in:plan.map(p=>p.id)},equipment:null})}))
    }
  } finally { await client.close() }
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
