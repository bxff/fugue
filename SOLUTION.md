# Tombstone-transparent FugueMax with explicit replacement

> **Status (2026-09-04): strong research candidate, not yet a proved or
> submission-ready correction.** The implementation passes the retained 12-case
> semantic suite and the current deterministic property profiles. That is
> materially stronger than the previous RO-shifting, Fugue-Era, next-live, and
> publication-handoff experiments, but bounded randomized testing is not a proof.

The candidate is implemented in `fugue-max-simple/src/index.ts`. It preserves
FugueMax's replicated tree and wire operations. Its two additions are:

1. ordinary insertions choose origins from the **live projection** of that
   tree, treating every tombstone as transparent; and
2. a replacement is expressed explicitly with `splice`, which captures the
   pre-deletion gap and lowers to ordinary inserts followed by deletes.

There is no era bit, receiver-side re-anchoring, mutable right origin, or local
transport/publication watermark.

## The semantic contract

### 1. Ghost-history neutrality

Define ghost-equivalent histories at the abstract editing level, before CRDT
origins are generated. Starting with history `H`, `H+G` additionally inserts and
deletes G. After erasing G from every compared view:

- each retained edit has the same author;
- it deletes the same retained token or selects the gap between the same
  retained visible neighbours; and
- no retained edit explicitly targets G or edits a gap incident on G while G
  is visible.

Transport may contain the additional events needed to carry G. Replaying those
corresponding edits must not gain another visible ordering:

```text
visible(final(H)) = visible(final(H+G))
```

The pair may arrive atomically or as a published insert followed later by its
published deletion. It may have been visible while unrelated edits occur
elsewhere. If the broken lowering makes a later insertion structurally depend
on G, that is the failure being detected—not a reason to exclude the history
from the premise. For a same-author local ghost, later fresh operation IDs are
compared up to order-preserving renaming because the ghost consumes a counter.

### 2. Referenced-history preservation

A dead node is not garbage merely because it is invisible. If a surviving or
in-flight insertion has that node in its immutable parent/right-origin support,
the node must remain in the replicated tree so the insertion remains reachable
and all replicas can integrate it. Deletion removes only visibility; it does not
rewrite origins or reorder survivors.

### 3. FugueMax structural controls

The repair must retain:

- reverse-right-origin bucket ordering and same-RO clumping;
- forward non-interleaving for causal continuations;
- insertion/deletion stability: applying one operation cannot reorder existing
  visible nodes; and
- convergence for every fixed operation set and causally legal delivery order.

### 4. Explicit replacement intent

An ordinary insertion after a deletion means insertion into the current
projected visible gap. A logical replacement is a different edit and must use
`splice`. Transport handoff, batching, callback timing, or whether a delete has
already been serialized cannot change either operation's coordinates.

## Why raw `delete; insert` cannot also mean replacement

The decisive ambiguity is the retained D1 case:

```text
shared: A B

X sees only A and inserts X:
  X: LO=A, RO=END

D sees A B, deletes B, then inserts R after A.

M saw B alive and inserts M before B, but M is still in flight:
  M: LO=A, RO=B

choose IDs M < R < X
```

When D creates R, its local state is identical whether M exists or not. There
are nevertheless two legitimate meanings:

```text
ordinary insertion after deletion:
  R uses projected bucket (A,END)
  before M: A R X
  after late M: A R X M

declared replacement of B:
  R uses captured bucket (A,B)
  before M: A X R
  after late M: A X M R
```

Given the same bare API calls and identical local state, with immediate
immutable operation emission and both meanings required, no deterministic
algorithm can infer which bucket R should use: D cannot observe the in-flight
M. Choosing `(A,B)` for all
post-delete inserts restores phantom dependence on an unseen tombstone.
Choosing `(A,END)` for all replacements breaks N7's same-slot grouping.
Waiting for M would either make delivery order semantic or require moving R/X
after they were already visible.

Therefore the impossible promise is not C3. C3 only says that late M/Z remains
reachable and does not move established survivors. The impossible promise is:

> infer, from the same raw `delete(B); insert(R)` state, both ordinary current-gap
> insertion and historical-slot replacement semantics.

An explicit edit-level distinction is necessary unless the operation format is
redesigned to carry equivalent user intent.

## Tombstone-transparent insertion projection

Before generating an ordinary insertion, the replica walks the normal
tombstone-inclusive FugueMax traversal from the visible predecessor and skips
every dead node. The first live successor determines the normal FugueMax
encoding:

- if it lies in the predecessor's right subtree, insert as its left child;
- otherwise insert as a right child of the predecessor with that successor as
  right origin; or use `END` when no successor remains.

This is a generation-time view only. Skipped nodes are not removed, reparented,
or rewritten. Receivers integrate the emitted ordinary FugueMax operation
without recomputing projection from their own knowledge.

This handles both sides of the original problem:

- `B†` cannot manufacture a new bucket or left-child route for an ordinary
  insertion; and
- B† remains physically present as a valid immutable origin for existing or
  late `LO=B`/`RO=B` operations. Physical reachability does not require B† to
  remain a future insertion barrier.

## `splice` lowering

The API is:

```ts
splice(startIndex, deleteCount, ...replacementValues)
```

It performs one logical replacement as follows:

1. snapshot the identities of the live target nodes;
2. insert the replacement run at `startIndex` while those targets are live;
3. delete the snapped targets by identity.

The insertion therefore captures the target's original structural slot without
guessing from a later tombstone. Inserting the whole replacement run first also
preserves its normal FugueMax causal continuation. The emitted primitives and
saved replicated state remain ordinary FugueMax; old receivers need no new wire
message. Integrations must call `splice`/replace inside one runtime transaction
when they require one batched update. Raw `delete` followed by raw `insert`
remains ordinary editing.

Wire compatibility is not the same as mixed-writer semantic compatibility. An
old writer can still generate a new insertion anchored to a tombstone; once
received, that insertion legitimately depends on the tombstone.
A rollout seeking ghost neutrality therefore has to upgrade writers (readers
may remain wire-compatible) or version the editing policy.

The prototype may walk a long consecutive tombstone region for every inserted
scalar. This is suitable for validating the semantics, not a final performance
design. A production implementation should index the next live traversal node
or cache/invalidate that projection and benchmark it against existing workloads.

## Retained case coverage

| Cases | Obligation | Candidate mechanism |
|---|---|---|
| N1-N5 | Atomic/staged ghost-equivalent histories add no variant, including start, interior, route, and chain geometries | Skip every dead node during ordinary origin generation |
| N7 | Replacement has one stable pre-delete slot across fixed IDs, ranges, and replacement runs | Explicit `splice`; insert-before-delete lowering |
| S1-S2 | Deletion never jumps or repeatedly retargets existing content | Immutable origins; visibility-only delete |
| C1 | Preserve reverse-RO buckets and same-bucket clumping | Original FugueMax comparator unchanged |
| C2 | Preserve forward continuation adjacency | Original tree ordering; no global era override |
| C3 | Preserve meaningful `LO=B` and `RO=B` history, including late delivery | Tombstones retained physically; origins remain immutable |
| D1 | Do not conflate ordinary post-delete insertion with replacement | Separate `insert` and `splice` intent |

Published FugueMax fails the five established phantom-history cases N1-N5. N7
is not applicable to it because the published API has no declared replacement
operation. D1 records where its raw post-delete insertion differs from the new
ordinary-insertion contract; that is a design comparison, not a newly proved
historical defect. The candidate currently passes all 12 retained requirements.

## Generalized verification

`fugue-interleave/fuzz_tombstone_properties.js` generates arbitrary legal
multi-replica traces first, then applies independent metamorphic sensors. The
required candidate profile currently checks:

- atomic and staged ghost insertion/deletion transforms;
- same-author local ghost visible neutrality, compared up to the abstract ID
  renaming described above;
- declared-splice versus insert-before-delete lowering, with target/replacement
  runs and concurrent same-gap witnesses;
- the combined D1 intent boundary over arbitrary prefixes, both ID directions,
  and late `RO=target` delivery schedules;
- referenced tombstones through both parent/LO and right-origin edges;
- generalized reverse-RO buckets;
- exact local-index placement plus stepwise insertion/deletion projection;
- forward non-interleaving; and
- convergence.

The deterministic checked bounds currently find zero candidate failures. The
published implementation is separately expected to produce ghost
counterexamples, to lack the splice API, and to differ at the D1 contract
boundary. Exact commands and limits are in
`fugue-interleave/TOMBSTONE_FUZZING.md`.

## The three proof obligations

The proposal does not need a separate proof for every example or preferred
output. It needs three compositional arguments:

1. **Admissibility and convergence reduction.** A projected local insertion
   chooses causally known FugueMax origins, appears at the requested visible
   index, and emits an ordinary immutable FugueMax operation. Deletes only
   change visibility. Fixed-operation convergence, survivor stability, late
   reference integration, reverse-RO clumping, and forward non-interleaving
   then reduce to the applicable published FugueMax arguments.
2. **Ghost erasure.** For the abstract ghost-equivalence relation above,
   erasing the extra insert/delete component and order-preservingly renaming
   same-author fresh IDs commutes with ordinary lowering at every paired cut.
   This requires a tree/traversal erasure homomorphism and a stepwise simulation:
   because every dead node is transparent during generation, corresponding
   retained edits select the same projected live gap and cannot gain another
   visible ordering.
3. **Splice refinement.** Snapshotting the live target identities, inserting
   the replacement run before deletion, and deleting those identities refines
   one captured-gap replacement. The API and its specified primitive lowering
   must emit the same sequence of ordinary FugueMax operations, remain
   equivalent under concurrent delivery, and define whether callers receive
   one runtime transaction or several observable callbacks.

Exact strings such as `ARXM`/`AXMR`, reverse-RO as a product policy, and the
choice between ordinary insertion and replacement are semantic contracts tested
over generalized families; they are not additional correctness theorems. Raw
`delete; insert` commutation is intentionally false and must not be proved.

## Engineering evidence still needed

Before calling this a perfected or submission-ready algorithm, the finite
evidence should still add bounded exhaustive causal schedules, known-bad
mutants for each sensor, arbitrary restart/save-load cuts, nested and chained
origin geometries, and concurrent overlapping range splices. Real editor
replacement actions must use `splice`, and the tombstone walk needs workload
benchmarks. These are model-checking, integration, and performance tasks—not a
growing list of semantic proofs. The same-author sensor is retained in the gate
even though current searches do not distinguish published FugueMax on that
subcase; it protects the stated contract rather than contributing to the
published-defect score.

The defensible current statement is:

> Tombstone-transparent FugueMax plus explicit splice is a transport-independent
> candidate that resolves every retained minimal counterexample and passes the
> present generalized sensors. It should be submitted as a proposal with its
> test evidence and open proof obligations, not yet as a perfected algorithm.
