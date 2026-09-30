const mongoose = require('mongoose')

// Paid time off for one employee in one schedule week, set by a manager or
// admin in the Build tab's PTO section: paid hours per day off (`days`,
// 8 by default when a day is marked paid) and their weekly total
// (`hours`). No record means no paid time off.
// Keyed by the name used on the Schedule page (the printable schedule is
// built by name); the employee number is kept for reference.

const dayHours = { type: Number, min: 0, max: 24, default: 0 }

const ptoHoursSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true
  },

  // Monday of the week (YYYY-MM-DD)
  weekStart: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  employeeName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },

  employeeNumber: {
    type: String,
    trim: true,
    maxlength: 32,
    default: ''
  },

  // Paid hours for each day off (0 = unpaid)
  days: {
    monday: dayHours,
    tuesday: dayHours,
    wednesday: dayHours,
    thursday: dayHours,
    friday: dayHours,
    saturday: dayHours,
    sunday: dayHours
  },

  // Weekly total of `days`
  hours: {
    type: Number,
    required: true,
    min: 0,
    max: 168
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

ptoHoursSchema.index(
  { store: 1, weekStart: 1, employeeName: 1 },
  { unique: true }
)

module.exports = mongoose.model('PtoHours', ptoHoursSchema)
