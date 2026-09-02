// Randomized model checker for the phantom-barrier problem family.
//
// Where test_solution.js pins 32 hand-built scenarios, this generates random
// multi-peer editing scenarios — deletes included, with exact causal tracking —
// and checks the properties from the Fugue correspondence on every one of them.
// The default checks are precisely the ones canonical Fugue/FugueMax FAILS and
// the era design claims to fix; each failing seed prints a full repro script.
//
// Default checks:
//
//   era-separation    (the AYC family, PROBLEM.md Points 1-2, SOLUTION.md G3/G5)
//                     If two authors concurrently insert into the same visible
//                     slot and exactly one of them knew that the slot's old
//                     content was deleted, the author who believed it alive
//                     must come first — decided by knowledge, never by sender
//                     IDs. Checked on the scenario AND on an intent-faithful
//                     replay with permuted replica IDs, so ID-dependent flips
//                     (canonical's "acy"/"ayc") are caught even when the
//                     original assignment got lucky.
//
//   prune-neutrality  (phantom barriers; Toomim's pruning requirement)
//                     "We should be able to clean up past tombstones before an
//                     edit, and not have that change the sorting order of edits
//                     that occur afterward." A character inserted and deleted
//                     before a full sync — and never used as anyone's visible
//                     anchor — is pruned from history; every edit made after
//                     the sync barrier must order identically. Canonical fails:
//                     its tombstone-inclusive origins let the dead node steer
//                     concurrent placement forever.
//
//   ghost-neutrality  A char inserted and deleted locally, back to back, with
//                     no edit in between and never witnessed alive by anyone,
//                     is removed from history; nothing may change. By the
//                     impossibility proposition in SOLUTION.md no strong-list
//                     algorithm passes this fully — canonical and era fail on
//                     different sides (T1) — so the failing seeds are the map
//                     of exactly where each design pays.
//
//   origin-order      Sanity net (G1): a character never crosses its author's
//   stability         generation-time visible neighbours; a delivery never
//   interleaving      reorders visible characters; two peers' typed runs never
//                     alternate. Canonical and era both pass; these exist to
//                     catch regressions in future modified implementations.
//
// Opt-in via --checks:
//
//   convergence       All delivery permutations of the op set merge equal.
//                     Meaningless for the shipped CRDTs (convergent by
//                     construction) — useful only when testing modified
//                     implementations, e.g. the old RO-shifting fix which made
//                     placement delivery-order dependent.
//
// Usage:
//   node model_check.js                       # default checks, seeds 1..200
//   node model_check.js --seed 42             # reproduce one seed, verbose
//   node model_check.js --impl fugue          # canonical Fugue (should fail)
//   node model_check.js --seeds 1000 --ops 40 --peers 4
//   node model_check.js --checks era-separation,prune-neutrality
//   node model_check.js --forever

import seedrandom from "seedrandom";
import { CRuntime } from "@collabs/collabs";
import { FugueMaxSimple } from "fugue-max-simple";
import { FugueArray } from "fugue";

const IMPLS = {
  fuguemax: (init) => new FugueMaxSimple(init),
  fugue: (init) => new FugueArray(init),
};

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const START = "^";
const END = "$";

let makeList = IMPLS.fuguemax;
let docCounter = 0;

class Doc {
  constructor(id) {
    this.doc = new CRuntime({ debugReplicaID: id });
    this.ups = [];
    this.doc.on("Send", (e) => {
      const u = new Uint8Array(e.message.length + 1);
      u.set(e.message);
      u[e.message.length] = 0;
      this.ups.push(u);
    });
    this.arr = this.doc.registerCollab("array", makeList);
  }
  insert(idx, val) { this.doc.transact(() => this.arr.insert(idx, val)); }
  del(idx) { this.doc.transact(() => this.arr.delete(idx, 1)); }
  apply(u) { this.doc.receive(u.subarray(0, u.length - 1)); }
  pop() { return this.ups.shift(); }
  state() { return [...this.arr.values()]; }
}

const show = (state) => state.join(" ") || "(empty)";
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isSubset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };

// ---------------------------------------------------------------------------
// Scenario generation with exact causal tracking.
//
// Every local operation is one broadcast update. An update's `past` is the set
// of update ids its author had applied when generating it, so "the author knew
// delete(d)" is a precise statement. Updates are only delivered when causally
// ready, so applied == received always and no runtime buffering ever happens.
// ---------------------------------------------------------------------------

function generateScenario(rng, { peers: numPeers, ops: numOps, ghostProbability, pruneBarrier }) {
  const peers = [];
  for (let p = 0; p < numPeers; p++) peers.push(new Doc(String(p)));

  const scenario = {
    events: [],            // {type, peer, ..., stateBefore, stateAfter, phase}
    updates: [],           // {id, author, kind, token, ghost, phase, past:Set, update}
    outbox: [],            // per peer: update ids in send order
    neighbors: new Map(),  // token -> {left, right} at generation time
    insertOf: new Map(),   // token -> update record of its insert
    deletesOf: new Map(),  // token -> [update records of deletes]
    runs: [],
    finals: null,
    hasGhosts: false,
    numPeers,
  };
  const applied = [];
  const inboxPtr = [];
  for (let p = 0; p < numPeers; p++) {
    scenario.outbox.push([]);
    applied.push(new Set());
    inboxPtr.push(new Array(numPeers).fill(0));
  }
  const openRuns = new Array(numPeers).fill(null);
  let opCounter = 0;
  let phase = 1;

  const closeRun = (p) => {
    if (openRuns[p] !== null && openRuns[p].tokens.length > 1) {
      scenario.runs.push({ peer: p, tokens: openRuns[p].tokens });
    }
    openRuns[p] = null;
  };

  const record = (event, stateBefore, peer) => {
    event.phase = phase;
    event.stateBefore = stateBefore;
    event.stateAfter = peers[peer].state();
    scenario.events.push(event);
  };

  const send = (p, kind, token, ghost) => {
    const rec = {
      id: scenario.updates.length,
      author: p, kind, token, ghost, phase,
      past: new Set(applied[p]),
      update: peers[p].pop(),
    };
    scenario.updates.push(rec);
    scenario.outbox[p].push(rec.id);
    applied[p].add(rec.id);
    return rec;
  };

  const localInsert = (p, pos, ghost) => {
    const stateBefore = peers[p].state();
    const token = LETTERS[Math.floor(rng() * 26)] + opCounter++;
    scenario.neighbors.set(token, {
      left: pos > 0 ? stateBefore[pos - 1] : START,
      right: pos < stateBefore.length ? stateBefore[pos] : END,
    });
    peers[p].insert(pos, token);
    scenario.insertOf.set(token, send(p, "insert", token, ghost));
    record({ type: "insert", peer: p, pos, token, ghost }, stateBefore, p);
    if (!ghost) {
      if (openRuns[p] !== null && pos === openRuns[p].nextPos) {
        openRuns[p].tokens.push(token);
        openRuns[p].nextPos = pos + 1;
      } else {
        closeRun(p);
        openRuns[p] = { tokens: [token], nextPos: pos + 1 };
      }
    }
  };

  const localDelete = (p, pos, ghost) => {
    const stateBefore = peers[p].state();
    const token = stateBefore[pos];
    peers[p].del(pos);
    if (!scenario.deletesOf.has(token)) scenario.deletesOf.set(token, []);
    scenario.deletesOf.get(token).push(send(p, "delete", token, ghost));
    record({ type: "delete", peer: p, pos, token, ghost }, stateBefore, p);
    closeRun(p);
  };

  const headReady = (q, s) => {
    if (inboxPtr[q][s] >= scenario.outbox[s].length) return false;
    return isSubset(scenario.updates[scenario.outbox[s][inboxPtr[q][s]]].past, applied[q]);
  };

  const receive = (q, s) => {
    const stateBefore = peers[q].state();
    let count = 0;
    let rec;
    do {
      rec = scenario.updates[scenario.outbox[s][inboxPtr[q][s]++]];
      peers[q].apply(rec.update);
      applied[q].add(rec.id);
      count++;
      // A ghost pair is consumed atomically: the ghost char is never visible
      // to anyone at an event boundary.
    } while (rec.ghost && count % 2 === 1);
    record({ type: "recv", peer: q, from: s, count }, stateBefore, q);
    closeRun(q);
  };

  const fullSync = () => {
    let pending = true;
    while (pending) {
      pending = false;
      for (let q = 0; q < numPeers; q++) {
        for (let s = 0; s < numPeers; s++) {
          if (q === s) continue;
          while (headReady(q, s)) {
            pending = true;
            receive(q, s);
          }
        }
      }
    }
  };

  for (let i = 0; i < numOps; i++) {
    // In prune mode, phase 1 ends with a full sync barrier: afterwards every
    // peer knows every phase-1 deletion.
    if (pruneBarrier && phase === 1 && i >= Math.floor(numOps / 2)) {
      fullSync();
      phase = 2;
    }

    const p = Math.floor(rng() * numPeers);
    const len = peers[p].state().length;

    if (ghostProbability > 0 && rng() < ghostProbability) {
      const pos = Math.floor(rng() * (len + 1));
      localInsert(p, pos, true);
      localDelete(p, pos, true);
      scenario.hasGhosts = true;
      continue;
    }

    const senders = [];
    for (let s = 0; s < numPeers; s++) if (s !== p && headReady(p, s)) senders.push(s);
    const options = ["insert"];
    // Phase 1 of a prune scenario deletes more, to produce dead-by-the-barrier
    // characters worth pruning.
    if (len > 0) options.push("delete");
    if (pruneBarrier && phase === 1 && len > 0) options.push("delete");
    if (senders.length > 0) options.push("recv");
    const op = options[Math.floor(rng() * options.length)];

    if (op === "insert") localInsert(p, Math.floor(rng() * (len + 1)), false);
    else if (op === "delete") localDelete(p, Math.floor(rng() * len), false);
    else receive(p, senders[Math.floor(rng() * senders.length)]);
  }

  phase = 3;
  fullSync();
  for (let p = 0; p < numPeers; p++) closeRun(p);
  scenario.finals = peers.map((peer) => peer.state());
  return scenario;
}

function describeEvent(e) {
  if (e.type === "insert") return `p${e.peer} ${e.ghost ? "ghost-" : ""}insert @${e.pos} "${e.token}"`;
  if (e.type === "delete") return `p${e.peer} ${e.ghost ? "ghost-" : ""}delete @${e.pos} "${e.token}"`;
  return `p${e.peer} recv ${e.count} from p${e.from}`;
}

function printScenario(scenario) {
  console.log("  script:");
  for (const e of scenario.events) console.log(`    ${describeEvent(e)}  ->  ${show(e.stateAfter)}`);
}

// ---------------------------------------------------------------------------
// Replay engine: re-executes a scenario's script against fresh peers,
// optionally skipping some updates (pruned/ghost history) and/or renaming
// replicas. Local operations are replayed by intent — insert after the same
// visible left neighbour, delete the same character — so the replay stays
// meaningful even where tie-breaks differ.
// ---------------------------------------------------------------------------

function replayScript(scenario, { skip = new Set(), idMap = null, compareModulo = null } = {}) {
  const strip = (state) =>
    compareModulo === null ? state : state.filter((t) => !compareModulo.has(t));

  const peers = [];
  for (let p = 0; p < scenario.numPeers; p++) {
    peers.push(new Doc(idMap === null ? String(p) : idMap[p]));
  }
  const outbox = [];
  const inboxPtr = [];
  const replayPtr = [];
  for (let p = 0; p < scenario.numPeers; p++) {
    outbox.push([]);
    inboxPtr.push(new Array(scenario.numPeers).fill(0));
    replayPtr.push(new Array(scenario.numPeers).fill(0));
  }

  const compare = compareModulo !== null || skip.size > 0;

  for (let i = 0; i < scenario.events.length; i++) {
    const e = scenario.events[i];

    if (e.type === "insert" || e.type === "delete") {
      const rec = e.type === "insert"
        ? scenario.insertOf.get(e.token)
        : scenario.deletesOf.get(e.token).find((d) => d.author === e.peer && d.phase === e.phase) ??
          scenario.deletesOf.get(e.token)[0];
      if (skip.has(scenario.insertOf.get(e.token).id) || (rec !== undefined && skip.has(rec.id))) continue;

      const doc = peers[e.peer];
      const state = doc.state();
      if (compare && !same(state, strip(e.stateBefore))) {
        return {
          failure:
            `state diverged before event ${i} (${describeEvent(e)}):\n` +
            `    original: ${show(strip(e.stateBefore))}\n    replayed: ${show(state)}`,
        };
      }
      if (e.type === "insert") {
        const left = scenario.neighbors.get(e.token).left;
        const pos = left === START ? 0 : state.indexOf(left) + 1;
        if (left !== START && state.indexOf(left) === -1) {
          return { failure: `left neighbour "${left}" of "${e.token}" is missing in the replay` };
        }
        doc.insert(pos, e.token);
      } else {
        const pos = state.indexOf(e.token);
        if (pos === -1) return { failure: `"${e.token}" is missing in the replay at its delete` };
        doc.del(pos);
      }
      outbox[e.peer].push(doc.pop());
    } else {
      let toApply = 0;
      for (let k = 0; k < e.count; k++) {
        if (!skip.has(scenario.outbox[e.from][inboxPtr[e.peer][e.from] + k])) toApply++;
      }
      inboxPtr[e.peer][e.from] += e.count;
      for (let k = 0; k < toApply; k++) {
        peers[e.peer].apply(outbox[e.from][replayPtr[e.peer][e.from]++]);
      }
      if (toApply === 0) continue;
    }

    if (compare) {
      const state = peers[e.peer].state();
      if (!same(state, strip(e.stateAfter))) {
        return {
          failure:
            `state diverged after event ${i} (${describeEvent(e)}):\n` +
            `    original: ${show(strip(e.stateAfter))}\n    replayed: ${show(state)}`,
        };
      }
    }
  }

  const finals = peers.map((p) => p.state());
  if (compare) {
    for (let p = 0; p < scenario.numPeers; p++) {
      if (!same(finals[p], strip(scenario.finals[p]))) {
        return {
          failure:
            `final document changed for p${p}:\n` +
            `    original: ${show(strip(scenario.finals[p]))}\n    replayed: ${show(finals[p])}`,
        };
      }
    }
  }
  return { finals };
}

// ---------------------------------------------------------------------------
// Checks. Each returns null on success or a failure description.
// ---------------------------------------------------------------------------

// The AYC family. For visible x, z in a final document: if their authors
// inserted into the same visible slot concurrently, and z's author knew that
// x's visible right neighbour R had been deleted while x's author believed R
// alive (and x's author did not symmetrically know z's stop dead), then the
// ordering is decided by knowledge: x must precede z. Canonical FugueMax
// decides it by sender IDs instead.
function eraSeparationViolation(scenario, final) {
  const indexOf = new Map(final.map((t, i) => [t, i]));
  const knowsDeleteOf = (rec, token) => {
    const dels = scenario.deletesOf.get(token);
    return dels !== undefined && dels.some((d) => rec.past.has(d.id));
  };

  for (const [x, xi] of indexOf) {
    const nx = scenario.neighbors.get(x);
    const ox = scenario.insertOf.get(x);
    if (nx === undefined || nx.right === END) continue;
    for (const [z, zi] of indexOf) {
      if (z === x) continue;
      const nz = scenario.neighbors.get(z);
      const oz = scenario.insertOf.get(z);
      if (nz === undefined || nz.left !== nx.left) continue;                 // same visible slot
      if (oz.past.has(ox.id) || ox.past.has(oz.id)) continue;                // pins dominate
      const R = nx.right;
      if (!knowsDeleteOf(oz, R) || knowsDeleteOf(ox, R)) continue;           // z knew R dead, x did not
      if (nz.right !== END && knowsDeleteOf(ox, nz.right)) continue;         // no mutual asymmetry
      if (xi > zi) {
        return (
          `"${z}" (author p${oz.author} knew "${R}" was deleted) precedes ` +
          `"${x}" (author p${ox.author} believed "${R}" alive) in:\n    ${show(final)}\n` +
          `    both were inserted concurrently after "${nx.left === START ? "start" : nx.left}" — ` +
          `knowledge, not IDs, must order them`
        );
      }
    }
  }
  return null;
}

function checkEraSeparation(scenario) {
  const base = eraSeparationViolation(scenario, scenario.finals[0]);
  if (base !== null) return base;

  // Same script, permuted replica IDs (relative order of senders changes).
  // Knowledge-decided orderings must survive any ID assignment.
  const idMap = [];
  for (let p = 0; p < scenario.numPeers; p++) {
    idMap.push(String((3 * p + 1) % (scenario.numPeers + 1)));
  }
  const replay = replayScript(scenario, { idMap });
  if (replay.failure !== undefined) return `permuted-id replay failed: ${replay.failure}`;
  const permuted = eraSeparationViolation(scenario, replay.finals[0]);
  if (permuted !== null) return `with permuted replica IDs: ${permuted}`;
  return null;
}

// Toomim's pruning requirement. A character that was dead before the sync
// barrier — and that no other operation ever used as a visible anchor — is
// removed from history. Everything after the barrier must be unaffected:
// states compared modulo the pruned characters, final documents exactly.
function checkPruneNeutrality(scenario) {
  const prunable = new Set();
  for (const [token, rec] of scenario.insertOf) {
    if (rec.phase !== 1 || rec.ghost) continue;
    const dels = scenario.deletesOf.get(token);
    if (dels === undefined || !dels.some((d) => d.phase === 1)) continue;
    prunable.add(token);
  }
  for (const { left, right } of scenario.neighbors.values()) {
    prunable.delete(left);
    prunable.delete(right);
  }
  if (prunable.size === 0) return null;

  const skip = new Set();
  for (const token of prunable) {
    skip.add(scenario.insertOf.get(token).id);
    for (const d of scenario.deletesOf.get(token)) skip.add(d.id);
  }
  const result = replayScript(scenario, { skip, compareModulo: prunable });
  if (result.failure !== undefined) {
    return `pruning dead pre-barrier characters [${[...prunable].join(" ")}] changed history:\n  ${result.failure}`;
  }
  return null;
}

// A char inserted and deleted locally back-to-back, never witnessed alive by
// any other peer, is removed from history; nothing may change.
function checkGhostNeutrality(scenario) {
  if (!scenario.hasGhosts) return null;
  const skip = new Set();
  for (const rec of scenario.updates) if (rec.ghost) skip.add(rec.id);
  const result = replayScript(scenario, { skip, compareModulo: new Set() });
  return result.failure ?? null;
}

// G1: a character never crosses its generation-time visible neighbours.
function checkOriginOrder(scenario) {
  const states = scenario.events.map((e) => e.stateAfter).concat(scenario.finals);
  for (const state of states) {
    const indexOf = new Map(state.map((t, i) => [t, i]));
    for (const [token, index] of indexOf) {
      const n = scenario.neighbors.get(token);
      if (n === undefined) continue;
      if (n.left !== START && indexOf.has(n.left) && indexOf.get(n.left) > index) {
        return `"${token}" moved before its left neighbour "${n.left}" in: ${show(state)}`;
      }
      if (n.right !== END && indexOf.has(n.right) && indexOf.get(n.right) < index) {
        return `"${token}" moved after its right neighbour "${n.right}" in: ${show(state)}`;
      }
    }
  }
  return null;
}

// G2: no delivery reorders what a peer already sees.
function checkStability(scenario) {
  for (let i = 0; i < scenario.events.length; i++) {
    const e = scenario.events[i];
    const afterSet = new Set(e.stateAfter);
    const beforeSet = new Set(e.stateBefore);
    const beforeCommon = e.stateBefore.filter((t) => afterSet.has(t));
    const afterCommon = e.stateAfter.filter((t) => beforeSet.has(t));
    if (!same(beforeCommon, afterCommon)) {
      return (
        `event ${i} (${describeEvent(e)}) reordered existing characters:\n` +
        `    before: ${show(e.stateBefore)}\n    after:  ${show(e.stateAfter)}`
      );
    }
  }
  return null;
}

// G4: two peers' runs never alternate (whole-block nesting is legal).
function checkInterleaving(scenario) {
  const final = scenario.finals[0];
  for (let a = 0; a < scenario.runs.length; a++) {
    for (let b = a + 1; b < scenario.runs.length; b++) {
      const runA = scenario.runs[a];
      const runB = scenario.runs[b];
      if (runA.peer === runB.peer) continue;
      const setA = new Set(runA.tokens);
      const setB = new Set(runB.tokens);
      const labels = final
        .map((t) => (setA.has(t) ? "a" : setB.has(t) ? "b" : null))
        .filter((l) => l !== null);
      let transitions = 0;
      for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) transitions++;
      if (transitions >= 3) {
        return (
          `runs [${runA.tokens.join(" ")}] by p${runA.peer} and ` +
          `[${runB.tokens.join(" ")}] by p${runB.peer} interleave in:\n    ${show(final)}`
        );
      }
    }
  }
  return null;
}

// Opt-in: all delivery permutations of the op set merge to the peers' document.
function checkConvergence(scenario, rng, numMergeOrders) {
  const reference = scenario.finals[0];
  for (let p = 1; p < scenario.finals.length; p++) {
    if (!same(scenario.finals[p], reference)) {
      return `live peers diverged:\n    p0: ${show(reference)}\n    p${p}: ${show(scenario.finals[p])}`;
    }
  }
  const updates = scenario.updates.map((rec) => rec.update);
  const orders = [[...updates].reverse()];
  for (let k = 0; k < numMergeOrders; k++) {
    const shuffled = [...updates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    orders.push(shuffled);
  }
  for (let i = 0; i < orders.length; i++) {
    const doc = new Doc("zz-merge-" + docCounter++);
    orders[i].forEach((u) => doc.apply(u));
    if (!same(doc.state(), reference)) {
      return `merge order ${i} disagrees:\n    peers:  ${show(reference)}\n    merged: ${show(doc.state())}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

const DEFAULT_CHECKS = [
  "era-separation", "prune-neutrality", "ghost-neutrality",
  "origin-order", "stability", "interleaving",
];
const ALL_CHECKS = [...DEFAULT_CHECKS, "convergence"];

function runSeed(seed, options, verbose) {
  const failures = [];
  const want = (c) => options.checks.includes(c);
  const fail = (check, scenario, message) => {
    failures.push(check);
    console.log(`[seed ${seed}] ${check} FAILED: ${message}`);
    if (verbose) printScenario(scenario);
  };

  // Three scenario shapes per seed: plain, ghosted, and two-phase prune.
  const shapes = [
    { name: "plain", ghostProbability: 0, pruneBarrier: false },
    { name: "ghosted", ghostProbability: 0.25, pruneBarrier: false },
    { name: "prune", ghostProbability: 0, pruneBarrier: true },
  ];

  for (const shape of shapes) {
    const rng = seedrandom(`fugue-model-check:${seed}:${shape.name}`);
    const scenario = generateScenario(rng, {
      peers: options.peers, ops: options.ops,
      ghostProbability: shape.ghostProbability, pruneBarrier: shape.pruneBarrier,
    });

    const results = {};
    if (want("era-separation")) results["era-separation"] = checkEraSeparation(scenario);
    if (want("prune-neutrality") && shape.pruneBarrier) {
      results["prune-neutrality"] = checkPruneNeutrality(scenario);
    }
    if (want("ghost-neutrality") && shape.ghostProbability > 0) {
      results["ghost-neutrality"] = checkGhostNeutrality(scenario);
    }
    if (want("origin-order")) results["origin-order"] = checkOriginOrder(scenario);
    if (want("stability")) results["stability"] = checkStability(scenario);
    if (want("interleaving")) results["interleaving"] = checkInterleaving(scenario);
    if (want("convergence")) {
      results["convergence"] = checkConvergence(scenario, rng, options.mergeOrders);
    }

    for (const [check, result] of Object.entries(results)) {
      if (result !== null) {
        fail(shape.name === "plain" ? check : `${check} (${shape.name})`, scenario, result);
      }
    }
    if (verbose) {
      console.log(`[seed ${seed}] ${shape.name} scenario:`);
      printScenario(scenario);
      console.log(`  final: ${show(scenario.finals[0])}`);
    }
  }
  return failures;
}

function parseArgs(argv) {
  const options = {
    seeds: 200, from: 1, seed: null, ops: 30, peers: 3, mergeOrders: 20,
    impl: "fuguemax", forever: false, checks: DEFAULT_CHECKS,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seeds") options.seeds = Number(argv[++i]);
    else if (a === "--from") options.from = Number(argv[++i]);
    else if (a === "--seed") options.seed = Number(argv[++i]);
    else if (a === "--ops") options.ops = Number(argv[++i]);
    else if (a === "--peers") options.peers = Number(argv[++i]);
    else if (a === "--merge-orders") options.mergeOrders = Number(argv[++i]);
    else if (a === "--impl") options.impl = argv[++i];
    else if (a === "--forever") options.forever = true;
    else if (a === "--checks") options.checks = argv[++i].split(",");
    else { console.log(`Unknown argument: ${a}`); process.exit(2); }
  }
  return options;
}

const options = parseArgs(process.argv);
if (IMPLS[options.impl] === undefined) {
  console.log(`Unknown --impl "${options.impl}" (choose: ${Object.keys(IMPLS).join(", ")})`);
  process.exit(2);
}
makeList = IMPLS[options.impl];
for (const check of options.checks) {
  if (!ALL_CHECKS.includes(check)) {
    console.log(`Unknown check "${check}" (choose: ${ALL_CHECKS.join(",")})`);
    process.exit(2);
  }
}

if (options.seed !== null) {
  const failures = runSeed(options.seed, options, true);
  process.exit(failures.length === 0 ? 0 : 1);
}

const failingSeeds = new Map();
let checked = 0;
let seed = options.from - 1;
const until = options.forever ? Infinity : options.from + options.seeds - 1;
while (seed < until) {
  seed++;
  checked++;
  const failures = runSeed(seed, options, false);
  for (const check of failures) {
    if (!failingSeeds.has(check)) failingSeeds.set(check, []);
    failingSeeds.get(check).push(seed);
  }
  if (options.forever && failures.length > 0) break;
  if (options.forever && seed % 1000 === 0) console.log(`${seed} seeds checked.`);
}

console.log("-".repeat(72));
console.log(`impl=${options.impl} peers=${options.peers} ops=${options.ops} seeds=${checked}`);
let failed = 0;
for (const check of options.checks) {
  const labels = [...failingSeeds.keys()].filter((k) => k === check || k.startsWith(check + " ("));
  const seeds = [...new Set(labels.flatMap((k) => failingSeeds.get(k)))].sort((a, b) => a - b);
  if (seeds.length === 0) {
    console.log(`  ${check.padEnd(18)} ok (${checked} seeds)`);
  } else {
    failed += seeds.length;
    const shown = seeds.slice(0, 10).join(" ") + (seeds.length > 10 ? " ..." : "");
    console.log(`  ${check.padEnd(18)} ${seeds.length} failing seeds: ${shown}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
