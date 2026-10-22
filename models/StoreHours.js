const mongoose = require('mongoose')

// When each store opens and closes on each day of the week, set on the
// Store Hours page. The printable schedule uses it to find which keyholder
// opens and which closes each day.

const dayHoursSchema = new mongoose.Schema({
  closed: {
    type: Boolean,
    default: false
  },

  // 24-hour "HH:MM", store-local; blank when not set
  open: {
    type: String,
    default: '',
    match: /^(|([01]\d|2[0-3]):[0-5]\d)$/
  },

  close: {
    type: String,
    default: '',
    match: /^(|([01]\d|2[0-3]):[0-5]\d)$/
  }
}, { _id: false })

const days = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map(day => [day, { type: dayHoursSchema, default: () => ({}) }])
)

const storeHoursSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },

  days,

  updatedBy: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    name: String
  }
}, {
  timestamps: true
})

module.exports = mongoose.model(
  'StoreHours',
  storeHoursSchema
)
