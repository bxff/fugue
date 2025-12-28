/**
 * Coverage-Guided Fuzz Target for jsfuzz
 * 
 * This provides libfuzzer-style coverage-guided fuzzing for the Fugue CRDT.
 * Uses jsfuzz which instruments code via Istanbul for coverage feedback.
 * 
 * Run with: npx jsfuzz fuzz-target.js [corpus_dir] [options]
 * 
 * Similar to Loro's libfuzzer targets (five-actors.rs, rich-text.rs)
 */

import { FugueCRDT, FugueMaxSimpleCRDT } from './fuzzer.js';

// Action types (like Loro's enum Action)
const ACTION_INSERT = 0;
const ACTION_DELETE = 1;
const ACTION_SYNC = 2;

/**
 * Parse a buffer into an array of actions (like Loro's arbitrary derive)
 * This is similar to how libfuzzer provides mutated byte arrays that
 * get interpreted as structured actions.
 */
function parseActions(buf, actorCount) {
  const actions = [];
  let offset = 0;
  
  while (offset + 4 <= buf.length) {
    const actionType = buf[offset] % 3;
    const actor = buf[offset + 1] % actorCount;
    const pos = buf[offset + 2];
    const lenOrTarget = buf[offset + 3];
    offset += 4;
    
    if (actionType === ACTION_INSERT) {
      // Insert action: actor inserts character at pos
      const char = String.fromCharCode(97 + (pos % 26)); // a-z
      actions.push({
        type: 'insert',
        actor,
        pos,
        content: [char],
      });
    } else if (actionType === ACTION_DELETE) {
      // Delete action: actor deletes lenOrTarget chars at pos
      actions.push({
        type: 'delete',
        actor,
        pos,
        count: Math.max(1, lenOrTarget % 10),
      });
    } else {
      // Sync action: actor syncs with targetActor
      let targetActor = lenOrTarget % actorCount;
      if (targetActor === actor) {
        targetActor = (actor + 1) % actorCount;
      }
      actions.push({
        type: 'sync',
        actor,
        targetActor,
      });
    }
  }
  
  return actions;
}

/**
 * Preprocess action to ensure valid bounds (like Loro's preprocess_action)
 */
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

/**
 * Apply action to actors
 */
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

/**
 * Main fuzz target - called by jsfuzz with mutated data
 * Similar to Loro's fuzz_target!(|actions: Vec<Action>| { fuzzing(5, actions) })
 */
export function fuzz(buf) {
  const ACTOR_COUNT = 5;  // Like Loro's five-actors.rs
  
  // Skip very small inputs
  if (buf.length < 8) return;
  
  // Parse buffer into actions
  const actions = parseActions(buf, ACTOR_COUNT);
  if (actions.length === 0) return;
  
  // Create actors (using FugueCRDT)
  const actors = [];
  for (let i = 0; i < ACTOR_COUNT; i++) {
    actors.push(new FugueCRDT(null, `actor-${i}`));
  }
  
  // Apply actions (like Loro's fuzzing function)
  for (const action of actions) {
    preprocessAction(action, actors);
    applyAction(action, actors);
  }
  
  // Merge all actors pairwise (like Loro's final merge)
  for (let i = 0; i < ACTOR_COUNT; i++) {
    for (let j = i + 1; j < ACTOR_COUNT; j++) {
      const a = actors[i];
      const b = actors[j];
      
      // Sync a <- b
      for (const update of b.updates) {
        a.applyUpdate(update);
      }
      
      // Sync b <- a
      for (const update of a.updates) {
        b.applyUpdate(update);
      }
    }
  }
  
  // Verify all actors converged - this is the key assertion
  const view0 = actors[0].view();
  for (let i = 1; i < ACTOR_COUNT; i++) {
    const viewI = actors[i].view();
    if (view0 !== viewI) {
      throw new Error(
        `Convergence failure!\n` +
        `Actor 0: "${view0}"\n` +
        `Actor ${i}: "${viewI}"\n` +
        `Actions: ${JSON.stringify(actions)}`
      );
    }
  }
}
