const mongoose = require('mongoose')

// An absence on the previous-week review marked as a sick day.
//   paid-sick:   `hours` are added to that day's hours worked
//   unpaid-sick: no hours are added
// Either way the absence gets no attendance point recommendation.
// No record means an ordinary absence.

const sickDaySchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true
  },

  // Monday of the reviewed week (YYYY-MM-DD)
  weekStart: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  employeeNumber: {
    type: String,
    required: true,
    trim: true,
    maxlength: 32
  },

  employeeName: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },

  // The absent day (YYYY-MM-DD)
  date: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  type: {
    type: String,
    enum: ['paid-sick', 'unpaid-sick'],
    required: true
  },

  hours: {
    type: Number,
    min: 0,
    max: 24,
    default: 0
  },

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

sickDaySchema.index(
  { store: 1, employeeNumber: 1, date: 1 },
  { unique: true }
)

module.exports = mongoose.model('SickDay', sickDaySchema)
