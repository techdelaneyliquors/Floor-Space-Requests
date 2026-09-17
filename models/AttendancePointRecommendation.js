const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    store: {
      type: String,
      required: true
    },

    employeeNumber: {
      type: String,
      required: true
    },

    employeeName: {
      type: String,
      required: true
    },

    infractionDate: {
      type: Date,
      required: true
    },

    infractionType: {
      type: String,
      required: true
    },

    recommendedPoints: {
      type: Number,
      required: true
    },

    managerComment: {
      type: String,
      default: ''
    },

    sourceExceptionId: {
      type: String,
      required: true
    },

    recommendedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    recommendedByName: {
      type: String
    },

    assigned: {
      type: Boolean,
      default: false
    },

    assignedAt: Date,

    assignedPointRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AttendancePoint'
    }
  },
  {
    timestamps: true
  }
);

schema.index(
  {
    store: 1,
    sourceExceptionId: 1
  },
  {
    unique: true
  }
);

module.exports = mongoose.model(
  'AttendancePointRecommendation',
  schema
);