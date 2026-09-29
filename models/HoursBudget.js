const mongoose = require('mongoose')

// A store's weekly labor-hours budget, set by admins on the Schedule page.
//
// `defaultHours` applies to every week unless that week has an override
// (holidays, inventory, busy season). Past weeks keep their override, so
// "worked / budget" for an old week stays what it was.

const overrideSchema = new mongoose.Schema({
  // Monday of the week, as YYYY-MM-DD (store-local date)
  weekStart: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  hours: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false })

const hoursBudgetSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  defaultHours: {
    type: Number,
    min: 0,
    default: null
  },

  overrides: {
    type: [overrideSchema],
    default: []
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

module.exports = mongoose.model(
  'HoursBudget',
  hoursBudgetSchema
)
