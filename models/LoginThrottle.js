const mongoose = require('mongoose')

// Per-client-IP counters, updated atomically in compiledbuild.js:
//   "<ip>"           failed logins across all accounts
//   "register:<ip>"  sign-up attempts
// Documents delete themselves once expireAt passes (TTL index).
const loginThrottleSchema = new mongoose.Schema({
  _id: String,

  count: {
    type: Number,
    default: 0
  },

  windowStart: Date,
  blockedUntil: Date,

  expireAt: {
    type: Date,
    index: { expireAfterSeconds: 0 }
  }
}, {
  versionKey: false
})

module.exports = mongoose.model(
  'LoginThrottle',
  loginThrottleSchema
)
