// Property-based trace fuzzer for Fugue/FugueMax tombstone behavior.
//
// This file has one generator: arbitrary legal multi-replica traces containing
// inserts, deletes, and causally valid deliveries. Sensors consume the trace;
// they do not generate N1/N2/etc. shapes. The default benchmark contains the
// filtered visible defects published FugueMax actually fails: atomic-delivery
// and staged-delivery ghost transformations. Repair-preservation controls are
// a separate profile, including local structural normalization, N7's commuting
// square, referenced-history preservation, and reverse-RO bucketing over
// arbitrary settled contexts.

import { pathToFileURL } from "node:url";
import { CRuntime } from "@collabs/collabs";
import seedrandom from "seedrandom";

const START = "<start>";
const END = "<end>";
const decoder = new TextDecoder();

function extractPrimitive(message) {
  const text = decoder.decode(message);
  for (const marker of ['{"type":"insert"', '{"type":"delete"']) {
    const start = text.indexOf(marker);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function structuralBucket(message) {
  const primitive = extractPrimitive(message);
  if (primitive?.type !== "insert") return null;
  const id = (value) => value === null
    ? END
    : `${value?.sender ?? "?"}:${value?.counter ?? "?"}`;
  return primitive.side === "L"
    ? `L:parent/RO=${id(primitive.parent)}`
    : `R:parent/LO=${id(primitive.parent)}:RO=${id(primitive.rightOrigin)}`;
}

function parseOptions(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  const integer = (name, fallback, minimum = 0) => {
    const parsed = Number.parseInt(value(name, String(fallback)), 10);
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw new Error(`${name} must be an integer >= ${minimum}`);
    }
    return parsed;
  };
  const mode = value("--mode", "report");
  if (!new Set(["report", "check"]).has(mode)) {
    throw new Error("--mode must be report or check");
  }
  const sensor = value("--sensor", null);
  const sensors = new Set([
    "ghost-neutrality",
    "staged-ghost-neutrality",
    "local-ghost-neutrality",
    "delete-insert-commutation",
    "referenced-tombstone",
    "reverse-ro-buckets",
    "step-projection",
    "forward-non-interleaving",
    "backward-non-interleaving",
    "convergence",
  ]);
  if (sensor !== null && !sensors.has(sensor)) throw new Error(`Unknown --sensor ${sensor}`);
  const profile = value("--profile", "published-bugs");
  if (!new Set(["published-bugs", "controls", "required", "all"]).has(profile)) {
    throw new Error("--profile must be published-bugs, controls, required, or all");
  }
  const selectedTrace = argv.includes("--trace") ? integer("--trace", 0) : null;
  const expectCounterexample = value("--expect-counterexample", null);
  if (expectCounterexample !== null && !sensors.has(expectCounterexample)) {
    throw new Error(`Unknown --expect-counterexample ${expectCounterexample}`);
  }
  return {
    module: value("--module", "fugue-max-canonical"),
    exportName: value("--export", "FugueMaxSimple"),
    seed: value("--seed", "general-tombstone-traces-v1"),
    traces: integer("--traces", 100, 1),
    steps: integer("--steps", 30, 1),
    clients: integer("--clients", 3, 2),
    ghostTrials: integer("--ghost-trials", 3, 0),
    commutationTrials: integer("--commutation-trials", 3, 0),
    bucketTrials: integer("--bucket-trials", 3, 0),
    maxFailures: integer("--max-failures", 5, 1),
    selectedTrace,
    expectCounterexample,
    sensor,
    profile,
    mode,
    json: argv.includes("--json"),
  };
}

function makeRng(seed) {
  const random = seedrandom(seed);
  return {
    float: random,
    integer(minimum, maximum) {
      return minimum + Math.floor(random() * (maximum - minimum + 1));
    },
    pick(values) {
      return values[this.integer(0, values.length - 1)];
    },
  };
}

function equal(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function removeToken(values, token) {
  return values.filter((value) => value !== token);
}

class Doc {
  constructor(replicaID, ListClass) {
    this.runtime = new CRuntime({ debugReplicaID: replicaID });
    this.pendingUpdates = [];
    this.runtime.on("Send", ({ message }) => this.pendingUpdates.push(new Uint8Array(message)));
    this.list = this.runtime.registerCollab("array", (init) => new ListClass(init));
  }

  insert(index, value) {
    this.runtime.transact(() => this.list.insert(index, value));
    return this.takeUpdate();
  }

  delete(index) {
    this.runtime.transact(() => this.list.delete(index, 1));
    return this.takeUpdate();
  }

  receive(update) {
    this.runtime.receive(update);
  }

  markSent() {
    this.list.markLocalUpdatesSent?.();
  }

  capturePublicationFrontier() {
    return this.list.captureLocalPublicationFrontier?.();
  }

  markSentThrough(frontier) {
    this.list.markLocalUpdatesSent?.(frontier);
  }

  takeUpdate() {
    const update = this.pendingUpdates.shift();
    if (update === undefined) throw new Error("A local operation emitted no update");
    if (this.pendingUpdates.length !== 0) throw new Error("A local operation emitted multiple updates");
    return update;
  }

  get values() {
    return [...this.list.values()];
  }
}

class TraceWorld {
  constructor(ListClass, actorIDs) {
    this.ListClass = ListClass;
    this.actorIDs = actorIDs;
    this.docs = new Map(actorIDs.map((id) => [id, new Doc(id, ListClass)]));
    this.known = new Map(actorIDs.map((id) => [id, new Set()]));
    this.localSequence = new Map(actorIDs.map((id) => [id, 0]));
    this.updates = new Map();
    this.creationCounter = 0;
  }

  values(actor) {
    return this.docs.get(actor).values;
  }

  local(command, ghostDependent = false) {
    const actor = command.actor;
    const doc = this.docs.get(actor);
    const before = doc.values;
    let bytes;
    if (command.kind === "insert") {
      if (command.index < 0 || command.index > before.length) {
        throw new Error(`Invalid replay insertion index ${command.index}`);
      }
      bytes = doc.insert(command.index, command.token);
    } else {
      const index = before.indexOf(command.token);
      if (index === -1) throw new Error(`Replay cannot delete missing ${command.token}`);
      bytes = doc.delete(index);
    }

    const sequence = this.localSequence.get(actor);
    this.localSequence.set(actor, sequence + 1);
    const key = `${actor}:${sequence}`;
    if (command.key !== undefined && command.key !== key) {
      throw new Error(`Replay key mismatch: expected ${command.key}, generated ${key}`);
    }
    const update = {
      key,
      actor,
      bytes,
      publicationFrontier: doc.capturePublicationFrontier(),
      action: { kind: command.kind, token: command.token },
      dependencies: new Set(this.known.get(actor)),
      creationIndex: this.creationCounter++,
      ghostDependent,
      handedOff: false,
    };
    this.updates.set(key, update);
    this.known.get(actor).add(key);
    return { before, after: doc.values, update };
  }

  canDeliver(actor, key) {
    const update = this.updates.get(key);
    if (
      update === undefined ||
      !update.handedOff ||
      this.known.get(actor).has(key)
    ) return false;
    for (const dependency of update.dependencies) {
      if (!this.known.get(actor).has(dependency)) return false;
    }
    return true;
  }

  deliver(actor, key) {
    if (!this.canDeliver(actor, key)) throw new Error(`Illegal delivery of ${key} to ${actor}`);
    const update = this.updates.get(key);
    const doc = this.docs.get(actor);
    const before = doc.values;
    doc.receive(update.bytes);
    this.known.get(actor).add(key);
    return { before, after: doc.values, update };
  }

  handoff(actor, key) {
    const update = this.updates.get(key);
    if (update === undefined || update.actor !== actor || update.handedOff) {
      throw new Error(`Illegal handoff of ${key} by ${actor}`);
    }
    this.docs.get(actor).markSentThrough(update.publicationFrontier);
    // The selected update is the outbox prefix boundary. Mark by the trace's
    // own per-actor creation order instead of comparing CRDT-private frontier
    // values; the latter are opaque tokens from the implementation under
    // test, not part of the fuzzer's scheduling model.
    for (const candidate of this.updates.values()) {
      if (
        candidate.actor === actor &&
        candidate.creationIndex <= update.creationIndex
      ) candidate.handedOff = true;
    }
    return update;
  }

  availableHandoffs() {
    const handoffs = [];
    for (const [key, update] of this.updates) {
      if (!update.handedOff) handoffs.push({ kind: "handoff", actor: update.actor, key });
    }
    return handoffs;
  }

  availableDeliveries() {
    const deliveries = [];
    for (const actor of this.actorIDs) {
      for (const key of this.updates.keys()) {
        if (this.canDeliver(actor, key)) deliveries.push({ kind: "deliver", actor, key });
      }
    }
    return deliveries;
  }

  isSettled() {
    return this.actorIDs.every((actor) => this.known.get(actor).size === this.updates.size);
  }
}

function addEvent(trace, commandIndex, command, result, local) {
  trace.logs.get(command.actor).push({
    commandIndex,
    local,
    action: result.update.action,
    state: result.after,
  });
}

function generateTrace(ListClass, seed, options) {
  const rng = makeRng(seed);
  const actorIDs = Array.from({ length: options.clients }, (_, index) => `r${index}`);
  const world = new TraceWorld(ListClass, actorIDs);
  const trace = {
    seed,
    generation: { clients: options.clients, steps: options.steps, module: options.module },
    actorIDs,
    commands: [],
    logs: new Map(actorIDs.map((actor) => [actor, []])),
    characters: new Map(),
    randomCommandCount: 0,
  };
  let tokenCounter = 0;

  const execute = (command) => {
    const commandIndex = trace.commands.length;
    trace.commands.push(command);
    if (command.kind === "handoff") {
      world.handoff(command.actor, command.key);
      return;
    }
    if (command.kind === "deliver") {
      addEvent(trace, commandIndex, command, world.deliver(command.actor, command.key), false);
      return;
    }

    const before = world.values(command.actor);
    if (command.kind === "insert") {
      command.leftOrigin = command.index === 0 ? START : before[command.index - 1];
      command.rightOrigin = command.index === before.length ? END : before[command.index];
      trace.characters.set(command.token, {
        token: command.token,
        leftOrigin: command.leftOrigin,
        rightOrigin: command.rightOrigin,
      });
    }
    const result = world.local(command);
    command.key = result.update.key;
    addEvent(trace, commandIndex, command, result, true);
  };

  for (let step = 0; step < options.steps; step++) {
    const handoffs = world.availableHandoffs();
    const deliveries = world.availableDeliveries();
    const deletableActors = actorIDs.filter((actor) => world.values(actor).length !== 0);
    const roll = rng.float();
    if (handoffs.length !== 0 && roll < 0.18) {
      execute(rng.pick(handoffs));
    } else if (deliveries.length !== 0 && roll < 0.40) {
      execute(rng.pick(deliveries));
    } else if (deletableActors.length !== 0 && roll < 0.58) {
      const actor = rng.pick(deletableActors);
      execute({ kind: "delete", actor, token: rng.pick(world.values(actor)) });
    } else {
      const actor = rng.pick(actorIDs);
      const index = rng.integer(0, world.values(actor).length);
      execute({ kind: "insert", actor, index, token: `t${tokenCounter++}` });
    }
  }
  trace.randomCommandCount = trace.commands.length;

  while (!world.isSettled()) {
    const handoffs = world.availableHandoffs();
    if (handoffs.length !== 0) {
      execute(rng.pick(handoffs));
      continue;
    }
    const deliveries = world.availableDeliveries();
    if (deliveries.length === 0) throw new Error("Causal delivery drain is stuck");
    execute(rng.pick(deliveries));
  }
  trace.finalStates = Object.fromEntries(actorIDs.map((actor) => [actor, world.values(actor)]));
  return trace;
}

function checkStepProjection(trace) {
  for (const [actor, events] of trace.logs) {
    let before = [];
    for (const event of events) {
      const { action, state: after } = event;
      const expected = action.kind === "insert" ? before : removeToken(before, action.token);
      const projected = action.kind === "insert" ? removeToken(after, action.token) : after;
      const tokenCount = after.filter((token) => token === action.token).length;
      const pass = equal(projected, expected) && (action.kind !== "insert" || tokenCount === 1);
      if (!pass) {
        return failure("step-projection", trace, {
          actor,
          commandIndex: event.commandIndex,
          action,
          before,
          after,
          expected: action.kind === "insert"
            ? "adding the inserted token leaves all existing tokens in their prior order"
            : "deleting a token is exactly projection through that token",
        });
      }
      before = after;
    }
  }
  return null;
}

function buildObservedOrder(trace) {
  const edges = new Map();
  const ensure = (token) => {
    if (!edges.has(token)) edges.set(token, new Set());
  };
  for (const events of trace.logs.values()) {
    for (const { state } of events) {
      for (const token of state) ensure(token);
      for (let left = 0; left < state.length; left++) {
        for (let right = left + 1; right < state.length; right++) edges.get(state[left]).add(state[right]);
      }
    }
  }
  const closure = new Set();
  for (const source of edges.keys()) {
    const pending = [...edges.get(source)];
    const reached = new Set();
    while (pending.length !== 0) {
      const target = pending.pop();
      if (reached.has(target)) continue;
      reached.add(target);
      for (const next of edges.get(target) ?? []) pending.push(next);
    }
    for (const target of reached) closure.add(`${source}\u0000${target}`);
  }
  return { before: (left, right) => closure.has(`${left}\u0000${right}`) };
}

function groupByOrigin(trace, field) {
  const groups = new Map();
  for (const character of trace.characters.values()) {
    const origin = character[field];
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin).push(character.token);
  }
  return groups;
}

function checkForwardNonInterleaving(trace) {
  const order = buildObservedOrder(trace);
  const byLeftOrigin = groupByOrigin(trace, "leftOrigin");
  for (const [actor, events] of trace.logs) {
    const observed = new Set();
    for (const event of events) {
      if (event.action.kind === "insert") observed.add(event.action.token);
      for (const token of event.state) observed.add(token);
      const state = event.state;
      for (const B of state) {
        const A = trace.characters.get(B)?.leftOrigin;
        if (A === undefined || A === START || !state.includes(A)) continue;
        let premiseCertain = true;
        for (const sibling of byLeftOrigin.get(A) ?? []) {
          if (sibling === B || !observed.has(sibling)) continue;
          if (order.before(sibling, B) || !order.before(B, sibling)) {
            premiseCertain = false;
            break;
          }
        }
        if (premiseCertain && state.indexOf(A) + 1 !== state.indexOf(B)) {
          return failure("forward-non-interleaving", trace, {
            actor,
            commandIndex: event.commandIndex,
            A,
            B,
            state,
            expected: `${A} and its provably earliest observed left-origin child ${B} are adjacent`,
          });
        }
      }
    }
  }
  return null;
}

function checkBackwardNonInterleaving(trace) {
  const order = buildObservedOrder(trace);
  const byRightOrigin = groupByOrigin(trace, "rightOrigin");
  for (const [actor, events] of trace.logs) {
    const observed = new Set();
    for (const event of events) {
      if (event.action.kind === "insert") observed.add(event.action.token);
      for (const token of event.state) observed.add(token);
      const state = event.state;
      for (const A of state) {
        const characterA = trace.characters.get(A);
        const B = characterA?.rightOrigin;
        if (B === undefined || B === END || !state.includes(B)) continue;
        const characterB = trace.characters.get(B);
        // Sound subset of condition 2: equal LOs rule out theorem 5.
        if (characterA.leftOrigin !== characterB?.leftOrigin) continue;
        let premiseCertain = true;
        for (const sibling of byRightOrigin.get(B) ?? []) {
          if (sibling === A || !observed.has(sibling)) continue;
          if (order.before(A, sibling) || !order.before(sibling, A)) {
            premiseCertain = false;
            break;
          }
        }
        if (premiseCertain && state.indexOf(A) + 1 !== state.indexOf(B)) {
          return failure("backward-non-interleaving", trace, {
            actor,
            commandIndex: event.commandIndex,
            A,
            B,
            state,
            expected: `${A} and its right origin ${B} are adjacent when ${A} is provably latest and theorem 5 cannot apply`,
          });
        }
      }
    }
  }
  return null;
}

function checkConvergence(trace) {
  const entries = Object.entries(trace.finalStates);
  const reference = entries[0][1];
  if (entries.every(([, state]) => equal(state, reference))) return null;
  return failure("convergence", trace, {
    finalStates: trace.finalStates,
    expected: "all replicas agree after every generated update is causally delivered",
  });
}

function executeReplayCommand(world, command, ghostDependent = false) {
  if (command.kind === "deliver") return world.deliver(command.actor, command.key);
  if (command.kind === "handoff") return world.handoff(command.actor, command.key);
  return world.local(command, ghostDependent);
}

function firstStateDifference(baseline, mutant) {
  for (const actor of baseline.actorIDs) {
    const left = baseline.values(actor);
    const right = mutant.values(actor);
    if (!equal(left, right)) return { actor, baseline: left, withGhost: right };
  }
  return null;
}

function replayWithInvisibleGhost(ListClass, trace, trialSeed, trialIndex) {
  const rng = makeRng(trialSeed);
  const baseline = new TraceWorld(ListClass, trace.actorIDs);
  const mutant = new TraceWorld(ListClass, trace.actorIDs);
  const cut = rng.integer(0, Math.max(0, trace.randomCommandCount - 1));
  const sponsor = rng.pick(trace.actorIDs);
  const gapFraction = rng.float();
  const ghostReplica = `${rng.float() < 0.5 ? "a" : "z"}-ghost-${trialIndex}`;
  const ghostToken = `ghost-${trialIndex}`;
  const hasGhost = new Set();
  let ghost = null;

  const makeFailure = (commandIndex, reason, difference, extra = {}) => failure("ghost-neutrality", trace, {
    trialSeed,
    trialIndex,
    cut,
    commandIndex,
    reason,
    sponsor,
    ghostReplica,
    ghostToken,
    ghostLeftOrigin: ghost.leftOrigin,
    ghostRightOrigin: ghost.rightOrigin,
    ...extra,
    ...difference,
    expected: "adding atomically delivered, never-visible insert+delete history changes no surviving-token order",
  });

  const deliverGhost = (actor, commandIndex, reason) => {
    if (hasGhost.has(actor)) return null;
    for (const dependency of ghost.dependencies) {
      if (!mutant.known.get(actor).has(dependency)) {
        throw new Error(`Ghost delivery to ${actor} is missing dependency ${dependency}`);
      }
    }
    const doc = mutant.docs.get(actor);
    doc.receive(ghost.insert);
    doc.receive(ghost.deletion);
    hasGhost.add(actor);
    const difference = firstStateDifference(baseline, mutant);
    return difference === null ? null : makeFailure(commandIndex, reason, difference);
  };

  const createGhost = (commandIndex) => {
    const sponsorState = mutant.values(sponsor);
    const position = Math.min(sponsorState.length, Math.floor(gapFraction * (sponsorState.length + 1)));
    const dependencies = new Set(mutant.known.get(sponsor));
    const ghostDoc = new Doc(ghostReplica, ListClass);
    const knownUpdates = [...dependencies]
      .map((key) => mutant.updates.get(key))
      .sort((left, right) => left.creationIndex - right.creationIndex);
    for (const update of knownUpdates) ghostDoc.receive(update.bytes);
    if (!equal(ghostDoc.values, sponsorState)) {
      throw new Error("Reconstructed ghost author does not match its sponsor causal cut");
    }
    ghost = {
      dependencies,
      leftOrigin: position === 0 ? START : sponsorState[position - 1],
      rightOrigin: position === sponsorState.length ? END : sponsorState[position],
      insert: ghostDoc.insert(position, ghostToken),
      deletion: null,
    };
    ghost.deletion = ghostDoc.delete(position);
    return deliverGhost(sponsor, commandIndex, "initial atomic delivery");
  };

  for (let commandIndex = 0; commandIndex < trace.commands.length; commandIndex++) {
    if (commandIndex === cut) {
      const found = createGhost(commandIndex);
      if (found !== null) return found;
    }
    const command = trace.commands[commandIndex];
    if (command.kind === "deliver") {
      const update = mutant.updates.get(command.key);
      if (update.ghostDependent && !hasGhost.has(command.actor)) {
        const found = deliverGhost(command.actor, commandIndex, "causal delivery before a dependent update");
        if (found !== null) return found;
      }
    }
    executeReplayCommand(baseline, command);
    executeReplayCommand(mutant, command, command.kind !== "deliver" && hasGhost.has(command.actor));
    const difference = firstStateDifference(baseline, mutant);
    if (difference !== null) {
      return makeFailure(commandIndex, "same base command after atomic ghost delivery", difference, { command });
    }
  }

  if (ghost === null) {
    const found = createGhost(trace.commands.length);
    if (found !== null) return found;
  }
  for (const actor of trace.actorIDs) {
    const found = deliverGhost(actor, trace.commands.length, "final atomic delivery");
    if (found !== null) return found;
  }
  return null;
}

function replayTrace(ListClass, trace) {
  const world = new TraceWorld(ListClass, trace.actorIDs);
  for (const command of trace.commands) executeReplayCommand(world, command);
  return world;
}

function settledExtension(ListClass, trace) {
  const base = replayTrace(ListClass, trace);
  const initial = base.values(trace.actorIDs[0]);
  const baseUpdates = [...base.updates.values()].sort(
    (left, right) => left.creationIndex - right.creationIndex
  );
  const clone = (replicaID) => {
    const doc = new Doc(replicaID, ListClass);
    for (const update of baseUpdates) doc.receive(update.bytes);
    if (!equal(doc.values, initial)) throw new Error("Settled extension clone disagrees with the base trace");
    return doc;
  };
  return { initial, clone };
}

function checkReverseROBuckets(ListClass, trace, trialSeed, trialIndex) {
  const rng = makeRng(trialSeed);
  const { initial, clone } = settledExtension(ListClass, trace);
  const insertionIndex = initial.length;
  const boundaryCount = rng.integer(2, 5);
  const anchorToken = `bucket-anchor-${trialIndex}`;
  const anchor = clone(`a-bucket-anchor-${trialIndex}`);
  const anchorUpdate = anchor.insert(insertionIndex, anchorToken);

  const boundaries = [];
  for (let index = 0; index < boundaryCount; index++) {
    const token = `bucket-ro-${trialIndex}-${index}`;
    const author = clone(`b-bucket-ro-${trialIndex}-${index}`);
    boundaries.push({ token, update: author.insert(insertionIndex, token) });
  }

  // Derive the actual order of the right origins instead of assuming how the
  // implementation orders the concurrently created boundary nodes.
  const skeleton = clone(`bucket-skeleton-${trialIndex}`);
  skeleton.receive(anchorUpdate);
  for (const boundary of boundaries) skeleton.receive(boundary.update);
  const boundaryOrder = skeleton.values.filter((token) =>
    boundaries.some((boundary) => boundary.token === token)
  );
  if (skeleton.values.indexOf(anchorToken) > skeleton.values.indexOf(boundaryOrder[0])) {
    throw new Error("Bucket anchor did not sort before its generated boundaries");
  }

  const buckets = [
    { key: END, boundary: null },
    ...boundaries.map((boundary) => ({ key: boundary.token, boundary })),
  ];
  const items = [];
  const itemBucket = new Map();
  for (const [bucketIndex, bucket] of buckets.entries()) {
    const width = rng.integer(1, 3);
    for (let itemIndex = 0; itemIndex < width; itemIndex++) {
      const token = `bucket-item-${trialIndex}-${bucketIndex}-${itemIndex}`;
      const author = clone(`m-bucket-item-${trialIndex}-${bucketIndex}-${itemIndex}`);
      author.receive(anchorUpdate);
      if (bucket.boundary !== null) author.receive(bucket.boundary.update);
      const update = author.insert(insertionIndex + 1, token);
      items.push({ token, update, bucket: bucket.key });
      itemBucket.set(token, bucket.key);
    }
  }

  const merged = clone(`z-bucket-merge-${trialIndex}`);
  merged.receive(anchorUpdate);
  for (const boundary of boundaries) merged.receive(boundary.update);
  // Vary delivery order independently of the expected bucket order.
  const pending = [...items];
  while (pending.length !== 0) {
    const index = rng.integer(0, pending.length - 1);
    merged.receive(pending.splice(index, 1)[0].update);
  }

  const actualBuckets = merged.values
    .filter((token) => itemBucket.has(token))
    .map((token) => itemBucket.get(token));
  const expectedBucketOrder = [END, ...[...boundaryOrder].reverse()];
  const expectedBuckets = expectedBucketOrder.flatMap((key) =>
    items.filter((item) => item.bucket === key).map(() => key)
  );
  if (equal(actualBuckets, expectedBuckets)) return null;
  return failure("reverse-ro-buckets", trace, {
    trialSeed,
    trialIndex,
    commandIndex: trace.commands.length,
    anchorToken,
    boundaryOrder,
    expectedBucketOrder,
    actualBuckets,
    expectedBuckets,
    merged: merged.values,
    expected: "for one LO, exact-RO buckets are contiguous and ordered by descending right-origin position, with END first",
  });
}

/**
 * The sender-side form of ghost neutrality. Starting from an arbitrary
 * settled history, compare a normal insertion with the same insertion after
 * that author locally inserted and deleted an otherwise unpublished token.
 * Concurrent witnesses make any leaked tree/bucket difference observable.
 */
function checkLocalGhostNeutrality(ListClass, trace, trialSeed, trialIndex) {
  const rng = makeRng(trialSeed);
  const { initial, clone } = settledExtension(ListClass, trace);
  const gap = rng.integer(0, initial.length);
  const ghostToken = `local-ghost-${trialIndex}`;
  const insertedToken = `local-after-ghost-${trialIndex}`;
  const authorID = `local-ghost-author-${trialIndex}`;

  const witnesses = Array.from(
    { length: rng.integer(1, 3) },
    (_, index) => {
      const token = `local-ghost-witness-${trialIndex}-${index}`;
      const author = clone(`local-ghost-witness-author-${trialIndex}-${index}`);
      return { token, update: author.insert(gap, token) };
    }
  );

  const baselineAuthor = clone(authorID);
  const baselineInsert = baselineAuthor.insert(gap, insertedToken);

  const mutantAuthor = clone(authorID);
  const ghostInsert = mutantAuthor.insert(gap, ghostToken);
  const ghostDelete = mutantAuthor.delete(gap);
  const afterGhost = mutantAuthor.insert(gap, insertedToken);

  const mergeBranch = (replicaID, updates) => {
    const merged = clone(replicaID);
    // Witness order is deliberately independent of the branch operations.
    const pending = [...witnesses];
    while (pending.length !== 0) {
      const index = rng.integer(0, pending.length - 1);
      merged.receive(pending.splice(index, 1)[0].update);
    }
    for (const update of updates) merged.receive(update);
    return merged.values;
  };

  const baseline = mergeBranch(`merge-local-ghost-base-${trialIndex}`, [
    baselineInsert,
  ]);
  const withGhost = mergeBranch(`merge-local-ghost-mutant-${trialIndex}`, [
    ghostInsert,
    ghostDelete,
    afterGhost,
  ]);
  const baselineBucket = structuralBucket(baselineInsert);
  const afterGhostBucket = structuralBucket(afterGhost);
  if (equal(baseline, withGhost) && baselineBucket === afterGhostBucket) {
    return null;
  }
  return failure("local-ghost-neutrality", trace, {
    trialSeed,
    trialIndex,
    commandIndex: trace.commands.length,
    gap,
    predecessor: gap === 0 ? START : initial[gap - 1],
    successor: gap === initial.length ? END : initial[gap],
    ghostToken,
    insertedToken,
    witnessTokens: witnesses.map(({ token }) => token),
    baseline,
    withGhost,
    baselineBucket,
    afterGhostBucket,
    expected: "a local insert-delete pair with no intervening synchronization changes neither visible order nor the subsequent insertion's structural bucket",
  });
}

/**
 * The insert and delete need not arrive atomically for the pair to become
 * irrelevant. Here the insert crosses a real publication boundary and is
 * delivered by itself. The future editor temporarily sees it and may edit in
 * another gap, but creates no operation referencing it. After receiving the
 * separately published delete, the editor inserts in the restored gap.
 *
 * This is deliberately compared with a world in which the pair never existed.
 * Same replica ID, same local counter, same visible gap, and the exact same
 * concurrent witness updates are used in both worlds.
 */
function checkStagedGhostNeutrality(ListClass, trace, trialSeed, trialIndex) {
  const rng = makeRng(trialSeed);
  const { initial, clone } = settledExtension(ListClass, trace);
  const gap = rng.integer(0, initial.length);
  const ghostToken = `staged-ghost-${trialIndex}`;
  const insertedToken = `staged-after-ghost-${trialIndex}`;
  // Alternate the relative ID order. With one mid-ranked witness, these are
  // the two ways a hidden tombstone can move the editor across that witness.
  const editorBeforeGhost = trialIndex % 2 === 0;
  const ghostAuthorID = `${editorBeforeGhost ? "z" : "a"}-staged-ghost-author-${trialIndex}`;
  const editorID = `${editorBeforeGhost ? "a" : "z"}-staged-editor-${trialIndex}`;

  const ghostAuthor = clone(ghostAuthorID);
  const ghostInsert = ghostAuthor.insert(gap, ghostToken);
  // The insert is genuinely published before the deletion even exists.
  ghostAuthor.markSent();

  const withGhostAuthor = clone(editorID);
  withGhostAuthor.receive(ghostInsert);
  const visibleDuringWindow = [...withGhostAuthor.values];
  if (visibleDuringWindow[gap] !== ghostToken) {
    throw new Error("Staged ghost insert was not independently visible");
  }

  // In alternating trials, perform the same edit in a different visible gap
  // in both worlds. It is allowed because neither of its visible origins is
  // G; the semantic premise is "does not reference G", not "does nothing".
  const baselineAuthor = clone(editorID);
  let unrelatedToken = null;
  let unrelatedGap = null;
  let baselineUnrelated = null;
  let withGhostUnrelated = null;
  if (initial.length > 0 && trialIndex % 2 === 1) {
    const otherGaps = Array.from(
      { length: initial.length + 1 },
      (_, index) => index
    ).filter((index) => index !== gap);
    unrelatedGap = rng.pick(otherGaps);
    unrelatedToken = `staged-unrelated-${trialIndex}`;
    baselineUnrelated = baselineAuthor.insert(unrelatedGap, unrelatedToken);
    const shiftedGap = unrelatedGap + (gap < unrelatedGap ? 1 : 0);
    withGhostUnrelated = withGhostAuthor.insert(shiftedGap, unrelatedToken);
  }

  const ghostDelete = ghostAuthor.delete(gap);
  ghostAuthor.markSent();
  withGhostAuthor.receive(ghostDelete);
  const restoredVisible = baselineAuthor.values;
  if (!equal(withGhostAuthor.values, restoredVisible)) {
    throw new Error("Staged ghost deletion did not restore the settled text");
  }

  const insertionGap = gap + (unrelatedGap !== null && unrelatedGap < gap ? 1 : 0);
  const baselineInsert = baselineAuthor.insert(insertionGap, insertedToken);
  const afterStagedGhost = withGhostAuthor.insert(insertionGap, insertedToken);

  const witnesses = Array.from(
    { length: rng.integer(1, 3) },
    (_, index) => {
      const token = `staged-witness-${trialIndex}-${index}`;
      const author = clone(`m-staged-witness-author-${trialIndex}-${index}`);
      return { token, update: author.insert(gap, token) };
    }
  );

  const mergeBranch = (replicaID, branchUpdates, includeGhost) => {
    const merged = clone(replicaID);
    if (includeGhost) {
      merged.receive(ghostInsert);
      merged.receive(ghostDelete);
    }
    const pending = [...witnesses];
    while (pending.length !== 0) {
      const index = rng.integer(0, pending.length - 1);
      merged.receive(pending.splice(index, 1)[0].update);
    }
    for (const update of branchUpdates) merged.receive(update);
    return merged.values;
  };

  const baseline = mergeBranch(
    `merge-staged-base-${trialIndex}`,
    [baselineUnrelated, baselineInsert].filter((update) => update !== null),
    false
  );
  const withGhost = mergeBranch(
    `merge-staged-mutant-${trialIndex}`,
    [withGhostUnrelated, afterStagedGhost].filter((update) => update !== null),
    true
  );
  const baselineBucket = structuralBucket(baselineInsert);
  const afterGhostBucket = structuralBucket(afterStagedGhost);
  // Buckets are diagnostics only. A future correct format may carry inert
  // crossed-tombstone metadata that differs between the two histories. The
  // semantic oracle is whether identical concurrent continuations expose a
  // different visible order.
  if (equal(baseline, withGhost)) return null;
  return failure("staged-ghost-neutrality", trace, {
    trialSeed,
    trialIndex,
    commandIndex: trace.commands.length,
    gap,
    predecessor: gap === 0 ? START : initial[gap - 1],
    successor: gap === initial.length ? END : initial[gap],
    ghostToken,
    insertedToken,
    visibleDuringWindow,
    unrelatedToken,
    unrelatedGap,
    witnessTokens: witnesses.map(({ token }) => token),
    baseline,
    withGhost,
    baselineBucket,
    afterGhostBucket,
    expected: "a separately published and temporarily visible insert becomes neutral after its separately published delete when the observer made no operation that referenced it",
  });
}

/**
 * Unsafe mirror of staged ghost neutrality. If an observer does edit while
 * the published token is live, the token is no longer disposable history:
 * that surviving operation has a real origin relationship to it. This sensor
 * checks that the dependency survives deletion and both legal delivery orders.
 */
function checkReferencedTombstone(ListClass, trace, trialSeed, trialIndex) {
  const rng = makeRng(trialSeed);
  const { initial, clone } = settledExtension(ListClass, trace);
  const gap = rng.integer(0, initial.length);
  const run = (label, tombstoneAuthorID, witnessAuthorID, replacementAuthorID) => {
    const tombstoneToken = `referenced-tombstone-${trialIndex}-${label}`;
    const continuationToken = `referenced-continuation-${trialIndex}-${label}`;
    const witnessToken = `referenced-witness-${trialIndex}-${label}`;
    const replacementToken = `referenced-replacement-${trialIndex}-${label}`;

    const tombstoneAuthor = clone(tombstoneAuthorID);
    const tombstoneInsert = tombstoneAuthor.insert(gap, tombstoneToken);
    tombstoneAuthor.markSent();

    const witnessAuthor = clone(witnessAuthorID);
    const witness = witnessAuthor.insert(gap, witnessToken);

    const continuationAuthor = clone(`m-referenced-continuation-${trialIndex}-${label}`);
    continuationAuthor.receive(tombstoneInsert);
    // This is the decisive difference from a ghost: a live-period operation
    // has LO=tombstoneToken and must retain its clumping position after delete.
    const continuation = continuationAuthor.insert(gap + 1, continuationToken);

    const tombstoneDelete = tombstoneAuthor.delete(gap);
    tombstoneAuthor.markSent();

    const replacementAuthor = clone(replacementAuthorID);
    replacementAuthor.receive(tombstoneInsert);
    replacementAuthor.receive(tombstoneDelete);
    const replacement = replacementAuthor.insert(gap, replacementToken);

    const replay = (replicaID, order) => {
      const merged = clone(replicaID);
      const states = [];
      for (const update of order) merged.receive(update);
      states.push([...merged.values]);
      return { values: merged.values, states };
    };
    const beforeDelete = replay(
      `merge-referenced-live-${trialIndex}-${label}`,
      [tombstoneInsert, witness, continuation]
    ).values;
    const afterDelete = replay(
      `merge-referenced-dead-${trialIndex}-${label}`,
      [tombstoneInsert, witness, continuation, tombstoneDelete]
    ).values;

    const xBeforeY = replay(
      `merge-referenced-x-first-${trialIndex}-${label}`,
      [tombstoneInsert, witness, continuation, tombstoneDelete, replacement]
    ).values;
    const yBeforeXDoc = clone(`merge-referenced-y-first-${trialIndex}-${label}`);
    for (const update of [tombstoneInsert, tombstoneDelete, replacement, witness]) {
      yBeforeXDoc.receive(update);
    }
    const beforeLateContinuation = [...yBeforeXDoc.values];
    yBeforeXDoc.receive(continuation);
    const yBeforeX = yBeforeXDoc.values;

    const pureDelete = equal(
      afterDelete,
      beforeDelete.filter((token) => token !== tombstoneToken)
    );
    const lateInsertIsPure = equal(
      yBeforeX.filter((token) => token !== continuationToken),
      beforeLateContinuation
    );
    const allSurvive = [continuationToken, witnessToken, replacementToken]
      .every((token) => xBeforeY.includes(token));
    return {
      label,
      tombstoneToken,
      continuationToken,
      witnessToken,
      replacementToken,
      continuationBucket: structuralBucket(continuation),
      replacementBucket: structuralBucket(replacement),
      beforeDelete,
      afterDelete,
      beforeLateContinuation,
      xBeforeY,
      yBeforeX,
      pureDelete,
      lateInsertIsPure,
      pass: pureDelete && lateInsertIsPure && allSurvive && equal(xBeforeY, yBeforeX),
    };
  };

  // Both rank directions exercise the meaningful reference. When Y's author
  // did not know the in-flight X, no additional Y<X relation is required.
  const assignments = [
    run(
      "tombstone-before-witness",
      `z-referenced-tombstone-author-${trialIndex}`,
      `m-referenced-witness-author-${trialIndex}`,
      `a-referenced-replacement-author-${trialIndex}`
    ),
    run(
      "witness-before-tombstone",
      `a-referenced-tombstone-author-${trialIndex}`,
      `m-referenced-witness-author-${trialIndex}`,
      `z-referenced-replacement-author-${trialIndex}`
    ),
  ];
  if (assignments.every(({ pass }) => pass)) return null;
  return failure("referenced-tombstone", trace, {
    trialSeed,
    trialIndex,
    commandIndex: trace.commands.length,
    gap,
    predecessor: gap === 0 ? START : initial[gap - 1],
    successor: gap === initial.length ? END : initial[gap],
    assignments,
    expected: "a published tombstone remains a valid origin: deletion and late dependent delivery are pure insert/remove projections, and all legal delivery orders converge without reordering established survivors",
  });
}

function checkDeleteInsertCommutation(ListClass, trace, trialSeed, trialIndex) {
  const rng = makeRng(trialSeed);
  const { initial, clone } = settledExtension(ListClass, trace);
  if (initial.length === 0) return null;
  const targetIndex = rng.integer(0, initial.length - 1);
  const deleteCount = rng.integer(
    1,
    Math.min(3, initial.length - targetIndex)
  );
  const targets = initial.slice(targetIndex, targetIndex + deleteCount);
  const predecessor = targetIndex === 0 ? START : initial[targetIndex - 1];
  const successor = targetIndex + deleteCount === initial.length
    ? END
    : initial[targetIndex + deleteCount];
  const witnessTokens = Array.from(
    { length: rng.integer(1, 3) },
    (_, index) => `commute-witness-${trialIndex}-${index}`
  );
  const insertedToken = `commute-insert-${trialIndex}`;

  const run = (commuterID, witnessPrefix, label) => {
    const witnesses = [];
    for (const [index, token] of witnessTokens.entries()) {
      const author = clone(`${witnessPrefix}-${trialIndex}-${index}`);
      const update = author.insert(targetIndex, token);
      witnesses.push({ token, update, bucket: structuralBucket(update) });
    }

    // History 1: insert immediately before the live target, then delete it.
    const insertFirstAuthor = clone(commuterID);
    const beforeDeletion = insertFirstAuthor.insert(targetIndex, insertedToken);
    const deletionsAfter = targets.map((target) =>
      insertFirstAuthor.delete(insertFirstAuthor.values.indexOf(target))
    );

    // History 2: delete the target, then insert at its former visible index.
    // The replica ID and all concurrent witness IDs are held fixed; only the
    // order of these two locally commuting commands changes.
    const deleteFirstAuthor = clone(commuterID);
    const deletionsBefore = targets.map(() =>
      deleteFirstAuthor.delete(targetIndex)
    );
    const afterDeletion = deleteFirstAuthor.insert(targetIndex, insertedToken);

    // Same causal document actions, but the delete batch is handed to the
    // transport before the insertion is generated. Transport flushing must
    // not silently choose a different visible merge.
    const deleteFirstAfterHandoffAuthor = clone(commuterID);
    const deletionsBeforeHandoff = targets.map(() =>
      deleteFirstAfterHandoffAuthor.delete(targetIndex)
    );
    deleteFirstAfterHandoffAuthor.markSent();
    const afterDeletionAndHandoff = deleteFirstAfterHandoffAuthor.insert(
      targetIndex,
      insertedToken
    );

    const merge = (suffix, branchUpdates) => {
      const merged = clone(`merge-commute-${trialIndex}-${label}-${suffix}`);
      for (const witness of witnesses) merged.receive(witness.update);
      for (const update of branchUpdates) merged.receive(update);
      return merged.values;
    };
    return {
      insertThenDelete: merge("insert-delete", [
        beforeDeletion,
        ...deletionsAfter,
      ]),
      deleteThenInsert: merge("delete-insert", [
        ...deletionsBefore,
        afterDeletion,
      ]),
      deleteThenHandoffThenInsert: merge("delete-handoff-insert", [
        ...deletionsBeforeHandoff,
        afterDeletionAndHandoff,
      ]),
      insertFirstBucket: structuralBucket(beforeDeletion),
      deleteFirstBucket: structuralBucket(afterDeletion),
      deleteFirstAfterHandoffBucket: structuralBucket(afterDeletionAndHandoff),
      witnessBuckets: witnesses.map(({ bucket }) => bucket),
    };
  };

  const assignments = [
    {
      label: "commuter IDs before witnesses",
      result: run(
        `a-commuter-${trialIndex}`,
        "z-commute-witness",
        "low-commuter"
      ),
    },
    {
      label: "commuter IDs after witnesses",
      result: run(
        `z-commuter-${trialIndex}`,
        "a-commute-witness",
        "high-commuter"
      ),
    },
  ];
  const divergent = assignments.filter(({ result }) =>
    !equal(result.insertThenDelete, result.deleteThenInsert) ||
    !equal(result.insertThenDelete, result.deleteThenHandoffThenInsert)
  );
  if (divergent.length === 0) return null;
  return failure("delete-insert-commutation", trace, {
    trialSeed,
    trialIndex,
    commandIndex: trace.commands.length,
    predecessor,
    targets,
    deleteCount,
    successor,
    targetIndex,
    insertedToken,
    witnessTokens,
    assignments,
    expected: "with replica IDs and concurrent witnesses fixed, inserting immediately before B then deleting B equals deleting B then inserting at B's former index under either transport-handoff schedule",
  });
}

function failure(sensor, trace, witness) {
  return {
    sensor,
    traceSeed: trace.seed,
    witness,
    replay: `node fuzz_tombstone_properties.js --module ${JSON.stringify(trace.generation.module)} --seed ${JSON.stringify(trace.seed.split("/trace/")[0])} --trace ${trace.seed.split("/trace/")[1]} --steps ${trace.generation.steps} --clients ${trace.generation.clients} --sensor ${sensor} --ghost-trials ${(witness.trialIndex ?? 0) + 1} --commutation-trials ${(witness.trialIndex ?? 0) + 1} --bucket-trials ${(witness.trialIndex ?? 0) + 1}`,
    tracePrefix: trace.commands
      .slice(0, (witness.commandIndex ?? trace.commands.length - 1) + 1)
      .map(formatCommand),
  };
}

function formatCommand(command) {
  if (command.kind === "deliver") return `${command.actor} <- ${command.key}`;
  if (command.kind === "handoff") return `${command.actor}: hand off through ${command.key}`;
  if (command.kind === "insert") {
    return `${command.actor}: insert ${command.token} @${command.index} (${command.leftOrigin}, ${command.rightOrigin})`;
  }
  return `${command.actor}: delete ${command.token}`;
}

function selected(options, sensor) {
  if (options.sensor !== null) return options.sensor === sensor;
  if (options.profile === "all") return true;
  const bugs = new Set([
    "ghost-neutrality",
    "staged-ghost-neutrality",
  ]);
  const controls = new Set([
    "local-ghost-neutrality",
    "delete-insert-commutation",
    "referenced-tombstone",
    "reverse-ro-buckets",
    "step-projection",
    "forward-non-interleaving",
    "convergence",
  ]);
  if (options.profile === "published-bugs") return bugs.has(sensor);
  if (options.profile === "controls") return controls.has(sensor);
  return bugs.has(sensor) || controls.has(sensor);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const specifier = options.module.startsWith("/") ? pathToFileURL(options.module).href : options.module;
  const implementation = await import(specifier);
  const ListClass = implementation[options.exportName];
  if (ListClass === undefined) throw new Error(`${options.module} has no export ${options.exportName}`);

  const traceIndexes = options.selectedTrace === null
    ? Array.from({ length: options.traces }, (_, index) => index)
    : [options.selectedTrace];
  const counts = new Map([
    ["ghost-neutrality", 0],
    ["staged-ghost-neutrality", 0],
    ["local-ghost-neutrality", 0],
    ["delete-insert-commutation", 0],
    ["referenced-tombstone", 0],
    ["reverse-ro-buckets", 0],
    ["step-projection", 0],
    ["forward-non-interleaving", 0],
    ["backward-non-interleaving", 0],
    ["convergence", 0],
  ]);
  const examples = [];
  const record = (found) => {
    if (found === null) return;
    counts.set(found.sensor, counts.get(found.sensor) + 1);
    if (examples.length < options.maxFailures) examples.push(found);
  };

  for (const traceIndex of traceIndexes) {
    const traceSeed = `${options.seed}/trace/${traceIndex}`;
    const trace = generateTrace(ListClass, traceSeed, options);
    if (selected(options, "step-projection")) record(checkStepProjection(trace));
    if (selected(options, "forward-non-interleaving")) record(checkForwardNonInterleaving(trace));
    if (selected(options, "backward-non-interleaving")) record(checkBackwardNonInterleaving(trace));
    if (selected(options, "convergence")) record(checkConvergence(trace));
    if (selected(options, "ghost-neutrality")) {
      for (let trial = 0; trial < options.ghostTrials; trial++) {
        record(replayWithInvisibleGhost(ListClass, trace, `${traceSeed}/ghost/${trial}`, trial));
      }
    }
    if (selected(options, "staged-ghost-neutrality")) {
      for (let trial = 0; trial < options.ghostTrials; trial++) {
        record(checkStagedGhostNeutrality(
          ListClass,
          trace,
          `${traceSeed}/staged-ghost/${trial}`,
          trial
        ));
      }
    }
    if (selected(options, "local-ghost-neutrality")) {
      for (let trial = 0; trial < options.ghostTrials; trial++) {
        record(checkLocalGhostNeutrality(
          ListClass,
          trace,
          `${traceSeed}/local-ghost/${trial}`,
          trial
        ));
      }
    }
    if (selected(options, "delete-insert-commutation")) {
      for (let trial = 0; trial < options.commutationTrials; trial++) {
        record(checkDeleteInsertCommutation(
          ListClass,
          trace,
          `${traceSeed}/commutation/${trial}`,
          trial
        ));
      }
    }
    if (selected(options, "referenced-tombstone")) {
      for (let trial = 0; trial < options.ghostTrials; trial++) {
        record(checkReferencedTombstone(
          ListClass,
          trace,
          `${traceSeed}/referenced-tombstone/${trial}`,
          trial
        ));
      }
    }
    if (selected(options, "reverse-ro-buckets")) {
      for (let trial = 0; trial < options.bucketTrials; trial++) {
        record(checkReverseROBuckets(
          ListClass,
          trace,
          `${traceSeed}/bucket/${trial}`,
          trial
        ));
      }
    }
  }

  const result = {
    implementation: options.module,
    seed: options.seed,
    traces: traceIndexes.length,
    steps: options.steps,
    clients: options.clients,
    profile: options.sensor ?? options.profile,
    ghostTrialsPerTrace: options.ghostTrials,
    commutationTrialsPerTrace: options.commutationTrials,
    bucketTrialsPerTrace: options.bucketTrials,
    failures: Object.fromEntries([...counts].filter(([sensor]) => selected(options, sensor))),
    examples,
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`implementation: ${result.implementation}`);
    console.log(`profile: ${result.profile}`);
    console.log(`seed: ${result.seed}`);
    console.log(`traces: ${result.traces} x ${result.steps} random commands, ${result.clients} replicas`);
    for (const [sensor, count] of counts) {
      if (selected(options, sensor)) console.log(`${sensor}: ${count} counterexamples`);
    }
    for (const example of examples) {
      console.log(`\n[${example.sensor}] ${example.traceSeed}`);
      console.log(JSON.stringify(example.witness, null, 2));
      console.log(`replay: ${example.replay}`);
      console.log("causal prefix seen by the sensor:");
      for (const command of example.tracePrefix) console.log(`  ${command}`);
    }
  }

  const totalFailures = [...counts]
    .filter(([sensor]) => selected(options, sensor))
    .reduce((sum, [, count]) => sum + count, 0);
  if (options.mode === "check" && totalFailures !== 0) process.exitCode = 1;
  if (options.expectCounterexample !== null && counts.get(options.expectCounterexample) === 0) {
    console.error(`Expected ${options.expectCounterexample} to find a counterexample`);
    process.exitCode = 1;
  }
}

export {
  buildObservedOrder,
  checkBackwardNonInterleaving,
  checkConvergence,
  checkForwardNonInterleaving,
  checkReverseROBuckets,
  checkLocalGhostNeutrality,
  checkStagedGhostNeutrality,
  checkReferencedTombstone,
  checkDeleteInsertCommutation,
  checkStepProjection,
  generateTrace,
  replayWithInvisibleGhost,
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
