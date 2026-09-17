const mongoose = require('mongoose');

const attendanceOvertimeReviewSchema =
  new mongoose.Schema(
    {
      store: {
        type: String,
        required: true,
        trim: true,
        enum: [
          'Branford',
          'Hamden',
          'New Haven',
          'New Milford',
          'Stratford'
        ]
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

      workDate: {
        type: Date,
        required: true
      },

      dayLabel: {
        type: String,
        required: true,
        trim: true
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

      scheduledHours: {
        type: Number,
        required: true,
        min: 0
      },

      actualHours: {
        type: Number,
        required: true,
        min: 0
      },

      overtimeHours: {
        type: Number,
        required: true,
        min: 0
      },

      explanation: {
        type: String,
        required: true,
        trim: true,
        maxlength: 2000
      },

      sourceExceptionId: {
        type: String,
        required: true,
        trim: true
      },

      reviewedByUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },

      reviewedByName: {
        type: String,
        required: true,
        trim: true
      },

      reviewedByEmail: {
        type: String,
        default: '',
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
        default: '',
        trim: true
      },

      voidReason: {
        type: String,
        default: '',
        trim: true
      }
    },
    {
      timestamps: true
    }
  );

attendanceOvertimeReviewSchema.index(
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

attendanceOvertimeReviewSchema.index({
  store: 1,
  employeeNumber: 1,
  workDate: -1
});

module.exports = mongoose.model(
  'AttendanceOvertimeReview',
  attendanceOvertimeReviewSchema
);
