// Per-store setup for the shared Schedule page (views/Store Schedule.ejs).
//
// The preset coverage rows were carried over unchanged from each store's
// former Schedule page, so existing saved templates keep matching (row ids
// such as Hamden's associate "shift1" must not be renamed). Managers can
// add or remove rows on the page; a saved template overrides these presets.
//
// hasCashiers: only Branford and New Haven schedule cashiers.

module.exports = {
  Branford: {
    hasCashiers: true,
    managerCoverage: {
      manager1: {
        label: 'Manager 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager2: {
        label: 'Manager 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager3: {
        label: 'Manager 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager4: {
        label: 'Manager 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    associateCoverage: {
      associate1: {
        label: 'Associate 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate2: {
        label: 'Associate 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate3: {
        label: 'Associate 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate4: {
        label: 'Associate 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate5: {
        label: 'Associate 5',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate6: {
        label: 'Associate 6',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate7: {
        label: 'Associate 7',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate8: {
        label: 'Associate 8',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    cashierCoverage: {
      cashier1: {
        label: 'Cashier 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier2: {
        label: 'Cashier 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier3: {
        label: 'Cashier 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier4: {
        label: 'Cashier 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier5: {
        label: 'Cashier 5',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier6: {
        label: 'Cashier 6',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    }
  },
  Hamden: {
    hasCashiers: false,
    managerCoverage: {
      manager1: {
        label: 'Manager coverage 1',
        monday: '',
        tuesday: '3:00 PM to 8:00 PM',
        wednesday: '9:00 AM to 1:00 PM',
        thursday: '8:30 AM to 3:00 PM',
        friday: '2:00 PM to 9:00 PM',
        saturday: '9:00 AM to 9:00 PM',
        sunday: ''
      },
      manager2: {
        label: 'Manager coverage 2',
        monday: '',
        tuesday: '8:30 AM to 5:00 PM',
        wednesday: '8:30 AM to 5:00 PM',
        thursday: '1:00 PM to 9:00 PM',
        friday: '8:30 AM to 6:00 PM',
        saturday: '',
        sunday: '10:00 AM to 6:00 PM'
      },
      manager3: {
        label: 'Manager coverage 3',
        monday: '9:00 AM to 8:00 PM',
        tuesday: '11:00 AM to 8:00 PM',
        wednesday: '12:00 PM to 8:00 PM',
        thursday: '',
        friday: '12:00 PM to 9:00 PM',
        saturday: '1:00 PM to 9:00 PM',
        sunday: ''
      }
    },
    associateCoverage: {
      shift1: {
        label: 'Associate Shift 1',
        monday: '9:00 AM to 2:00 PM',
        tuesday: '9:00 AM to 2:00 PM',
        wednesday: '',
        thursday: '4:00 PM to 9:00 PM',
        friday: '9:00 AM to 3:00 PM',
        saturday: '9:00 AM to 2:00 PM',
        sunday: ''
      },
      shift2: {
        label: 'Associate Shift 2',
        monday: '2:00 PM to 8:00 PM',
        tuesday: '',
        wednesday: '3:00 PM to 8:00 PM',
        thursday: '',
        friday: '3:00 PM to 9:00 PM',
        saturday: '3:00 PM to 9:00 PM',
        sunday: '10:00 AM to 6:00 PM'
      },
      shift3: {
        label: 'Associate Shift 3',
        monday: '',
        tuesday: '9:00 AM to 5:00 PM',
        wednesday: '',
        thursday: '9:00 AM to 5:00 PM',
        friday: '9:00 AM to 5:00 PM',
        saturday: '9:00 AM to 6:00 PM',
        sunday: ''
      }
    },
    cashierCoverage: {}
  },
  'New Haven': {
    hasCashiers: true,
    managerCoverage: {
      manager1: {
        label: 'Manager 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager2: {
        label: 'Manager 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager3: {
        label: 'Manager 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    associateCoverage: {
      associate1: {
        label: 'Associate 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate2: {
        label: 'Associate 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate3: {
        label: 'Associate 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate4: {
        label: 'Associate 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    cashierCoverage: {
      cashier1: {
        label: 'Cashier 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier2: {
        label: 'Cashier 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier3: {
        label: 'Cashier 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      cashier4: {
        label: 'Cashier 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    }
  },
  'New Milford': {
    hasCashiers: false,
    managerCoverage: {
      manager1: {
        label: 'Manager 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager2: {
        label: 'Manager 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    associateCoverage: {
      associate1: {
        label: 'Associate 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate2: {
        label: 'Associate 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate3: {
        label: 'Associate 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate4: {
        label: 'Associate 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    cashierCoverage: {}
  },
  Stratford: {
    hasCashiers: false,
    managerCoverage: {
      manager1: {
        label: 'Manager 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager2: {
        label: 'Manager 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      manager3: {
        label: 'Manager 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    associateCoverage: {
      associate1: {
        label: 'Associate 1',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate2: {
        label: 'Associate 2',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate3: {
        label: 'Associate 3',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      },
      associate4: {
        label: 'Associate 4',
        monday: '',
        tuesday: '',
        wednesday: '',
        thursday: '',
        friday: '',
        saturday: '',
        sunday: ''
      }
    },
    cashierCoverage: {}
  }
}
