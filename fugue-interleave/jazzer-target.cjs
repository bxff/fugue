/**
 * Jazzer.js Coverage-Guided Fuzz Target
 * 
 * Uses libFuzzer under the hood for true coverage-guided fuzzing.
 * 
 * Run: npx @jazzer.js/core jazzer-target.cjs corpus/ -i=fuzzer.js -i=index.js
 */

// Must use CommonJS for Jazzer.js
const ACTION_INSERT = 0;
const ACTION_DELETE = 1;
const ACTION_SYNC = 2;
const ACTOR_COUNT = 5;

// Inline simple CRDT implementation for fuzzing without ESM issues
class SimpleCRDT {
  constructor(id) {
    this.id = id;
    this.array = [];
    this.updates = [];
    this.clock = 0;
  }

  insertArray(pos, content) {
    const clampedPos = Math.max(0, Math.min(pos, this.array.length));
    for (let i = 0; i < content.length; i++) {
      const item = {
        value: content[i],
        id: { site: this.id, seq: this.clock++ },
        deleted: false,
      };
      this.array.splice(clampedPos + i, 0, item);
      this.updates.push({ type: 'ins', pos: clampedPos + i, item: { ...item } });
    }
  }

  deleteArray(pos, count) {
    if (this.array.length === 0) return;
    const clampedPos = Math.max(0, Math.min(pos, this.array.length - 1));
    const clampedCount = Math.min(count, this.array.length - clampedPos);
    
    for (let i = 0; i < clampedCount; i++) {
      const item = this.array[clampedPos + i];
      if (item) {
        this.updates.push({ type: 'del', itemId: { ...item.id } });
      }
    }
    this.array.splice(clampedPos, clampedCount);
  }

  getArray() {
    return this.array.filter(item => !item.deleted);
  }

  view() {
    return this.getArray().map(item => item.value).join('');
  }

  applyUpdate(update) {
    if (update.type === 'ins') {
      // Check if already applied
      const exists = this.array.some(
        item => item.id.site === update.item.id.site && item.id.seq === update.item.id.seq
      );
      if (!exists) {
        const pos = Math.min(update.pos, this.array.length);
        this.array.splice(pos, 0, { ...update.item });
      }
    } else if (update.type === 'del') {
      const idx = this.array.findIndex(
        item => item.id.site === update.itemId.site && item.id.seq === update.itemId.seq
      );
      if (idx >= 0) {
        this.array.splice(idx, 1);
      }
    }
  }
}

function parseActions(buf) {
  const actions = [];
  let offset = 0;
  
  while (offset + 4 <= buf.length) {
    const actionType = buf[offset] % 3;
    const actor = buf[offset + 1] % ACTOR_COUNT;
    const pos = buf[offset + 2];
    const lenOrTarget = buf[offset + 3];
    offset += 4;
    
    if (actionType === ACTION_INSERT) {
      const char = String.fromCharCode(97 + (pos % 26));
      actions.push({ type: 'insert', actor, pos, content: [char] });
    } else if (actionType === ACTION_DELETE) {
      actions.push({ type: 'delete', actor, pos, count: Math.max(1, lenOrTarget % 10) });
    } else {
      let targetActor = lenOrTarget % ACTOR_COUNT;
      if (targetActor === actor) {
        targetActor = (actor + 1) % ACTOR_COUNT;
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
    return { ...action, pos: len === 0 ? 0 : action.pos % (len + 1) };
  } else if (action.type === 'delete') {
    if (len === 0) {
      return { ...action, pos: 0, count: 0 };
    }
    return {
      ...action,
      pos: action.pos % len,
      count: Math.min(action.count, len - (action.pos % len)),
    };
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
 * Main fuzz target - called by Jazzer.js with mutated data
 * @param {Buffer} data - Fuzzer-generated input
 */
module.exports.fuzz = function(data) {
  if (data.length < 8) return;
  
  const actions = parseActions(data);
  if (actions.length === 0) return;
  
  // Create actors
  const actors = [];
  for (let i = 0; i < ACTOR_COUNT; i++) {
    actors.push(new SimpleCRDT(`actor-${i}`));
  }
  
  // Apply actions
  for (const action of actions) {
    const processedAction = preprocessAction(action, actors);
    applyAction(processedAction, actors);
  }
  
  // Final merge - all pairs
  for (let i = 0; i < ACTOR_COUNT; i++) {
    for (let j = i + 1; j < ACTOR_COUNT; j++) {
      const a = actors[i];
      const b = actors[j];
      for (const update of b.updates) a.applyUpdate(update);
      for (const update of a.updates) b.applyUpdate(update);
    }
  }
  
  // CONVERGENCE ASSERTION - This is what we're fuzzing for!
  const view0 = actors[0].view();
  for (let i = 1; i < ACTOR_COUNT; i++) {
    const viewI = actors[i].view();
    if (view0 !== viewI) {
      throw new Error(
        `CONVERGENCE BUG FOUND!\n` +
        `Actor 0: "${view0}"\n` +
        `Actor ${i}: "${viewI}"\n` +
        `Input hex: ${data.toString('hex')}`
      );
    }
  }
};
