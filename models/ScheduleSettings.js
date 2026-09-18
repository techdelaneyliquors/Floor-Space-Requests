const mongoose = require('mongoose')

const scheduleSettingsSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  managers: {
    type: [String],
    default: []
  },

  associates: {
    type: [String],
    default: []
  },

  cashiers: {
  type: [String],
  default: []
},

  buildEmployeeIdentifiers: {
  type: Object,
  default: {}
},

  availability: {
    type: Map,
    of: Boolean,
    default: {}
  },

  attendance: {
    type: Object,
    default: {}
  },

  previousActualShifts: {
    type: Object,
    default: {}
  },

  previousActualHours: {
    type: Object,
    default: {}
  },

  previousScheduledHours: {
    type: Object,
    default: {}
  },

  previousScheduledShifts: {
  type: Object,
  default: {}
},

previousWeekStart: {
  type: Date,
  default: null
},

previousWeekEnd: {
  type: Date,
  default: null
},

approvedOvertimeHours: {
  type: Map,
  of: Number,
  default: {}
},

employeeIdentifiers: {
  type: Object,
  default: {}
}

}, {
  timestamps: true
})

module.exports = mongoose.model(
  'ScheduleSettings',
  scheduleSettingsSchema
)

