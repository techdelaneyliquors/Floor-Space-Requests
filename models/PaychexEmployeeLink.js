const mongoose = require('mongoose')

// How one of our employees is identified in Paychex Flex Time, per store.
// Matched to the schedule roster by store + employee number, and used to
// send approved shifts into Paychex's scheduler:
//   paychexUserId -> AddEditShift "UserID" (Flex Time's internal user id)
//   ll1           -> AddEditShift "LL1" (labor level 1, e.g. the location)

const paychexEmployeeLinkSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true
  },

  // Same number as the schedule roster (buildEmployeeIdentifiers)
  employeeNumber: {
    type: String,
    required: true,
    trim: true,
    maxlength: 32
  },

  // For display only; the roster name can change
  employeeName: {
    type: String,
    trim: true,
    maxlength: 120,
    default: ''
  },

  paychexUserId: {
    type: Number,
    required: true,
    min: 1,
    validate: Number.isInteger
  },

  ll1: {
    type: Number,
    min: 0,
    default: null,
    validate: value => value === null || Number.isInteger(value)
  },

  // Where the last change came from: the admin page, a paste, a workbook
  source: {
    type: String,
    enum: ['page', 'paste', 'excel', 'extension'],
    default: 'page'
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

paychexEmployeeLinkSchema.index(
  { store: 1, employeeNumber: 1 },
  { unique: true }
)

module.exports = mongoose.model(
  'PaychexEmployeeLink',
  paychexEmployeeLinkSchema
)
