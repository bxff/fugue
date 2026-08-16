# Solving Phantom Barriers: Era-Anchored Insertion

This documents the complete solution to Points 1 and 2 (the tombstone /
phantom-barrier problems), stated in terms of left and right origins.
Point 3 (bdac) is structural, unrelated to tombstones, and unaffected.

## 1. The two principles the solution is built on

**P1 — Stability.** The total order over all nodes (alive and dead) is
determined by insert operations alone. A delete only toggles visibility.
Nothing ever moves, no origin is ever rewritten, nothing is recomputed
when a delete arrives.

This *is* the answer to Point 1. In `a,b → ayb… → delete b,d → ay…`,
y's right origin stays b — the tombstone chain — forever. The chain
"…" keeps encoding where y belongs. Shifting y's RO to the right end
(the old fix) destroyed that information; the chain-hopper and
`updateRightOriginsOnDelete` are deleted outright. Convergence becomes
trivial: the placement of every node is baked into its op, so any
delivery order yields the same tree. The convergence trap around LO
shifting dissolves the same way — there is no delete-time restructuring
left to trap.

**P2 — Era encoding.** When an insert's visible gap (between its alive
left and right origins) contains other nodes, there are exactly two
possibilities, and they need *opposite* treatment:

- **Never-seen (concurrent).** Figure 7: X:(A,C) generated without
  knowledge of B, concurrent with Y:(A,B). These must remain siblings
  ordered by reverse right-origin (Matthew's rule): A X Y B C. Correct
  as-is, must not change.
- **Known-dead (tombstones the generator skipped).** Delete b, then type
  c: c's gap (a, END) contains b†, and c's generator *knew* it. A
  concurrent y:(a,b) — anchored to b while b was alive — must precede c
  deterministically: **ayc**, never an ID tie.

Any design that makes the known-dead op encode the same as the
never-seen op cannot be correct, because the receiver then has no way to
distinguish them — and they require different orderings. This is why
*every* alive-skipping variant fails (the original 3-part fix, skipping
tombstones leftward when computing LO/RO, the alive-filtered
`rightChildren` branch): each one erases deletion-awareness from the op
in the name of tombstone-transparency, then has to re-derive it at
delete time from local state, which is exactly where the convergence and
intent bugs came from.

## 2. The mechanism

Two generation-time changes; zero delivery-time machinery.

### 2a. Right-edge anchoring

When inserting between visible neighbors aliveLO and aliveRO, walk
rightward from aliveLO across every tombstone in the gap. Anchor at the
**last node before aliveRO in the full traversal** — i.e. the left
origin *absorbs the known-dead chain*:

- if the anchor has no right children → new node is a **right child of
  the anchor** (possibly a tombstone), with rightOrigin = aliveRO;
- otherwise aliveRO is the leftmost descendant of the anchor's first
  right child → new node is a **left child of aliveRO**.

Compare: the paper anchors at the *left* edge of the dead gap (left
child of the first tombstone), which makes post-deletion content tie
with pre-deletion content by sender ID. Anchoring at the right edge
nests post-deletion content **after** every tombstone it knew about —
and therefore after everything that was anchored *to* those tombstones
while they were alive:

```
y:(a,b) — typed while b alive → y < b†      (its RO pins it before b)
c — typed knowing b dead      → b† < c      (it nests after the chain)
⇒  a y b† c   =   "ayc", structurally, no tie-break.
```

Pre-era < post-era falls out of the tree shape. Never-seen concurrent
inserts are untouched: their generators had no tombstones in the gap, so
they anchor exactly as FugueMax always did and merge via reverse-RO/ID.
The op format itself is the sufficient statistic — no vector clocks, no
extra metadata, the parent/side pair already says what the generator
knew.

### 2b. The era bit

One case still collapses two eras into the same op shape. If the anchor
(last tombstone) already has right children, the new node becomes a left
child of aliveRO — *identical* to an insert made at that spot while the
tombstone was alive. Symmetrically on the right side: a right child of a
node u generated while u was alive collides with a right child of u
generated after u died, when their rightOrigins are equal.

Example (`a t u m` chain): z typed between u and m while u was alive,
and x typed into the gap (a,m) after t,u died, both become left children
of m. z belongs to u's era and must precede x — but the ops look the
same.

So every insert records one bit at generation: **afterTombstone** — was
the anchor a tombstone? Sibling ordering becomes:

- right children: reverse rightOrigin, then era (pre before post), then
  sender;
- left children: era (pre before post), then sender.

The bit is baked into the op (it cannot be derived at the receiver:
`parent.isDeleted` at delivery time reflects concurrent deletes the
generator never saw). The RO comparison still dominates for right
children; a case analysis shows era never conflicts with reverse-RO —
the walk consumes every dead next-neighbor, so a post-era sibling's RO
can never be positioned beyond a pre-era sibling's RO at the same
parent.

Sender ties remain only where the gap is genuine: two inserts into the
same slot with the same knowledge (your Order 1: c:(a,b) vs concurrent
y:(a,b)). No information exists to order those; any deterministic
tie-break is acceptable.

## 3. Why convergence is free

An insert op carries (id, value, parent, side, rightOrigin?,
afterTombstone?) — all fixed at generation. Delivery inserts the node
into its sibling array using a comparator over (rightOrigin position,
era bit, sender), all immutable: tree positions never change after
placement, deletes move nothing. A stable strict total order inserted in
any arrival order yields the same array. Causal delivery guarantees the
parent and rightOrigin already exist. There is no delete-time code path
that could diverge, because there is no delete-time code path.

## 4. What was removed

The entire 3-part fix: `newRightOrigin` on delete messages,
`replacementRightOrigin`, `resolveRightOrigin` (chain-hopper),
`updateRightOriginsOnDelete`, `removeFromSiblings`,
`nextNonDescendantAlive`. The delete effector is now four lines. Net:
the fix is *less* code than the bug.

## 5. Scenario results (all merge orders, all sender assignments)

| Scenario | Result |
|---|---|
| Point 1: y keeps "…" as RO; post-deletion insert n | `a y b† … n` — "ay…n", deterministic |
| Point 2 Order 2 (delete b, insert c) vs concurrent y:(a,b) | **ayc** always |
| Point 2 Order 1 (insert c, delete b) vs concurrent y | sender tie (same knowledge), convergent |
| Right-side era: z after alive-u vs x after delete(u) | **azx** always |
| Left-child era (`a t u m`, the collision case) | **ayzxm** always |
| Original phantom barrier, runs on both eras | **AUVXYZ**, runs contiguous |
| Stacked eras (delete, type, delete, type) | nest in order: `a b† p† q` |
| Figure 7 (no tombstones) | **AXYBC** — unchanged |

One prior test expectation changed: `runDeletionConvergence` asserted
that inserting Y with vs without having seen B's deletion gives
identical results. Those are different operations — the second one knows
more — and forcing them to encode identically is precisely incompatible
with deterministic ayc. The test now asserts what is actually required:
each op set converges and Y lands within its origins in both cases.

## 6. Point 3 (bdac)

Untouched and still present (`bdeac`). It involves no deletions: d nests
in b's subtree, and the concurrent sibling a cannot enter between b's
subtree and c without reordering same-parent siblings by more than
origin information allows. It needs a different idea than origin
anchoring, and is out of scope for this fix.
