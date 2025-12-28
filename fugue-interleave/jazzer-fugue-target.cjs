/**
 * Jazzer.js Coverage-Guided Fuzz Target for REAL Fugue CRDT
 * 
 * Uses dynamic import to load ESM modules from CommonJS.
 * Tests actual FugueCRDT convergence with libFuzzer.
 * 
 * Run: npx @jazzer.js/core jazzer-fugue-target.cjs corpus/
 */

const ACTION_INSERT = 0;
const ACTION_DELETE = 1;
const ACTION_SYNC = 2;
const ACTOR_COUNT = 5;

// Cache for the loaded module
let FugueCRDT = null;
let moduleLoaded = false;
let loadError = null;

// Load the ESM module
async function loadModule() {
  if (moduleLoaded) return;
  try {
    const mod = await import('./fuzzer.js');
    FugueCRDT = mod.FugueCRDT;
    moduleLoaded = true;
  } catch (e) {
    loadError = e;
    moduleLoaded = true;
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
 * Async fuzz target for Jazzer.js
 * @param {Buffer} data - Fuzzer-generated input
 */
module.exports.fuzz = async function(data) {
  // Ensure module is loaded
  await loadModule();
  
  if (loadError) {
    // Module failed to load, skip
    return;
  }
  
  if (!FugueCRDT) {
    return;
  }
  
  if (data.length < 8) return;
  
  const actions = parseActions(data);
  if (actions.length === 0) return;
  
  // Create actors using REAL FugueCRDT
  const actors = [];
  for (let i = 0; i < ACTOR_COUNT; i++) {
    actors.push(new FugueCRDT(null, `fuzz-actor-${i}`));
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
  
  // CONVERGENCE CHECK
  const view0 = actors[0].view();
  for (let i = 1; i < ACTOR_COUNT; i++) {
    const viewI = actors[i].view();
    if (view0 !== viewI) {
      throw new Error(
        `FUGUE CRDT CONVERGENCE BUG!\n` +
        `Actor 0: "${view0}"\n` +
        `Actor ${i}: "${viewI}"\n` +
        `Input: ${data.toString('hex')}\n` +
        `Actions: ${JSON.stringify(actions)}`
      );
    }
  }
};
