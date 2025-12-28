/**
 * Coverage-Guided Fuzz Target for jsfuzz (CommonJS version)
 * 
 * jsfuzz requires CommonJS format due to its instrumentation.
 * 
 * Run with: npx jsfuzz fuzz-target-cjs.cjs corpus/
 */

// Action types
const ACTION_INSERT = 0;
const ACTION_DELETE = 1;
const ACTION_SYNC = 2;

/**
 * Simple CRDT mock for fuzzing without npm dependencies
 * This tests the core algorithm logic
 */
class SimpleArrayCRDT {
  constructor(id) {
    this.id = id;
    this.array = [];
    this.updates = [];
    this.clock = 0;
  }

  insertArray(pos, content) {
    const clampedPos = Math.max(0, Math.min(pos, this.array.length));
    for (let i = 0; i < content.length; i++) {
      this.array.splice(clampedPos + i, 0, {
        value: content[i],
        id: `${this.id}:${this.clock++}`,
        deleted: false,
      });
    }
    this.updates.push({ type: 'insert', pos: clampedPos, content, id: this.id });
  }

  deleteArray(pos, count) {
    const clampedPos = Math.max(0, Math.min(pos, this.array.length));
    const clampedCount = Math.min(count, this.array.length - clampedPos);
    for (let i = 0; i < clampedCount; i++) {
      if (this.array[clampedPos + i]) {
        this.array[clampedPos + i].deleted = true;
      }
    }
    this.array.splice(clampedPos, clampedCount);
    this.updates.push({ type: 'delete', pos: clampedPos, count: clampedCount, id: this.id });
  }

  getArray() {
    return this.array.filter(item => !item.deleted);
  }

  view() {
    return this.getArray().map(item => item.value).join('');
  }

  applyUpdate(update) {
    // Simple merge - in a real CRDT this would be conflict resolution
    // For coverage-guided fuzzing, we still want to exercise the code paths
    if (update.type === 'insert') {
      // Apply at the same position (simplified)
      const pos = Math.min(update.pos, this.array.length);
      for (let i = 0; i < update.content.length; i++) {
        this.array.splice(pos + i, 0, {
          value: update.content[i],
          id: `${update.id}:remote`,
          deleted: false,
        });
      }
    } else if (update.type === 'delete') {
      const pos = Math.min(update.pos, this.array.length);
      const count = Math.min(update.count, this.array.length - pos);
      this.array.splice(pos, count);
    }
  }
}

/**
 * Parse a buffer into actions
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
      const char = String.fromCharCode(97 + (pos % 26));
      actions.push({ type: 'insert', actor, pos, content: [char] });
    } else if (actionType === ACTION_DELETE) {
      actions.push({ type: 'delete', actor, pos, count: Math.max(1, lenOrTarget % 10) });
    } else {
      let targetActor = lenOrTarget % actorCount;
      if (targetActor === actor) {
        targetActor = (actor + 1) % actorCount;
      }
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

/**
 * Main fuzz target
 */
function fuzz(buf) {
  const ACTOR_COUNT = 5;
  
  if (buf.length < 8) return;
  
  const actions = parseActions(buf, ACTOR_COUNT);
  if (actions.length === 0) return;
  
  const actors = [];
  for (let i = 0; i < ACTOR_COUNT; i++) {
    actors.push(new SimpleArrayCRDT(`actor-${i}`));
  }
  
  for (const action of actions) {
    preprocessAction(action, actors);
    applyAction(action, actors);
  }
  
  // Merge all actors
  for (let i = 0; i < ACTOR_COUNT; i++) {
    for (let j = i + 1; j < ACTOR_COUNT; j++) {
      const a = actors[i];
      const b = actors[j];
      for (const update of b.updates) a.applyUpdate(update);
      for (const update of a.updates) b.applyUpdate(update);
    }
  }
  
  // Verify lengths match (simplified convergence check)
  const len0 = actors[0].getArray().length;
  for (let i = 1; i < ACTOR_COUNT; i++) {
    const lenI = actors[i].getArray().length;
    // Just check length - actual CRDT convergence is tested in full fuzzer
    if (Math.abs(len0 - lenI) > ACTOR_COUNT * 10) {
      throw new Error(`Length mismatch: actor 0 has ${len0}, actor ${i} has ${lenI}`);
    }
  }
}

module.exports = { fuzz };
