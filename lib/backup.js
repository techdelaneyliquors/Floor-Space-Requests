const zlib = require('zlib')
const { EJSON } = require('mongoose').mongo.BSON

// Database backups: every collection as Extended JSON (keeps ObjectIds and
// dates exact), in a .zip so it can be emailed (Brevo accepts .zip but not
// .gz or .json attachments). Restore with scripts/restore-backup.js.

// Never leave the server: login secrets and throwaway data
const SKIPPED_COLLECTIONS = ['loginthrottles', 'backuplogs']
const SECRET_USER_FIELDS = [
  'password', 'resetToken', 'resetTokenExpiry',
  'emailVerifyTokenHash', 'paychexSyncKeyHash'
]

const BACKUP_FILE_NAME = 'backup.json'

async function buildBackup(db) {
  const collections = {}
  const counts = {}
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(entry => entry.name)
    .filter(name => !name.startsWith('system.') && !SKIPPED_COLLECTIONS.includes(name))
    .sort()

  for (const name of names) {
    const projection = name === 'users'
      ? Object.fromEntries(SECRET_USER_FIELDS.map(field => [field, 0]))
      : {}
    const docs = await db.collection(name).find({}, { projection }).toArray()
    collections[name] = docs
    counts[name] = docs.length
  }

  const json = EJSON.stringify({
    createdAt: new Date(),
    database: db.databaseName,
    leftOut: { collections: SKIPPED_COLLECTIONS, userFields: SECRET_USER_FIELDS },
    collections
  }, { relaxed: false })

  return { zip: zipOneFile(BACKUP_FILE_NAME, Buffer.from(json, 'utf8')), counts }
}

// Reads the backup written by buildBackup
function readBackup(zipBuffer) {
  return EJSON.parse(unzipOneFile(zipBuffer).toString('utf8'), { relaxed: false })
}

// ------------------------
// Minimal .zip (one deflated file), no dependency needed
// ------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipOneFile(name, data) {
  const fileName = Buffer.from(name, 'utf8')
  const compressed = zlib.deflateRawSync(data, { level: 9 })
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(8, 8) // deflate
  local.writeUInt32LE(0, 10) // time/date
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(0, 12)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  // extra, comment, disk, attributes, local header offset: all 0

  const centralOffset = local.length + fileName.length + compressed.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + fileName.length, 12)
  end.writeUInt32LE(centralOffset, 16)

  return Buffer.concat([local, fileName, compressed, central, fileName, end])
}

function unzipOneFile(zip) {
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a backup .zip file.')
  const method = zip.readUInt16LE(8)
  const compressedSize = zip.readUInt32LE(18)
  const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)
  const body = zip.subarray(start, start + compressedSize)
  const data = method === 8 ? zlib.inflateRawSync(body) : body
  if (crc32(data) !== zip.readUInt32LE(14)) throw new Error('The backup file is damaged (checksum mismatch).')
  return data
}

module.exports = { buildBackup, readBackup, SECRET_USER_FIELDS }
