# Solving Phantom Barriers: Receiver-Side Era Derivation

This documents the complete solution to the tombstone / phantom-barrier
problems, verified 2026-08-16 against the full scenario suite
(`fugue-interleave/test_solution.js`, 20 scenarios, all delivery
permutations, both sender assignments).

## The problem, precisely

Tombstones must be invisible to the *user* but must not act as ordering
barriers. Two requirements:

**P1 — Stability.** The total order over all nodes (alive and dead) is
determined by insert operations alone. A delete only toggles visibility.
Nothing ever moves, no origin is ever rewritten, nothing is recomputed when
a delete arrives. (The old delete-time RO-shifting fix violated this and was
removed.)

**P2 — Era separation.** Content written *knowing* a deletion must
deterministically follow content anchored to the deleted element while it
was alive — for every sender assignment and every merge order, in every
geometry (same-origin ties, runs, chains, stacked eras, and mixed-era
siblings with different right origins). A tombstone must not turn "typed
after the deletion" into an ID tie with "typed before the deletion".

**P3 — Payload synchrony.** The insert op's bytes (parent, side,
rightOrigin) must not depend on which deletes the generator had synced.
This is the property canonical FugueMax has that a generation-time era
encoding destroys: with tombstone-inclusive origins, the op references the
same node whether it is alive or deleted. Era information therefore must
not be baked into the op.

## The design

**Generation: canonical FugueMax, unchanged.** The insert generator computes
leftOrigin and the tombstone-inclusive rightOrigin exactly as in the paper's
Algorithm 1. Payloads are byte-identical whether or not the deleting
messages have arrived (verified by the PAYLOAD SYNCHRONY test: four ops from
different sync states and operation orderings have identical payloads).

**Delivery: derive the era placement from the op graph.** When an insert op
arrives, reconstruct the generator's view from causal metadata:

1. Walk right from the op's canonical (tombstone-inclusive) next node.
   For each node `t` on the walk:
   - if `t` is deleted and some delete of `t` is in the op's causal past
     (`VC_op(deleter) ≥ delete's transaction counter`) — the generator knew
     it deleted — **cross it** (it becomes the anchor);
   - else if `t`'s insert dot is in the op's causal past — the generator's
     alive next — **stop**;
   - else `t` is a concurrent node the generator never saw — **skip it**.
2. No crossing → keep the canonical placement.
   Otherwise anchor after the whole known-dead chain:
   - if the stop node is a descendant of the anchor (the anchor had right
     children in the generator's view) → the new node becomes a **left
     child of the stop node** (the generator's next);
   - else → a **right child of the anchor**, with the stop node as its
     rightOrigin (null at the end).

Causal-past filtering is what makes this delivery-order independent: a
node's anchor depends only on ops causally before it, so concurrent ops
arriving later never move it. Placement is a pure function of the op set —
convergence by construction. The stop node's ancestry is fixed by the op's
causal past, so the left-child branch is also delivery-order independent.

**Sibling ordering: era first, then reverse right origin, then ID.**
A one-bit era ("crossed a known tombstone") distinguishes pre-deletion from
post-deletion siblings; pre comes first. Era must dominate reverse-RO: a
post-era sibling's rightOrigin can lie beyond a pre-era sibling's
rightOrigin (the UWZX scenario — a concurrent insert inside the dead gap),
and the era principle must win. Same-era siblings keep the paper's
reverse-RO/ID rules, so no-deletion behavior is byte-identical to FugueMax
(Figure 7).

## Causal metadata plumbing

- Each insert records its transaction counter (`meta.senderCounter`) as its
  causal dot; each delete records its (sender, transaction counter) on the
  node. Both are accessed during the local echo, which makes the collabs
  runtime transmit them to remote replicas.
- The insert generator requests vector-clock entries for the deleters of
  the tombstones its local walk crosses, plus the inserter of its alive
  next. Unrequested entries read 0, which automatically makes concurrent
  nodes "skip" during the receiver's walk — no bookkeeping of what is
  concurrent is needed.
- The derived placement (parent/side/rightOrigin/era) is saved, since
  saved state carries no per-op vector clocks; after load, later ops' walks
  use the saved causal dots.

## Scenario results (all merge orders, all sender assignments)

| Scenario | Result |
|---|---|
| Point 1: y keeps "…" as RO; post-deletion insert n | `a y m b† w† d† n` — "aymwn", deterministic |
| Point 1 minus m (forward-NI vs era trade) | **aywn** — era wins, explicitly |
| AYC (Order 2: delete b, insert c) vs concurrent y | **ayc** always |
| AYC Order 1 (insert c, delete b) vs concurrent y | sender tie (same knowledge), convergent |
| Right-side era: z after alive-u vs x after delete(u) | **azx** always |
| Left-child era (`a t u m`, the collision case) | **ayzxm** always |
| Phantom barrier, runs on both eras | **AUVXYZ**, runs contiguous |
| Stacked eras (delete, type, delete, type) | nest in order: `a b† p† q` — "ayq" |
| UWZX (mixed-era siblings, different ROs) | **zxwe** — era-first, sync-robust (S7) |
| Figure 7 (no tombstones) | **AXYBC** — unchanged |
| Payload synchrony | identical op bytes across sync states & orderings |

## What this gives up (stated, not hidden)

- **Definition 4 of the paper is revised, not implemented.** Era ordering
  deliberately overrides condition (3)'s ID tie-break (AYC), condition (2)
  (azx, ayzxm — the paper forces post-deletion-before-pre-deletion there),
  and condition (1) in the POINT1-minus-m geometry (aywn). Theorem 10's
  uniqueness therefore does not transfer; maximal non-interleaving holds
  under the revised (era-aware) definition. The paper's own §5.1 concedes
  the tombstone-inclusive right origin was chosen because it "simplifies
  the analysis by letting us ignore deletions" — not because the resulting
  delete-adjacent orderings are desirable.
- **Sync-state behavior splits by causal knowledge, not by bytes.** An op's
  placement depends on its causal past (whether the generator knew the
  deletion), which is part of the op graph in the op-based CRDT formalism.
  The bytes, however, are sync-independent (P3), so variant classes are a
  function of the op graph alone.

Point 3 (bdac) is untouched and out of scope: it involves no deletions, and
the ID-mandated order of same-origin siblings is correct behavior — a CRDT
cannot know which ops a peer had seen.
