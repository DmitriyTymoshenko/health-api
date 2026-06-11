const { MongoClient, ObjectId } = require('mongodb')
async function main() {
  const client = new MongoClient('mongodb://localhost:27017')
  await client.connect()
  const db = client.db('health_tracker')
  
  // Fix first lab record - remove wrong vitamin_d=2022 and hba1c=1
  // Keep correct values from second record
  await db.collection('lab_results').updateOne(
    { _id: new ObjectId('69cbbb7762a7ccf460a0a995') },
    { $set: { 
      'values.vitamin_d': 25,  // correct value from second record
      'values.hba1c': null,    // remove wrong value
      'values.vitamin_b12': 12 // keep as is (maybe correct)
    }}
  )
  
  // Verify
  const latest = await db.collection('lab_results').findOne({ _id: new ObjectId('69cbbb7762a7ccf460a0a995') })
  console.log('vitamin_d:', latest.values.vitamin_d)
  console.log('hba1c:', latest.values.hba1c)
  
  await client.close()
}
main()
