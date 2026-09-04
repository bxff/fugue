# Support-projected FugueMax with explicit replacement

> **Status (2026-09-04): strong research candidate, not yet a proved or
> submission-ready correction.** The implementation passes the retained 12-case
> semantic suite and the current deterministic property profiles. That is
> materially stronger than the previous RO-shifting, Fugue-Era, next-live, and
> publication-handoff experiments, but bounded randomized testing is not a proof.

The candidate is implemented in `fugue-max-simple/src/index.ts`. It preserves
FugueMax's replicated tree and wire operations. Its two additions are:

1. ordinary insertions choose origins from a **support-aware visible
   projection** of that tree; and
2. a replacement is expressed explicitly with `splice`, which captures the
   pre-deletion gap and lowers to ordinary inserts followed by deletes.

There is no era bit, receiver-side re-anchoring, mutable right origin, or local
transport/publication watermark.

## The semantic contract

### 1. Ghost-history neutrality

Let `H+G` be a history obtained from `H` by adding an insert/delete history `G`
that no surviving operation structurally depends on. Replaying the same visible
edits with the same author identities must not gain another visible ordering:

```text
visible(final(H)) = visible(final(H+G))
```

The pair may arrive atomically or as a published insert followed later by its
published deletion. It may have been visible for a time. What matters is
structural support: if no surviving operation uses it through a parent or right
origin, its tombstone must not redirect a later ordinary insertion.

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

No deterministic algorithm can infer which immutable bucket R should use from
the raw local state: D cannot observe the in-flight M. Choosing `(A,B)` for all
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

## Support-aware projection

Each inserted node already has immutable structural dependencies:

- `parent` (the tree edge encoding its side/left-origin geometry); and
- `rightOrigin`, for a right child.

Before generating an ordinary insertion, the replica computes the transitive
support closure of every live node:

```text
support = least set containing every live node
          and closed under parent and non-END rightOrigin edges
```

It then walks the normal tombstone-inclusive FugueMax traversal from the visible
predecessor, skipping a dead node only when that node is outside `support`.
The first non-skipped successor determines the normal FugueMax encoding:

- if it lies in the predecessor's right subtree, insert as its left child;
- otherwise insert as a right child of the predecessor with that successor as
  right origin; or use `END` when no successor remains.

This is a generation-time view only. Skipped nodes are not removed, reparented,
or rewritten. Receivers integrate the emitted ordinary FugueMax operation
without recomputing projection from their own knowledge.

This distinction handles both sides of the original problem:

- an unsupported `B†` cannot manufacture a new bucket or left-child route;
- a `B†` supporting live `Z` remains in the closure and a valid structural
  anchor, including when Z arrives after the delete.

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
message. Integrations must call `splice`/replace when that is the user's
logical action. Raw `delete` followed by raw `insert` remains ordinary editing.

Wire compatibility is not the same as mixed-writer semantic compatibility. An
old writer can still generate a new insertion anchored to an unsupported
tombstone; once received, that insertion legitimately supports the tombstone.
A rollout seeking ghost neutrality therefore has to upgrade writers (readers
may remain wire-compatible) or version the editing policy.

The prototype recomputes the live support closure for every inserted scalar,
which is linear in retained tree size. This is suitable for validating the
semantics, not a final performance design. A production implementation should
maintain dependency support counts or cache/invalidate the closure and then
benchmark it against the existing workloads.

## Retained case coverage

| Cases | Obligation | Candidate mechanism |
|---|---|---|
| N1-N5 | Atomic/staged unsupported ghosts add no variant, including start, interior, route, and chain geometries | Skip unsupported dead nodes during origin generation |
| N7 | Replacement has one stable pre-delete slot across fixed IDs, ranges, and replacement runs | Explicit `splice`; insert-before-delete lowering |
| S1-S2 | Deletion never jumps or repeatedly retargets existing content | Immutable origins; visibility-only delete |
| C1 | Preserve reverse-RO buckets and same-bucket clumping | Original FugueMax comparator unchanged |
| C2 | Preserve forward continuation adjacency | Original tree ordering; no global era override |
| C3 | Preserve meaningful `LO=B` and `RO=B` history, including late delivery | Parent/RO support closure; tombstones retained |
| D1 | Do not conflate ordinary post-delete insertion with replacement | Separate `insert` and `splice` intent |

Published FugueMax fails N1-N5 and D1's ordinary-insertion branch; it also lacks
the declared-splice equivalence required by N7. The candidate currently passes
all 12 retained cases. These are semantic comparisons, not merely convergence
checks.

## Generalized verification

`fugue-interleave/fuzz_tombstone_properties.js` generates arbitrary legal
multi-replica traces first, then applies independent metamorphic sensors. The
required candidate profile currently checks:

- atomic and staged ghost insertion/deletion transforms;
- local ghost structural neutrality;
- transport-stutter invariance;
- declared-splice versus insert-before-delete lowering, with target/replacement
  runs and concurrent same-gap witnesses;
- the combined D1 intent boundary over arbitrary prefixes, both ID directions,
  and late `RO=target` delivery schedules;
- referenced tombstones through both parent/LO and right-origin edges;
- generalized reverse-RO buckets;
- stepwise insertion/deletion projection;
- forward non-interleaving; and
- convergence.

The deterministic checked bounds currently find zero candidate failures. The
published implementation is separately expected to produce counterexamples for
the published-bug and splice/D1-facing sensors. Exact commands and limits are in
`fugue-interleave/TOMBSTONE_FUZZING.md`.

## What remains before a “corrected Fugue” claim

This is the closest candidate in the repository, but it is not yet a proof of a
perfected algorithm. At minimum, the following remain:

1. bounded exhaustive enumeration of small causal histories and all legal
   deliveries, not only seeded random traces;
2. deeper support geometries: alternating parent/RO chains, nested left-child
   routes, several tombstones, and references that become live/dead repeatedly;
3. restart/save-load tests interleaved at arbitrary cuts;
4. multi-element and overlapping splices concurrent with edits inside and at
   both ends of the replaced range;
5. adversarial mutants demonstrating that every sensor rejects its intended
   broken strategy rather than passing vacuously;
6. a precise abstract specification and proof of convergence, projection
   stability, ghost quotient invariance, and preserved FugueMax
   non-interleaving; and
7. integration review: editors that currently lower replacement to separate
   delete/insert calls must adopt the explicit API to obtain replacement
   semantics.

The defensible current statement is:

> Support-projected FugueMax plus explicit splice is a transport-independent
> candidate that resolves every retained minimal counterexample and passes the
> present generalized sensors. It should be submitted as a proposal with its
> test evidence and open proof obligations, not yet as a perfected algorithm.
