/**
 * Fuzzing Test Suite for Fugue Interleave CRDT
 * 
 * Inspired by json-joy's StrNode.fuzzing-multiuser.spec.ts
 * 
 * @see packages/json-joy/src/json-crdt/nodes/str/__tests__/StrNode.fuzzing-multiuser.spec.ts
 */

import {
  FugueInterleaveFuzzer,
  TwoUserFuzzer,
  runFuzzer,
  runTwoUserFuzzer,
  FugueCRDT,
  FugueMaxSimpleCRDT,
} from './fuzzer.js';

// Helper to run fuzzer with error handling and logging
const execute = (CRDTClass, times, options = {}) => {
  for (let i = 0; i < times; i++) {
    const fuzzer = new FugueInterleaveFuzzer(CRDTClass, options);
    fuzzer.generatePrelude();
    try {
      fuzzer.assertSiteViewsEqual();
      fuzzer.executeEditingSessionsAndAssert();
    } catch (error) {
      console.log(fuzzer.toString());
      throw error;
    }
  }
};

const executeTwoUser = (CRDTClass, times, operationCount = 10) => {
  for (let i = 0; i < times; i++) {
    const fuzzer = new TwoUserFuzzer(CRDTClass);
    fuzzer.runIteration(operationCount);
  }
};

// =========================================================
// Fugue (original) Tests
// =========================================================

describe('Fugue multi-user parallel editing fuzzing', () => {
  test('default fuzzer options', () => {
    execute(FugueCRDT, 100);
  });

  test('minimal trace', () => {
    execute(FugueCRDT, 10, {
      maxInsertLength: 5,
      maxPatchLength: 3,
      maxPreludeLength: 3,
      maxSiteCount: 3,
      minEditingSessionCount: 2,
      maxEditingSessionCount: 2,
    });
  });

  test('inserts only', () => {
    execute(FugueCRDT, 100, {
      deleteProbability: 0,
    });
  });

  test('only two users', () => {
    execute(FugueCRDT, 100, {
      minSiteCount: 2,
      maxSiteCount: 2,
      minEditingSessionCount: 2,
      maxEditingSessionCount: 2,
    });
  });

  test('only three users', () => {
    execute(FugueCRDT, 100, {
      minSiteCount: 3,
      maxSiteCount: 3,
      minEditingSessionCount: 3,
      maxEditingSessionCount: 3,
    });
  });

  test('long patches', () => {
    execute(FugueCRDT, 5, {
      minPatchLength: 50,
      maxPatchLength: 100,
      minEditingSessionCount: 2,
      maxEditingSessionCount: 4,
    });
  });

  test('short patches', () => {
    execute(FugueCRDT, 200, {
      minPatchLength: 0,
      maxPatchLength: 3,
    });
  });

  test('short deletes', () => {
    execute(FugueCRDT, 200, {
      maxDeleteLength: 3,
    });
  });

  test('high delete probability', () => {
    execute(FugueCRDT, 100, {
      deleteProbability: 0.8,
    });
  });
});

describe('Fugue two-user fuzzing', () => {
  test('two concurrent users - basic', () => {
    executeTwoUser(FugueCRDT, 1000, 5);
  });

  test('two concurrent users - extended', () => {
    executeTwoUser(FugueCRDT, 100, 20);
  });
});

// =========================================================
// FugueMaxSimple Tests
// =========================================================

describe('FugueMaxSimple multi-user parallel editing fuzzing', () => {
  test('default fuzzer options', () => {
    execute(FugueMaxSimpleCRDT, 100);
  });

  test('minimal trace', () => {
    execute(FugueMaxSimpleCRDT, 10, {
      maxInsertLength: 5,
      maxPatchLength: 3,
      maxPreludeLength: 3,
      maxSiteCount: 3,
      minEditingSessionCount: 2,
      maxEditingSessionCount: 2,
    });
  });

  test('inserts only', () => {
    execute(FugueMaxSimpleCRDT, 100, {
      deleteProbability: 0,
    });
  });

  test('only two users', () => {
    execute(FugueMaxSimpleCRDT, 100, {
      minSiteCount: 2,
      maxSiteCount: 2,
      minEditingSessionCount: 2,
      maxEditingSessionCount: 2,
    });
  });

  test('only three users', () => {
    execute(FugueMaxSimpleCRDT, 100, {
      minSiteCount: 3,
      maxSiteCount: 3,
      minEditingSessionCount: 3,
      maxEditingSessionCount: 3,
    });
  });

  test('long patches', () => {
    execute(FugueMaxSimpleCRDT, 5, {
      minPatchLength: 50,
      maxPatchLength: 100,
      minEditingSessionCount: 2,
      maxEditingSessionCount: 4,
    });
  });

  test('short patches', () => {
    execute(FugueMaxSimpleCRDT, 200, {
      minPatchLength: 0,
      maxPatchLength: 3,
    });
  });

  test('short deletes', () => {
    execute(FugueMaxSimpleCRDT, 200, {
      maxDeleteLength: 3,
    });
  });

  test('high delete probability', () => {
    execute(FugueMaxSimpleCRDT, 100, {
      deleteProbability: 0.8,
    });
  });
});

describe('FugueMaxSimple two-user fuzzing', () => {
  test('two concurrent users - basic', () => {
    executeTwoUser(FugueMaxSimpleCRDT, 1000, 5);
  });

  test('two concurrent users - extended', () => {
    executeTwoUser(FugueMaxSimpleCRDT, 100, 20);
  });
});

// =========================================================
// Order Independence Tests (the key commutativity tests)
// =========================================================

describe('Order independence (commutativity)', () => {
  const testOrderIndependence = (CRDTClass, name) => {
    describe(name, () => {
      test('updates applied in different orders converge', () => {
        execute(CRDTClass, 50, {
          minSiteCount: 3,
          maxSiteCount: 5,
          minEditingSessionCount: 3,
          maxEditingSessionCount: 5,
          minPatchLength: 2,
          maxPatchLength: 5,
        });
      });

      test('delete operations in different orders', () => {
        execute(CRDTClass, 100, {
          minSiteCount: 2,
          maxSiteCount: 4,
          deleteProbability: 0.7,
          minPatchLength: 3,
          maxPatchLength: 8,
        });
      });

      test('many sites with interleaved operations', () => {
        execute(CRDTClass, 20, {
          minSiteCount: 5,
          maxSiteCount: 10,
          minEditingSessionCount: 2,
          maxEditingSessionCount: 3,
        });
      });
    });
  };

  testOrderIndependence(FugueCRDT, 'Fugue');
  testOrderIndependence(FugueMaxSimpleCRDT, 'FugueMaxSimple');
});
