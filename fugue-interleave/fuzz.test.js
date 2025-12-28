/**
 * Jazzer.js Coverage-Guided Fuzz Tests
 * 
 * Uses @jazzer.js/jest-runner for coverage-guided fuzzing with Jest.
 * This is the JavaScript equivalent of libfuzzer.
 * 
 * Run with: npx jest --testRunner=@jazzer.js/jest-runner fuzz.test.js
 * 
 * Or add to package.json scripts:
 *   "fuzz:coverage": "jest --testRunner=@jazzer.js/jest-runner fuzz.test.js"
 */

import { FugueCRDT, FugueMaxSimpleCRDT } from './fuzzer.js';

// Action types
const ACTION_INSERT = 0;
const ACTION_DELETE = 1;
const ACTION_SYNC = 2;

/**
 * Parse fuzzer data into structured actions
 */
function parseActions(data, actorCount) {
  const actions = [];
  let offset = 0;
  
  while (offset + 4 <= data.length) {
    const actionType = data.readUInt8(offset) % 3;
    const actor = data.readUInt8(offset + 1) % actorCount;
    const pos = data.readUInt8(offset + 2);
    const lenOrTarget = data.readUInt8(offset + 3);
    offset += 4;
    
    if (actionType === ACTION_INSERT) {
      const char = String.fromCharCode(97 + (pos % 26));
      actions.push({ type: 'insert', actor, pos, content: [char] });
    } else if (actionType === ACTION_DELETE) {
      actions.push({ type: 'delete', actor, pos, count: Math.max(1, lenOrTarget % 10) });
    } else {
      let targetActor = lenOrTarget % actorCount;
      if (targetActor === actor) targetActor = (actor + 1) % actorCount;
      actions.push({ type: 'sync', actor, targetActor });
    }
  }
  
  return actions;
}

function preprocessAction(action, actors) {
  const actor = actors[action.actor];
  const len = actor.getArray().length;

  if (action.type === 'insert') {
    action.pos = action.pos % (len + 1);
  } else if (action.type === 'delete') {
    if (len === 0) {
      action.pos = 0;
      action.count = 0;
    } else {
      action.pos = action.pos % len;
      action.count = Math.min(action.count, len - action.pos);
    }
  }
  return action;
}

function applyAction(action, actors) {
  const actor = actors[action.actor];

  if (action.type === 'insert') {
    actor.insertArray(action.pos, action.content);
  } else if (action.type === 'delete') {
    if (action.count > 0) {
      actor.deleteArray(action.pos, action.count);
    }
  } else if (action.type === 'sync') {
    const source = actors[action.targetActor];
    for (const update of source.updates) {
      actor.applyUpdate(update);
    }
  }
}

function runFuzzIteration(data, CRDTClass, actorCount = 5) {
  if (data.length < 8) return;
  
  const actions = parseActions(data, actorCount);
  if (actions.length === 0) return;
  
  const actors = [];
  for (let i = 0; i < actorCount; i++) {
    actors.push(new CRDTClass(null, `actor-${i}`));
  }
  
  for (const action of actions) {
    preprocessAction(action, actors);
    applyAction(action, actors);
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
  
  // Verify convergence
  const view0 = actors[0].view();
  for (let i = 1; i < actorCount; i++) {
    const viewI = actors[i].view();
    if (view0 !== viewI) {
      throw new Error(`Convergence failure: Actor 0="${view0}" vs Actor ${i}="${viewI}"`);
    }
  }
}

// Fuzz tests using Jazzer.js
describe('Coverage-Guided Fuzzing', () => {
  
  /**
   * @fuzz
   * Five-actor convergence test (like Loro's five-actors.rs)
   */
  it.fuzz('FugueCRDT 5-actor convergence', (data) => {
    runFuzzIteration(data, FugueCRDT, 5);
  });
  
  /**
   * @fuzz
   * Two-actor convergence test (simpler, faster)
   */
  it.fuzz('FugueCRDT 2-actor convergence', (data) => {
    runFuzzIteration(data, FugueCRDT, 2);
  });
  
  /**
   * @fuzz
   * FugueMaxSimple convergence test
   */
  it.fuzz('FugueMaxSimple 5-actor convergence', (data) => {
    runFuzzIteration(data, FugueMaxSimpleCRDT, 5);
  });
});
