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
  *Qualifier (pins dominate):* era ordering applies only between content
  with no explicit position relation — an author who deliberately pins
  their content (types before a specific element) keeps that pin (T8/T9).
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
  - **T1′ — era is the sync-robust side of the family.** Same keystrokes,
    but the author received y *before* the backspace (screen "apyb" →
    "apy" → "apyq"): era gives `apyq` again — the fixed point equal to the
    informed author's own screen. Canonical gives `apyq` here too, but
    `apqy` in T1 — so canonical's final document flips on whether y
    happened to arrive before the backspace; era's does not. On this
    family, era removes a delivery-timing dependence that canonical has.
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

## The impossibility proposition — why the price is forced

**Proposition.** No algorithm satisfying the strong list specification
guarantees both (A) *continuation adjacency* — an op whose visible left
origin is ℓ and which is the only element with vLO = ℓ is consecutive with
ℓ — and (B) *era separation* — pre-era slot content precedes post-era
continuations — for all sender assignments.

*Proof.* Ops a, b, p (peer 1 into (a,b)), y (peer 9 into (a,b)). Scenario
A: peer 1 deletes b and types q (vLO = p). Scenario B: peer 9 deletes b
and types q′ (vLO = y). The op subset {a,b,p,y} is literally identical in
both scenarios, and a replica holding exactly it occurs in both;
convergence forces one fixed display order for p,y there, and the strong
list spec's single global order forbids the relative order of two visible
elements from ever changing afterward. In A, (B)+(A)+spec (p ≺ q, y ≺ q,
p adjacent q) force y ≺ p. In B, symmetrically, p ≺ y. Contradiction. ∎

Consequences: canonical ("apqy") and era ("apyq") are the only two
coherent designs on this family — there is no third. Escape routes are
closed: tie-breaking with future knowledge is not measurable at
placement, and revising the p/y order when q arrives violates the strong
list spec itself (not merely P1) — even a fully re-keyed
pure-function-of-op-set design would flip the visible order of committed
characters and exit the Attiya specification. T1 is therefore the boundary
every algorithm must sit on one side of; era's side is ghost-relative
intent-correct in every element and is the sync-invariant fixed point
(T1′), where canonical's side is delivery-timing-dependent.

## Definition 4′ — era-aware maximal non-interleaving (formal specification)

**Era origins** (pure functions of an op's causal past; the delivery walk
computes exactly these, established by the eragen/erarecv differential
fuzz). For insert o with author view V(o): vLO(o) = visible predecessor;
cRO(o) = successor of vLO(o) in V(o)'s tombstone-inclusive order. The
known-dead chain K(o) = the maximal run t₁ = cRO(o), t₂, … of consecutive
elements of V(o)'s full order such that some delete of each tᵢ is in
past(o). Then **eraLO(o)** = t_k if k ≥ 1 else vLO(o); **eraRO(o)** = the
successor of eraLO(o) in V(o)'s full order (first element not
known-deleted; *end* if none); era bit e(o) = [k ≥ 1].

Facts: (F1) at insertion, eraLO(o) and o are consecutive in V(o)'s full
order, and o ≺ eraRO(o); (F2) *causal monotonicity*: any op with o in its
past also knows every delete in K(o) — era layering never runs backwards;
(F3) same-(eraLO, eraRO) ops are pairwise concurrent, which makes the pin
qualifier a theorem: pinned pairs never share a class, and explicitly
pinned ops get e = 0 or route into the pinned node's subtree.

**The definition.** Strong list specification, plus, in the
tombstone-inclusive order ≺:

- **(1′) Forward non-interleaving over era origins.** If A = eraLO(B) and
  B appears ≺-earlier than any other element with eraLO = A, then A and B
  are consecutive. *Ghost-slot corollary* (T1 and POINT1-minus-m as one
  clause): for a post-era op B, every element strictly between vLO(B) and
  B is either a ghost in K(B), or an element X with eraRO(X) ∈ K(B)
  (content anchored into the crossed slots), or a descendant of such; if
  the crossed slots contain no pre-era content, vLO(B) and B are
  consecutive among visible elements.
- **(2′) Backward non-interleaving with rebuilt exceptions.** If B =
  eraRO(A) and A is the ≺-latest element with eraRO = B, then A,B are
  consecutive, unless (i) the paper's Lemma-5 exception transplanted to
  era origins, or (ii) *era intrusion*: a post-era element with the same
  eraLO as A but larger stop separates them (UWZX's x between z and w).
  Proving (i)–(ii) exhaustive is the Lemma-5-analog obligation.
- **(3′) Sibling axiom.** Among elements with the same eraLO that are
  unordered by (1′)/(2′): pre-era (e = 0) precede post-era (e = 1); within
  the same era bit, roots of the eraRO forest in reverse-eraRO order;
  remaining ties by full ID. Era separation is an axiom, exactly as the
  paper's condition (3) was — it is not derivable from (1′)+(2′).

**Constructive characterization** (what the implementation computes): (1)
pre-order of the eraLO-tree; (2) same-eraLO elements by post-order of the
eraRO forest (X child of Y iff eraRO(X) = Y within the group) — realized
by the descendant branch, which routes pinned post-era ops into the stop
node's left-descendant chain so the flat comparator only ever compares
pin-free pairs; (3) forest roots: era bit, then reverse-eraRO, then full
ID.

**Proof roadmap.** Transfers essentially verbatim: the strong-list-spec
theorem (the walk stops before the first known-alive node, so placement
stays inside the visible gap); convergence (causal-past purity); Lemma 3
with eraLO; the roots-pairwise-concurrent lemma. Needs genuine re-proof:
Lemma 7's forward direction (its step "D is not causally later than A" is
false for eraLO-siblings — T8's x1 is causally later than its sibling m;
replacement: causally-related same-eraLO elements are always
eraRO-forest-pinned, so post-order handles them and only roots need the
concurrency argument); Lemma 8(a) in eraLO form (walk up to the first
right-child link; its parent is the anchor — true by construction,
including through left-descendant chains); Lemma 8(b) correspondence;
Theorem 9 (existence) assembled from these; Theorem 10 (uniqueness) via
the paper's scheme given (3′) as the explicit new axiom.

## Why the earlier alternatives failed (recorded for the correspondence)

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
