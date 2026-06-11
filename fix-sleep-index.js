const { MongoClient } = require('mongodb')
async function main() {
  const client = new MongoClient('mongodb://localhost:27017')
  await client.connect()
  const db = client.db('health_tracker')
  
  // Drop conflicting unique index on sleep_id
  const indexes = await db.collection('whoop_sleep').indexes()
  console.log('Current indexes:', indexes.map(i => i.name))
  
  // Drop sleep_id_1 if it's unique
  for (const idx of indexes) {
    if (idx.name === 'sleep_id_1' && idx.unique) {
      await db.collection('whoop_sleep').dropIndex('sleep_id_1')
      console.log('Dropped unique index sleep_id_1')
    }
  }
  
  await client.close()
}
main().catch(console.error)
