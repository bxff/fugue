# Projected-gap FugueMax experiment

> **Status (2026-09-04): not a completed or submission-ready correction.**
> The projection itself repairs the remote phantom-barrier examples, but the
> local remembered-gap rule below is transport-dependent. The same
> `delete(B); insert(C)` edit emits a different insertion operation depending
> only on whether `delete(B)` was handed to the sync layer first. The
> strengthened N7 test and generalized commutation sensor expose this defect.
> This file documents the experiment and the remaining design decision; it is
> not a proof that FugueMax has been perfected.

This document describes the current tombstone-repair candidate in
`fugue-max-simple/src/index.ts`. It replaces the rejected Fugue-Era design.
The experiment is intentionally narrow: it removes ordering effects caused only by
invisible insert-delete history, while retaining published FugueMax's tree,
reverse-right-origin buckets, and non-interleaving behavior.

## The two laws

The implementation is designed around two metamorphic laws rather than one
preferred example output.

1. **Ghost neutrality.** If a token is inserted and deleted and no surviving
   operation structurally references it, adding that history must not alter
   the placement of later surviving edits. This includes a peer receiving the
   insert and delete together, receiving the published insert and published
   delete separately but making no intervening operation that references the
   token, and a local insert-delete pair still in its outbox.
2. **Replacement commutation.** With authors and concurrent operations fixed,
   inserting `C` immediately before live `B` and then deleting `B` must agree
   with deleting `B` and inserting `C` into `B`'s former gap. A transport
   handoff between the two primitive commands must not change that result.

These laws explain why neither of the old extremes works:

- retaining every known tombstone as the next insert's structural boundary
  violates ghost neutrality;
- always using the next live right origin violates replacement commutation
  (N7) and can move an insertion across a reverse-RO bucket.

## Local outbox state

The CRDT tracks two local-only maps:

- local insertions not yet handed to the sync layer;
- local deletions not yet handed to the sync layer.

The outbox handoff is represented by a monotonic local watermark. An application
captures `captureLocalPublicationFrontier()` when it constructs an outgoing
batch, then calls `markLocalUpdatesSent(frontier)` when that exact batch is
handed to the sync layer. Calling `markLocalUpdatesSent()` without an argument
is the convenient flush-all form. It must not be called merely because a local
edit transaction ended.

Here “handed to the sync layer” means an irrevocable ownership transfer to the
transport or durable outbox—not that a peer has already applied the bytes. The
benchmark adapter treats its `updateHandler` callback as that transfer. An
integration whose callback merely observes or temporarily buffers bytes must
acknowledge the captured frontier later instead. Reading or serializing a
snapshot never advances publication state.

The watermark matters for a real asynchronous outbox. If batch 1 is waiting
while the user creates batch 2, publishing batch 1 must not accidentally mark
batch 2's deletion as published. The old set-clearing prototype had exactly
that ambiguity; acknowledging a captured prefix removes it.

This boundary cannot be inferred inside an operation-based CRDT. `sendPrimitive`
means "give this update to the application's transport"; it does not say that a
peer received it. Basing placement on guessed delivery or acknowledgement
timing would itself create the timing-dependent variants the repair is intended
to remove.

The implemented experimental state machine for a dead node is (here “handed
off” means handed to the local sync/transport layer, not acknowledged by a
peer):

| Insert | Delete | Meaning to a new local insertion |
|---|---|---|
| still local | still local | cancellable ghost; transparent |
| already handed off/remote | still local | remembered deleted gap; retained |
| any | already handed off/remote | historical tombstone; transparent unless reached through live descendants |

Thus a queued insert-delete pair cannot redirect later local operations, while
a queued deletion of established content remembers exactly the gap needed for
replacement typing. Once the deletion is handed off, later edits use the current
visible gap; there is no permanent "era" attached to the tombstone.

That last transition is the known flaw. Transport scheduling is not user edit
intent. In the real adapters, every emitted update is handed off immediately,
so ordinary backspace followed by typing normally takes the transparent branch
and fails the N7 comparison. Delaying the callback makes the same edits pass.

This is intended to cover a published insert that becomes irrelevant later. A
recipient may see the insert alive for an arbitrary interval and cross arbitrary
network boundaries. It may even edit elsewhere. If it creates no operation
referencing that token during
the interval, then after the separately published delete arrives its next
insertion uses the same projected gap as a replica that never knew the token.
Publication alone does not make a dead token a permanent boundary.

## Projected insertion tree

Deletes never restructure the replicated FugueMax tree. They only mark nodes
deleted; the device-local outbox state stays outside the replicated tree.
When generating an insertion at visible index `i`:

1. Find the visible predecessor `L` (or the root sentinel).
2. Walk forward from `L` in the tombstone-inclusive FugueMax traversal.
3. Ignore a dead node unless it is an established node whose locally generated
   deletion has not yet been handed to the sync layer. Ignoring a node does not
   ignore its descendants; live descendants remain meaningful positions.
4. Let `R` be the first node that survives this projection, or end-of-list.
5. If `R` is in `L`'s right subtree, encode the insertion as a left child of
   `R`. Otherwise encode it as a right child of `L` with right origin `R`.

The emitted insertion is an ordinary immutable FugueMax operation. Receivers do
not repeat a knowledge-dependent walk and do not re-anchor it. Siblings use the
published ordering exactly:

- right children: reverse right-origin order, then immutable ID;
- left children: immutable ID.

Consequently delete-free executions use published FugueMax placement. Deletes
never re-sort existing siblings.

## Why the cases pass

- **N1-N5 / generalized remote ghosts:** a received dead node is absent from
  the insertion projection, including the left-child route and dead chains.
- **Local ghost property:** a node present in both unpublished maps is absent
  from the projection, so the next insertion gets the same structural bucket
  as if the pair had never occurred.
- **N7 / generalized replacement commutation:** the experiment passes only
  while `delete(B)` remains in the local outbox. It fails after handoff because
  `C` moves from B's bucket to the projected live-successor bucket. The test
  covers both schedules, a `B` created earlier by the replacing author, and
  deletion runs of length one to three.
- **S1-S2:** deletion changes visibility only; no origin is rewritten and no
  sibling array is re-sorted.
- **C1:** the reverse-RO comparator is unchanged.
- **C2:** no era bit can override FugueMax's tree and split `P -> Q`.
- **C3:** skipping a tombstone does not discard its live descendants. A
  same-outbox local replacement also retains the deleted gap until handoff.

## What is and is not claimed

### The unresolved intent ambiguity

The primitive sequence `delete(B); insert(Y)` does not say whether the user is
performing a logical replacement in B's old slot or a separate later insertion
into the new visible gap. Those meanings demand different immutable FugueMax
coordinates. Outbox timing cannot safely select between them, and waiting for
a later reference to B would make existing text move or make delivery order
matter.

A transport-independent design therefore needs an explicit edit-level
distinction. The clearest current direction is a `splice`/`replace` operation
that captures the pre-edit gap and emits the replacement run there before
tombstoning its targets. Ordinary primitive insertion after a deletion would
always use the projected live gap. N7 would then compare two internal schedules
of the same declared splice, rather than infer replacement intent from adjacent
raw calls. This design has not yet been implemented or proved here.

### The in-flight-reference boundary

Suppose `G` was already handed to sync and another replica authored continuation
`X` while `G` was live. If `X` is still in flight when a different replica
receives `delete(G)` and types `Y`, the dead `G` must remain in the replicated
tree so late `X` still has a valid origin. It is only transparent to the local
projection that chooses Y's new origins.

C3 therefore requires reference safety: every delivery order converges,
deleting `G` removes only `G`, and receiving late `X` adds only `X` without
moving established survivors. When delete(G) was handed to sync before Y was
typed and Y did not know X, the remaining immutable FugueMax structure decides
their relative order; both `YX` and `XY` can be valid under different ID
assignments. No universal Y-before-X rule is part of C3 or this algorithm.

The implementation gives semantic neutrality, not immediate physical garbage
collection. Insert and delete operations still exist in the causal operation
log because another replica may already reference them—or may have authored a
reference while the insert was live that is still in flight. Such a reference
remains valid because the replicated tree is never rewritten and projection
walks through skipped tombstones to their live descendants. Safe tombstone/log
GC requires protocol-level stability or acknowledgements and is a separate
task.

The explicit publication frontier is part of this experiment's integration contract.
Without an outbox boundary, "unsynced" has no well-defined meaning and the N7
command-order law cannot be scoped correctly. `saveLocalPublicationState()` and
`loadLocalPublicationState()` persist that device-local watermark and its
not-yet-handed-off node IDs beside the transport's durable outbox. This state is
deliberately absent from replicated snapshots, so restoring a mid-outbox
checkpoint requires both pieces; alternatively the application can flush
before saving. The local blob contains a fingerprint of the exact Fugue tree
and rejects a mismatched shared snapshot, catching both ordinary torn-write
directions. Publication-only changes leave the tree unchanged, so the shared
snapshot, local blob, and durable outbox must still be committed atomically as
one local checkpoint. Restoration must use a fresh replica ID: like the original
`fugue-max-simple`, the per-replica insertion counter is intentionally not in
the replicated snapshot, so reusing the old ID would create duplicate node
IDs. The local checkpoint records the old ID and rejects that unsafe restore.

The present evidence is neither a completion claim nor a machine-checked proof.
The experiment passes the remote, staged-published, and local-outbox ghost
transformations, reverse-RO buckets, stepwise stability, forward
non-interleaving, convergence, and the currently generated late-`LO` reference
cases. It fails deletion/insertion commutation when a transport handoff occurs
between those edits. The fuzzer also does not yet cover all `RO=G`, left-child,
tombstone-chain, restart, and causal-delivery geometries. The
experimental backward checker is not a validity oracle: it reports published
FugueMax itself on traces where its premise reconstruction is incomplete, so it
remains outside the required profile.

## Independent audit outcome

Four independent reviews of the algorithm, semantic contract, fuzzer, and
alternative design reached the same conclusion:

- N1-N5 are real published-FugueMax failures; N7 and C3 are not the only
  important cases. N7/C3 constrain repairs, while S1/S2/C1/C2 protect deletion
  stability, reverse-RO clumping, and non-interleaving.
- the generalized fuzzer is useful metamorphic testing over arbitrary settled
  prefixes, but its N7 and C3 extensions are still bounded templates rather
  than an exhaustive state-space proof;
- the handoff-dependent N7 failure is reproducible both minimally and in 261
  of 300 deterministic generalized trials with the current seed; and
- a credible next design should remove transport state from origins and expose
  replacement as explicit splice/edit intent, then broaden C3 generation to
  `LO=G`, `RO=G`, left-child, chain, restart, and all causal-delivery cases.

Accordingly, this repository is an audited research checkpoint with a strong
test harness and a falsified candidate—not yet a corrected Fugue algorithm that
should be presented as complete.
