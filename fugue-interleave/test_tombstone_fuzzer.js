// Unit tests for the generalized sensors. These are checker tests, not CRDT
// scenario tests: they pin conservative handling of deleted/future siblings and
// the observed-order closure used by PR #36's method.

import assert from "node:assert/strict";
import { CRuntime } from "@collabs/collabs";
import { FugueMaxSimple as PublishedFugueMax } from "fugue-max-canonical";
import { FugueMaxSimple as CurrentFugueMax } from "fugue-max-simple";
import { FugueSimple } from "fugue-simple";
import {
  checkBackwardNonInterleaving,
  checkDeleteInsertCommutation,
  checkForwardNonInterleaving,
  checkLocalGhostNeutrality,
  checkReferencedTombstone,
  checkReverseROBuckets,
  checkStagedGhostNeutrality,
  generateTrace,
  replayWithInvisibleGhost,
  structuralBucket,
} from "./fuzz_tombstone_properties.js";

const START = "<start>";
const END = "<end>";

function publicationDoc(replicaID, savedState = null, localState = null) {
  const runtime = new CRuntime({ debugReplicaID: replicaID });
  const sends = [];
  runtime.on("Send", ({ message }) => sends.push(new Uint8Array(message)));
  const list = runtime.registerCollab("array", (init) => new CurrentFugueMax(init));
  if (savedState !== null) runtime.load(savedState);
  if (localState !== null) list.loadLocalPublicationState(localState);
  return { runtime, list, sends };
}

function character(token, leftOrigin = START, rightOrigin = END) {
  return [token, { token, leftOrigin, rightOrigin }];
}

function event(state, commandIndex = 0, inserted = state.at(-1)) {
  return {
    commandIndex,
    local: true,
    action: { kind: "insert", token: inserted },
    state,
  };
}

function synthetic(characters, logs) {
  return {
    seed: "synthetic/trace/0",
    generation: { clients: logs.size, steps: 0, module: "synthetic" },
    commands: [],
    characters: new Map(characters),
    logs,
  };
}

// A deleted sibling that was visibly earlier means B was not the earliest
// left-origin child; it must continue to exempt B after deletion.
{
  const trace = synthetic([
    character("a"),
    character("b", "a"),
    character("c", "b"),
    character("x", "a"),
    character("y", "x"),
  ], new Map([["r0", [
    event(["a", "b", "c", "x", "y"], 0),
    { commandIndex: 1, local: true, action: { kind: "delete", token: "b" }, state: ["a", "c", "x", "y"] },
  ]]]));
  assert.equal(checkForwardNonInterleaving(trace), null);
}

// A sibling inserted only in the future cannot retroactively excuse an
// already-observed interleaving.
{
  const trace = synthetic([
    character("a"),
    character("b", "a"),
    character("c", "a"),
    character("x"),
  ], new Map([["r0", [
    event(["a", "x", "b"], 0, "b"),
    event(["a", "c", "x", "b"], 1, "c"),
  ]]]));
  assert.equal(checkForwardNonInterleaving(trace)?.sensor, "forward-non-interleaving");
}

// A sibling seen by another replica likewise cannot rewrite the first
// replica's earlier state.
{
  const trace = synthetic([
    character("a"),
    character("b", "a"),
    character("c", "a"),
    character("x"),
  ], new Map([
    ["r0", [event(["a", "x", "b"], 0, "b")]],
    ["r1", [event(["a", "c", "b"], 1, "c")]],
  ]));
  assert.equal(checkForwardNonInterleaving(trace)?.sensor, "forward-non-interleaving");
}

// When a delivered/deleted sibling has no provable order relative to B, the
// checker must accept instead of inventing a total order.
{
  const trace = synthetic([
    character("a"),
    character("b", "a"),
    character("c", "a"),
    character("x"),
  ], new Map([["r0", [
    event(["c"], 0, "c"),
    event(["a", "x", "b"], 1, "b"),
  ]]]));
  assert.equal(checkForwardNonInterleaving(trace), null);
}

// Conversely, observed b<x and x<c prove b<c transitively, making the
// interleaving at a,z,b certain rather than unresolved.
{
  const trace = synthetic([
    character("a"),
    character("b", "a"),
    character("c", "a"),
    character("x"),
    character("z"),
  ], new Map([["r0", [
    event(["b", "x"], 0, "x"),
    event(["x", "c"], 1, "c"),
    event(["a", "z", "b"], 2, "b"),
  ]]]));
  assert.equal(checkForwardNonInterleaving(trace)?.sensor, "forward-non-interleaving");
}

// Backward checking is intentionally narrower: equal LOs make theorem 5
// impossible, while different LOs are conservatively left undecided.
{
  const equalOrigins = synthetic([
    character("l"),
    character("a", "l", "b"),
    character("b", "l"),
    character("x"),
  ], new Map([["r0", [event(["l", "a", "x", "b"], 0, "x")]]]));
  assert.equal(checkBackwardNonInterleaving(equalOrigins)?.sensor, "backward-non-interleaving");

  const differentOrigins = synthetic([
    character("l"),
    character("a", "l", "b"),
    character("b", START),
    character("x"),
  ], new Map([["r0", [event(["l", "a", "x", "b"], 0, "x")]]]));
  assert.equal(checkBackwardNonInterleaving(differentOrigins), null);
}

// Integration smoke test: an independently generated arbitrary trace and an
// independently chosen ghost cut rediscover published FugueMax's root case.
{
  const options = { clients: 3, steps: 20 };
  const seed = "general-tombstone-traces-v1/trace/0";
  const trace = generateTrace(PublishedFugueMax, seed, options);
  const found = replayWithInvisibleGhost(
    PublishedFugueMax,
    trace,
    `${seed}/ghost/1`,
    1
  );
  assert.equal(found?.sensor, "ghost-neutrality");
  assert.notDeepEqual(found.witness.baseline, found.witness.withGhost);
  assert.equal(replayWithInvisibleGhost(
    CurrentFugueMax,
    generateTrace(CurrentFugueMax, seed, options),
    `${seed}/ghost/1`,
    1
  ), null);

  // A same-author unsynced insert-delete pair must not alter the structural
  // bucket of that author's next insertion. Published FugueMax leaks the
  // ghost; the working candidate projects it away.
  assert.equal(checkLocalGhostNeutrality(
    PublishedFugueMax,
    trace,
    `${seed}/local-ghost/0`,
    0
  )?.sensor, "local-ghost-neutrality");
  assert.equal(checkLocalGhostNeutrality(
    CurrentFugueMax,
    generateTrace(CurrentFugueMax, seed, options),
    `${seed}/local-ghost/0`,
    0
  ), null);


  // Publication of the insert is not enough to make it permanently
  // meaningful. If a receiver makes no edit while it is visible, then a
  // separately published delete must make the pair neutral for later edits.
  assert.equal(checkStagedGhostNeutrality(
    PublishedFugueMax,
    trace,
    `${seed}/staged-ghost/0`,
    0
  )?.sensor, "staged-ghost-neutrality");
  assert.equal(checkStagedGhostNeutrality(
    CurrentFugueMax,
    generateTrace(CurrentFugueMax, seed, options),
    `${seed}/staged-ghost/0`,
    0
  ), null);

  // The converse is a safety control: an edit performed during that live
  // interval really references the token. It must survive, converge, and be a
  // pure late insertion. There is no Y<X requirement when Y's author did not
  // know the in-flight X; immutable FugueMax structure decides that order.
  assert.equal(checkReferencedTombstone(
    PublishedFugueMax,
    trace,
    `${seed}/referenced-tombstone/0`,
    0
  ), null);
  assert.equal(checkReferencedTombstone(
    CurrentFugueMax,
    generateTrace(CurrentFugueMax, seed, options),
    `${seed}/referenced-tombstone/0`,
    0
  ), null);

  // N7's commuting square holds author identities fixed while swapping only
  // insert-before-B/delete-B. Canonical FugueMax keeps B as the coordinate.
  // The current candidate is deliberately expected to expose its known
  // handoff-timing defect until the replacement rule is redesigned.
  assert.equal(checkDeleteInsertCommutation(
    PublishedFugueMax,
    trace,
    `${seed}/commutation/0`,
    0
  ), null);
  assert.equal(checkDeleteInsertCommutation(
    CurrentFugueMax,
    generateTrace(CurrentFugueMax, seed, options),
    `${seed}/commutation/0`,
    0
  )?.sensor, "delete-insert-commutation");

  // The outer-bucket clause is the opposite kind of check: published
  // FugueMax must preserve descending RO buckets over the same arbitrary base.
  assert.equal(checkReverseROBuckets(
    PublishedFugueMax,
    trace,
    `${seed}/bucket/0`,
    0
  ), null);
  assert.equal(checkReverseROBuckets(
    FugueSimple,
    generateTrace(FugueSimple, seed, options),
    `${seed}/bucket/0`,
    0
  )?.sensor, "reverse-ro-buckets");
}

// Publication metadata is local durable-outbox state, not replicated state.
// Restoring it beside a shared snapshot must preserve N7's remembered gap;
// restoring the shared snapshot alone deliberately uses the published-gap
// projection. Captured watermarks also acknowledge only their own prefix.
{
  const base = publicationDoc("base");
  base.runtime.transact(() => base.list.insert(0, "A", "B"));
  base.list.markLocalUpdatesSent();
  const baseSave = base.runtime.save();

  const insertThenDelete = publicationDoc("replacement", baseSave);
  insertThenDelete.runtime.transact(() => insertThenDelete.list.insert(1, "C"));
  const beforeDeleteBucket = structuralBucket(insertThenDelete.sends.at(-1));
  insertThenDelete.runtime.transact(() => insertThenDelete.list.delete(2));

  const pendingDelete = publicationDoc("replacement", baseSave);
  const staleLocalState = pendingDelete.list.saveLocalPublicationState();
  pendingDelete.runtime.transact(() => pendingDelete.list.delete(1));
  const deleteFrontier = pendingDelete.list.captureLocalPublicationFrontier();
  const afterDeleteSave = pendingDelete.runtime.save();
  const pendingState = pendingDelete.list.saveLocalPublicationState();

  assert.throws(
    () => publicationDoc("torn-new-shared", afterDeleteSave, staleLocalState),
    /does not match/
  );
  assert.throws(
    () => publicationDoc("torn-new-local", baseSave, pendingState),
    /does not match/
  );

  assert.throws(
    () => publicationDoc("replacement", afterDeleteSave, pendingState),
    /fresh replica ID/
  );

  const restored = publicationDoc(
    "replacement-after-restart",
    afterDeleteSave,
    pendingState
  );
  restored.runtime.transact(() => restored.list.insert(1, "C"));
  const restoredBucket = structuralBucket(restored.sends.at(-1));
  assert.equal(restoredBucket, beforeDeleteBucket);

  const sharedStateOnly = publicationDoc(
    "replacement-without-local-state",
    afterDeleteSave
  );
  sharedStateOnly.runtime.transact(() => sharedStateOnly.list.insert(1, "C"));
  assert.notEqual(structuralBucket(sharedStateOnly.sends.at(-1)), beforeDeleteBucket);

  // Publishing the delete's captured prefix must leave the later C pending.
  restored.list.markLocalUpdatesSent(deleteFrontier);
  let publicationState = JSON.parse(
    new TextDecoder().decode(restored.list.saveLocalPublicationState())
  );
  assert.equal(publicationState.pendingDeletes.length, 0);
  assert.equal(publicationState.pendingInserts.length, 1);

  // An old acknowledgement is harmless; a future one is invalid.
  restored.list.markLocalUpdatesSent(0);
  assert.throws(() => restored.list.markLocalUpdatesSent(999));
  restored.list.markLocalUpdatesSent();
  publicationState = JSON.parse(
    new TextDecoder().decode(restored.list.saveLocalPublicationState())
  );
  assert.equal(publicationState.pendingInserts.length, 0);
}

console.log("generalized tombstone fuzzer: checker tests passed");
