/**
 * Property-Based Testing with fast-check
 * 
 * fast-check provides shrinking and reproducibility like libfuzzer.
 * While not coverage-guided, it's highly effective at finding edge cases
 * through:
 * - Intelligent value shrinking (finds minimal failing cases)
 * - Reproducible runs via seed
 * - Arbitrary input generation for complex structures
 * 
 * This is a good JavaScript alternative when libfuzzer-based tools
 * have compatibility issues.
 * 
 * Run: npm test -- --testNamePattern="Property-based"
 */

import fc from 'fast-check';
import { FugueCRDT, FugueMaxSimpleCRDT } from './fuzzer.js';

// Action types similar to Loro's
const ActionType = {
  INSERT: 'insert',
  DELETE: 'delete',
  SYNC: 'sync',
};

// Action arbitrary - generates random valid actions
const actionArbitrary = (actorCount) => fc.oneof(
  // Insert action
  fc.record({
    type: fc.constant(ActionType.INSERT),
    actor: fc.nat(actorCount - 1),
    pos: fc.nat(255),
    content: fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1, maxLength: 4 }),
  }),
  // Delete action
  fc.record({
    type: fc.constant(ActionType.DELETE),
    actor: fc.nat(actorCount - 1),
    pos: fc.nat(255),
    count: fc.integer({ min: 1, max: 10 }),
  }),
  // Sync action
  fc.record({
    type: fc.constant(ActionType.SYNC),
    actor: fc.nat(actorCount - 1),
    targetActor: fc.nat(actorCount - 1),
  })
);

function preprocessAction(action, actors, actorCount) {
  const actor = actors[action.actor];
  const len = actor.getArray().length;

  if (action.type === ActionType.INSERT) {
    return { ...action, pos: action.pos % (len + 1) };
  } else if (action.type === ActionType.DELETE) {
    if (len === 0) {
      return { ...action, pos: 0, count: 0 };
    }
    return {
      ...action,
      pos: action.pos % len,
      count: Math.min(action.count, len - (action.pos % len)),
    };
  } else if (action.type === ActionType.SYNC) {
    let targetActor = action.targetActor;
    if (targetActor === action.actor) {
      targetActor = (action.actor + 1) % actorCount;
    }
    return { ...action, targetActor };
  }
  return action;
}

function applyAction(action, actors) {
  const actor = actors[action.actor];

  if (action.type === ActionType.INSERT) {
    actor.insertArray(action.pos, action.content);
  } else if (action.type === ActionType.DELETE) {
    if (action.count > 0) {
      actor.deleteArray(action.pos, action.count);
    }
  } else if (action.type === ActionType.SYNC) {
    const source = actors[action.targetActor];
    for (const update of source.updates) {
      actor.applyUpdate(update);
    }
  }
}

function runActions(CRDTClass, actions, actorCount) {
  const actors = [];
  for (let i = 0; i < actorCount; i++) {
    actors.push(new CRDTClass(null, `actor-${i}`));
  }

  // Apply all actions
  for (const action of actions) {
    const processedAction = preprocessAction(action, actors, actorCount);
    applyAction(processedAction, actors);
  }

  // Final merge
  for (let i = 0; i < actorCount; i++) {
    for (let j = i + 1; j < actorCount; j++) {
      const a = actors[i];
      const b = actors[j];
      for (const update of b.updates) a.applyUpdate(update);
      for (const update of a.updates) b.applyUpdate(update);
    }
  }

  return actors;
}

describe('Property-based fuzzing with fast-check', () => {
  const ACTOR_COUNT = 5;
  const numRuns = 1000;

  describe('FugueCRDT', () => {
    it('all actors converge after any sequence of operations', () => {
      fc.assert(
        fc.property(
          fc.array(actionArbitrary(ACTOR_COUNT), { minLength: 1, maxLength: 100 }),
          (actions) => {
            const actors = runActions(FugueCRDT, actions, ACTOR_COUNT);
            
            // Check all actors have same view
            const view0 = actors[0].view();
            for (let i = 1; i < ACTOR_COUNT; i++) {
              if (actors[i].view() !== view0) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns, verbose: true }
      );
    });

    it('insert then delete returns to original state', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 10 }),
          fc.nat(100),
          (content, pos) => {
            const crdt = new FugueCRDT(null, 'test');
            
            // Insert content
            const insertPos = pos % (crdt.getArray().length + 1);
            crdt.insertArray(insertPos, content);
            
            // Delete same content
            crdt.deleteArray(insertPos, content.length);
            
            // Should be empty
            return crdt.view() === '';
          }
        ),
        { numRuns }
      );
    });

    it('concurrent inserts at same position both appear', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('a', 'b', 'c'),
          fc.constantFrom('x', 'y', 'z'),
          fc.nat(10),
          (char1, char2, pos) => {
            const doc1 = new FugueCRDT(null, 'site1');
            const doc2 = new FugueCRDT(null, 'site2');
            
            // Concurrent inserts at position 0
            doc1.insertArray(0, [char1]);
            doc2.insertArray(0, [char2]);
            
            // Merge
            for (const u of doc2.updates) doc1.applyUpdate(u);
            for (const u of doc1.updates) doc2.applyUpdate(u);
            
            // Both should have length 2 and contain both chars
            const view = doc1.view();
            return view.length === 2 && 
                   view.includes(char1) && 
                   view.includes(char2) &&
                   doc1.view() === doc2.view();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('FugueMaxSimple', () => {
    it('all actors converge after any sequence of operations', () => {
      fc.assert(
        fc.property(
          fc.array(actionArbitrary(ACTOR_COUNT), { minLength: 1, maxLength: 100 }),
          (actions) => {
            const actors = runActions(FugueMaxSimpleCRDT, actions, ACTOR_COUNT);
            
            const view0 = actors[0].view();
            for (let i = 1; i < ACTOR_COUNT; i++) {
              if (actors[i].view() !== view0) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns, verbose: true }
      );
    });
  });

  describe('Cross-CRDT comparison', () => {
    it('both CRDTs individually converge (may have different ordering)', () => {
      fc.assert(
        fc.property(
          fc.array(actionArbitrary(2), { minLength: 1, maxLength: 50 }),
          (actions) => {
            // Apply same actions to both CRDT types
            const fugueActors = runActions(FugueCRDT, actions, 2);
            const maxSimpleActors = runActions(FugueMaxSimpleCRDT, actions, 2);
            
            // Each CRDT type should converge internally
            // (They may have different final ordering due to different tie-breaking rules)
            const fugueConverged = fugueActors[0].view() === fugueActors[1].view();
            const maxSimpleConverged = maxSimpleActors[0].view() === maxSimpleActors[1].view();
            
            return fugueConverged && maxSimpleConverged;
          }
        ),
        { numRuns: 500 }
      );
    });
  });
});
