
const mongoose = require('mongoose')
const {
  STORE_LIST,
  ALL_STORES_VALUE,
  ACCESS_ROLES,
  normalizeStoreList
} = require('./stores')

const STORE_VALUES = [...STORE_LIST, ALL_STORES_VALUE]


const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },

  // 'none' until an access request is approved
  role: {
    type: String,
    enum: ['none', ...ACCESS_ROLES],
    default: 'none'
  },

  // One or more stores, or ['all']
  stores: {
    type: [{
      type: String,
      enum: STORE_VALUES
    }],
    default: []
  },

  accessStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'denied'],
    default: 'none'
  },

  accessRequest: {
    role: {
      type: String,
      enum: ACCESS_ROLES
    },
    stores: [{
      type: String,
      enum: STORE_VALUES
    }],
    note: String,
    requestedAt: Date
  },

  accessReview: {
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reviewedAt: Date,
    decision: {
      type: String,
      enum: ['approved', 'denied', 'revoked']
    },
    reason: String
  },

  resetToken: String,
  resetTokenExpiry: Date,

  // Login lockout: failed attempts since the last successful login
  failedLoginAttempts: {
    type: Number,
    default: 0
  },
  lockoutUntil: Date,

  // Forgot-password emails are limited per account
  lastResetEmailAt: Date,

  // Stamped into each login token; bumping it logs out every session
  tokenVersion: {
    type: Number,
    default: 0
  },

  // Which person on each store's schedule roster this account is, by
  // employee number (names are looked up from the roster when shown).
  // At most one account may link to a given store + employee number;
  // compiledbuild.js enforces that when links are saved.
  rosterLinks: {
    type: [{
      _id: false,
      store: {
        type: String,
        enum: STORE_LIST,
        required: true
      },
      employeeNumber: {
        type: String,
        required: true,
        trim: true
      }
    }],
    default: []
  },

  // Email ownership. Only a SHA-256 hash of the link token is stored.
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerifyTokenHash: String,
  emailVerifyExpiry: Date,
  lastVerifyEmailAt: Date

})

UserSchema.pre('save', function () {
  if (this.isModified('stores')) {
    this.stores = normalizeStoreList(this.stores)
  }

  if (
    this.accessRequest &&
    this.isModified('accessRequest.stores')
  ) {
    this.accessRequest.stores =
      normalizeStoreList(this.accessRequest.stores)
  }
})


module.exports = mongoose.model('User', UserSchema)
