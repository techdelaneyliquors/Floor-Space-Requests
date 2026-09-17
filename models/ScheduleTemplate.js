const mongoose = require('mongoose')

const scheduleTemplateSchema =
  new mongoose.Schema(
    {
      store: {
        type: String,
        required: true,
        trim: true
      },

      templateName: {
        type: String,
        required: true,
        trim: true
      },

      isDefault: {
        type: Boolean,
        default: false
      },

      templateData: {
        assignments: {
          type: Object,
          default: {}
        },

        managerCoverage: {
          type: Object,
          default: {}
        },

        associateCoverage: {
          type: Object,
          default: {}
        },

        cashierCoverage: {
            type: Object,
            default: {}
        },

        temporaryShifts: {
          type: Object,
          default: {}
        },

        temporaryShiftNotes: {
          type: Object,
          default: {}
        }
      }
    },
    {
      timestamps: true
    }
  )

scheduleTemplateSchema.index(
  {
    store: 1,
    templateName: 1
  },
  {
    unique: true
  }
)

module.exports = mongoose.model(
  'ScheduleTemplate',
  scheduleTemplateSchema
)