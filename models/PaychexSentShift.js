const mongoose = require('mongoose')

// A shift the "Send to Paychex" userscript has added to Paychex Flex Time.
// Sending the same week again skips shifts logged here, so nothing is
// added twice. `shiftKey` identifies the shift within its store:
//   '<employee number>|<start YYYY-MM-DD HH:mm:ss>|<end>'

const paychexSentShiftSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true
  },

  // Monday of the schedule week (YYYY-MM-DD)
  weekStart: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  shiftKey: {
    type: String,
    required: true,
    maxlength: 120
  },

  employeeNumber: String,
  employeeName: String,
  paychexUserId: Number,
  ll1: Number,
  start: String,
  end: String,

  // Whatever Paychex returned, trimmed, in case it's needed later
  paychexResponse: {
    type: String,
    maxlength: 500
  },

  sentBy: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    name: String
  }
}, {
  timestamps: true
})

paychexSentShiftSchema.index(
  { store: 1, shiftKey: 1 },
  { unique: true }
)

paychexSentShiftSchema.index({ store: 1, weekStart: 1 })

module.exports = mongoose.model(
  'PaychexSentShift',
  paychexSentShiftSchema
)
