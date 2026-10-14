// Restores a weekly backup email's .zip into a MongoDB database.
//
//   node scripts/restore-backup.js <backup.zip> <mongodb uri>            (empty database only)
//   node scripts/restore-backup.js <backup.zip> <mongodb uri> --replace  (wipes and replaces
//                                                                        each collection in the backup)
//
// Passwords are not in backups, so after a restore everyone signs in by
// using "Forgot password". Paychex sync keys must be created again.
const fs = require('fs')
const mongoose = require('mongoose')
const { readBackup } = require('../lib/backup')

;(async () => {
  const [file, uri, flag] = process.argv.slice(2)
  if (!file || !uri) {
    console.log('Usage: node scripts/restore-backup.js <backup.zip> <mongodb uri> [--replace]')
    process.exit(1)
  }
  const replace = flag === '--replace'

  const backup = readBackup(fs.readFileSync(file))
  console.log(`Backup of "${backup.database}" made ${new Date(backup.createdAt).toISOString()}`)

  await mongoose.connect(uri)
  const db = mongoose.connection.db
  try {
    const names = Object.keys(backup.collections)

    if (!replace) {
      for (const name of names) {
        const existing = await db.collection(name).estimatedDocumentCount()
        if (existing) {
          throw new Error(`"${name}" already has ${existing} documents. Use an empty database, or add --replace to overwrite.`)
        }
      }
    }

    for (const name of names) {
      const docs = backup.collections[name]
      if (replace) await db.collection(name).deleteMany({})
      if (docs.length) await db.collection(name).insertMany(docs, { ordered: false })
      console.log(`${name}: ${docs.length} restored`)
    }
    console.log('Done. Start the app once against this database so it rebuilds its indexes.')
  } finally {
    await mongoose.disconnect()
  }
})().catch(err => {
  console.error('Restore failed:', err.message)
  process.exit(1)
})
