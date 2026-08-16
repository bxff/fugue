# Fugue-Era: the complete semantics of the tombstone-safe FugueMax

This is the complete specification of the design implemented in
`fugue-max-simple/src/index.ts`. It is intended to be self-contained: one
principle, one set of rules, one complete list of what the design gives and
what it deliberately overrides. All claims are pinned by
`fugue-interleave/test_solution.js` (23 scenarios, all delivery
permutations, both sender assignments).

## The one principle

**The document order is the order the authors believed they were writing
in.** Each insert lands after everything its author knew was deleted and
before everything its author believed alive. Where two authors had
identical knowledge, a deterministic tie-break decides. A delete only
toggles visibility — it never moves anything and never changes any insert's
op. This extends FugueMax's intent-preserving placement from the visible
list to the tombstone-inclusive list.

## The algorithm

**Generation — canonical FugueMax, unchanged.** The insert op carries
exactly the paper's payload: `(id, value, parent, side, rightOrigin)` with
tombstone-inclusive origins. Consequently the op bytes are independent of
which deletes the generator had synced (verified by the PAYLOAD SYNCHRONY
test: four ops generated from different sync states and operation
orderings are byte-identical). Deletes do not perturb the op graph of
inserts at all.

**Delivery — derive the author's view from the op graph.** Each insert
records its causal dot (transaction counter); each delete records its
(sender, transaction counter) on the node. When an insert arrives, walk
right from its canonical next node:

1. cross every tombstone whose *delete* is in the op's causal past (the
   author knew it deleted) — it becomes the era anchor;
2. stop at the first node whose *insert* is in the causal past and whose
   deletion is not (the author believed it alive) — the era-RO;
3. skip anything concurrent (the author never saw it).

Then: no tombstone crossed → keep the canonical placement. Otherwise anchor
after the whole known-dead chain — a right child of the anchor with the
era-RO as right origin, or a left child of the era-RO when the era-RO is a
descendant of the anchor (the anchor had right children in the author's
view). Every decision reads only the op's causal past, so the placement is
fixed the moment the op is placed — concurrent ops arriving later can
never move it. Convergence is by construction; the tree is a pure function
of the op set.

**Siblings — era class first, then reverse right origin, then
(sender, counter).** Pre-deletion content precedes post-deletion content.
Era must dominate reverse-RO: a post-era sibling's right origin can lie
beyond a pre-era sibling's (UWZX), and the era principle must win.
Same-era siblings keep the paper's reverse-RO/ID rules, so delete-free
behavior is byte-identical to FugueMax.

## The guarantees (pinned by the suite)

- **G1 — Intent preservation (strong list spec).** Every insert lands
  between its generation-time visible neighbors. An author's explicit
  position always wins over era layering (the pin test: typing *before*
  pre-era content stays before it).
- **G2 — Stability.** Deletes toggle visibility only. No origin is ever
  rewritten, nothing is restructured on delete, and the order is a pure
  function of the op graph.
- **G3 — Era separation.** For two inserts into the same region, the author
  who knew a deletion lands after the one who didn't — deterministically,
  in every geometry: same-origin ties (AYC), right-side continuations
  (azx), left-child collisions (ayzxm), whole-chain nesting (POINT 1),
  stacked eras (ayq), mixed-era siblings with different right origins
  (UWZX), layered knowledge stops, and concurrent double-deletes.
- **G4 — Un-edited runs stay contiguous.** Runs typed without an
  intervening edit are never split (forward, backward, and post-era runs;
  "a123789m", "AUVXYZ"). Delete-free scenarios are byte-identical to
  canonical FugueMax.
- **G5 — Determinism where knowledge differs.** Every ordering decided by
  knowledge is independent of sender IDs and merge order — including
  geometries where canonical is sender-dependent (layered stops,
  double-deletes).

## The overrides — the complete list of departures from the paper's Definition 4

These are deliberate, stated once, and cover all delete geometries:

- **O1 — Forward non-interleaving yields to era separation.** When
  pre-era content occupies a dead slot, it may sit between a post-era
  continuation and its visible left origin. Two faces of one condition:
  - POINT1-minus-m: `n` typed after deleting b,d → `aywn` (w, anchored in
    the chain while alive, sits between y and n).
  - **T1**: shared "ab"; author types p between a,b, backspaces b, types q;
    concurrent y typed between a,b. Result: `apyq` when p's ID sorts after
    y's, `aypq` otherwise. With b visible the intent order is `p y b q` —
    every element sits exactly where its author put it relative to b's
    tombstone; y correctly occupies the deleted slot. Canonical's `apqy`
    misplaces q before b's tombstone. The visual adjacency of p,q is
    ID-decided only because p vs y is a genuine same-knowledge tie; a
    deterministic y-before-p is impossible without future knowledge (q
    does not exist in p's causal past), so within G2 it is provably
    unavoidable. This is not interleaving — it is correct placement of
    slot content.
- **O2 — Backward non-interleaving takes an era exception.** Pre-era
  content may be separated from its right origin by post-era content of a
  different right origin (UWZX: x between z and w). This is the rebuilt
  Lemma 5 exception: it fires exactly when the intervening element is
  post-era of a deletion the separated element's author never saw.
- **O3 — Same-origin ties are era-ordered, not ID-ordered.** The paper's
  condition (3) is replaced by era class first; ID remains only within a
  class. This is the entire fix to the phantom barrier and the only change
  relative to the paper in tie-breaking.
- **O4 — Order 1 vs Order 2 diverge by causal knowledge.** Typing c while b
  is alive and then deleting b (Order 1) is a different op graph than
  deleting b and then typing c (Order 2): Order 1's c ties with concurrent
  y by ID (same knowledge); Order 2's c deterministically follows y. This
  split is inherent to any era-faithful design and is required by the AYC
  determinism itself.
- No delete-free behavior changes. bdac (Point 3) is untouched and
  correct as-is: same-origin concurrent inserts are ordered by ID because
  no information exists to order them otherwise.

## What remains (proof-level, not design-level)

The revised definition (Def 4′) formalizing G1–G5 and O1–O4, with the
uniqueness theorem that replaces the paper's Theorem 10: maximal
non-interleaving under the era-aware definition. The paper's Lemma 8(a)
does not transfer (walking up from a re-anchored node recovers its anchor,
not its §5.1 left origin) and needs an eraLO version; the rest of the
machinery (pre-order traversal of the eraLO-tree, reverse-eraRO forest,
Theorem 9/10 scheme) is expected to transfer with that replacement. This
is a proof task, not an implementation task — the algorithm above is the
complete design.

## Why the earlier alternatives failed (recorded for the correspondence)

- **Canonical FugueMax** cannot see the knowledge difference (tombstone-
  inclusive RO makes both eras byte-identical ops), so it ID-ties them:
  phantom barrier (`acy`, `aqy`, `AXYZUV`), and in right-side geometries
  Definition 4 actively forces post-before-pre (`axz`, `axyzm`).
- **"RO = next live element"** erases the chain position that encodes
  intent: it fixes none of the tie geometries (the left-child branch never
  consults RO) and makes the same keystroke produce different trees by
  operation order (`aymc` vs `aycm`).
- **Generation-time era anchoring** (the previous iteration of this fix)
  encodes the right rule but in the op, making payload bytes depend on
  delete-sync state (violating G4/payload synchrony), and its RO-first
  comparator lets reverse-RO override the era principle (UWZX `xzwe`) with
  a sync-dependent flip.
