const mongoose = require('mongoose');

const attendancePointSchema =
  new mongoose.Schema(
    {
      store: {
        type: String,
        required: true,
        trim: true,
        index: true
      },

      employeeNumber: {
        type: String,
        required: true,
        trim: true
      },

      employeeName: {
        type: String,
        required: true,
        trim: true
      },

      infractionDate: {
        type: Date,
        required: true,
        index: true
      },

      infractionType: {
        type: String,
        required: true,
        enum: [
          'tardy',
          'left_early',
          'late_and_left_early',
          'absence',
          'no_call_no_show'
        ]
      },

      points: {
        type: Number,
        required: true,
        min: 0,
        max: 5
      },

      scheduledShift: {
        type: String,
        default: '',
        trim: true
      },

      actualShift: {
        type: String,
        default: '',
        trim: true
      },

      lateMinutes: {
        type: Number,
        default: 0,
        min: 0
      },

      earlyMinutes: {
        type: Number,
        default: 0,
        min: 0
      },

      managerComment: {
        type: String,
        required: true,
        trim: true,
        maxlength: 2000
      },

      assignedByUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },

      assignedByName: {
        type: String,
        required: true,
        trim: true
      },

      assignedByEmail: {
        type: String,
        default: '',
        trim: true
      },

      sourceExceptionId: {
        type: String,
        required: true,
        trim: true
      },

      voided: {
        type: Boolean,
        default: false
      },

      voidedAt: {
        type: Date,
        default: null
      },

      voidedByName: {
        type: String,
        default: ''
      },

      voidReason: {
        type: String,
        default: '',
        maxlength: 2000
      }
    },
    {
      timestamps: true
    }
  );

attendancePointSchema.index({
  store: 1,
  employeeNumber: 1,
  infractionDate: -1
});

attendancePointSchema.index(
  {
    store: 1,
    sourceExceptionId: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      voided: false
    }
  }
);

module.exports = mongoose.model(
  'AttendancePoint',
  attendancePointSchema
);