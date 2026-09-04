# Phantom Barriers in FugueMax: Problem Statement

> **NOTE (2026-09-04): this document is the historical problem statement and
> is partially stale.** It describes the old 3-part fix (RO shifting,
> `replacementRightOrigin`, chain-hopper) as "the current implementation" —
> that machinery was removed and replaced.
> Problem 1 and Problem 2 below remain accurate descriptions of the
> *phenomena*; the "What happens" paragraphs reflect the state of the old
> fix and no longer describe the code. [`SOLUTION.md`](SOLUTION.md) records
> the current support-projection + explicit-splice candidate, its retained
> semantic contract, and the proof work still required.

## Background

FugueMax is a tree-based CRDT for collaborative text editing. The document order is the depth-first in-order traversal of the tree. Each inserted character carries two references:

- **Left Origin (LO)**: The node immediately to the left of the insertion point at the time of insertion. Determines the parent in the tree.
- **Right Origin (RO)**: The node immediately to the right of the insertion point at the time of insertion. Used for ordering among right siblings (reverse RO order, tie-break by sender ID).

When a node is deleted, it becomes a **tombstone** — it stays in the tree but is invisible in the document output. Tombstones preserve structural relationships for concurrent operations that may reference them.

## The Problem: Tombstones as Phantom Barriers

Tombstones can act as invisible barriers that corrupt the ordering semantics of future insertions. This manifests on both the RO side and the LO side.

### Problem 1: RO Phantom Barriers

**Setup:** Peers share a document `a, b`. Peer 1 inserts `y` between `a` and `b`, giving `a, y, b` with y having LO=a, RO=b. Then `b` (and potentially further nodes) are deleted.

**What happens:** When `b` is deleted, y's RO=b must be "shifted" because b is now a tombstone. The current implementation replaces y's RO with the next alive node to the right (via `nextNonDescendantAlive`). If all nodes to the right of b are also deleted, y's RO gets shifted all the way to null (end of document).

**Why this is wrong:** y was originally inserted with a specific relationship to b. That relationship carries ordering information. When y's RO is shifted from b to some distant alive node (or null), the structural information about where y was positioned relative to b is lost. This can cause incorrect ordering when concurrent insertions arrive that also reference b or nodes near b.

**Concrete scenario:** `a, b, c, d` on all peers. Peer 1 inserts `y` (LO=a, RO=b). Peer 2 deletes `b` and `d`. After convergence, y's RO has been shifted away from b. A third peer's concurrent insert referencing b will now be ordered against y using the shifted RO rather than the original shared reference point b, potentially producing incorrect interleaving.

### Problem 2: LO Phantom Barriers

**Setup:** A node's left origin determines whether the new node becomes a right child of the LO or a left child of the next node (the RO). The decision depends on whether the LO has right children.

**What happens:** The current code checks `leftOrigin.rightChildren.length === 0` to decide the insertion path. But this does NOT filter tombstones. When all of leftOrigin's right children are tombstones, the code takes the wrong branch — it makes the new node a left child of the leftmost tombstone descendant, instead of a right child of the leftOrigin.

**Why this is wrong:** The new node's parent becomes a tombstone, and its LO is effectively the tombstone rather than the intended alive node. This produces a different tree structure than if the tombstones didn't exist, meaning tombstones are acting as phantom barriers that influence insertion behavior despite being invisible.

**Concrete scenario:** Document is `a, b, c`. Delete `b`. Now `a` has right children `[b(tombstone)]`. A user inserts between `a` and `c`. The code sees `a.rightChildren.length > 0` (because of tombstone b), takes the else branch, and makes the new node a left child of b(tombstone). The correct behavior: since b is a tombstone and invisible, the new node should become a right child of `a` with RO=c — as if b didn't exist.

**The deeper issue — LO shifting on delete:** Even if we fix the generation-time check to skip tombstones, there's a reception-side problem. When a node is deleted, its existing left children are now children of a tombstone. These left children's LO is effectively the tombstone, but their intended LO relationship was to the position the tombstone occupied. Unlike the RO side (where we have a chain-hopper mechanism to redirect through `replacementRightOrigin`), there is no analogous mechanism for LO. Left children of deleted nodes need to be "re-parented" — but doing this correctly while maintaining convergence across all operation orderings is the core unsolved problem.

### Why These Problems Are Hard

Both problems share a root cause: **the algorithm was designed for a world where tombstones are inert structural artifacts, but in practice they actively influence insertion decisions**.

The RO fix requires preserving the tombstone reference while still producing correct sibling ordering across all replicas. The LO fix requires re-parenting children of tombstones while ensuring that all replicas converge to the same tree structure regardless of the order in which operations are received.

The convergence constraint is the fundamental difficulty: any fix must guarantee that applying the same set of operations in any order produces the same final document on every replica.

## Scope

This problem statement covers Points 1 and 2. There is a separate Point 3 (the "bdac" problem with concurrent same-LO/same-RO siblings) which is not a tombstone issue and is set aside for now.

## Reference Implementation

The current implementation is in `fugue-max-simple/src/index.ts`. Test scenarios are in `fugue-interleave/index.js`. The relevant code paths are:

- **Insert generation:** `insertOne()` — computes LO, RO, parent, side
- **Insert reception:** `addNode()` — resolves RO through chain-hopper, inserts into sibling order
- **Delete reception:** `receivePrimitive` delete case — computes replacement RO, eagerly updates all nodes referencing the deleted node
- **Sibling ordering:** `insertIntoSiblings()` — reverse RO order for right children, sender ID for left children
- **RO chain-hopper:** `resolveRightOrigin()` — follows `replacementRightOrigin` pointers through tombstones
