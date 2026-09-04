# FugueMax tombstone semantic tests

The executable suite is [`test_tombstone_invariance.js`](./test_tombstone_invariance.js).
Its twelve cases are visualized in
[`generated/tombstone-tests/index.html`](./generated/tombstone-tests/index.html).
The independent arbitrary-trace fuzzer, its metamorphic rewrites, deterministic
replay commands, and conservative structural predicates are documented in
[`TOMBSTONE_FUZZING.md`](./TOMBSTONE_FUZZING.md).
Regenerate the page with:

```sh
npm run diagrams:tombstones
```

The complete 134-row corpus audit, historical source graphs, disputed Era
examples, randomized checker, and excluded N6 composition remain available in
git history at commit `1a4f60b`. They add provenance or stress coverage, but no
distinct semantic requirement beyond the cases below.

## Target contract

The original defect is hidden-history variance, not ordinary convergence. For
a history `H`, construct `H+G` by adding an insert/delete pair `G` that no
compared surviving operation structurally references. `G` may have been
published and temporarily visible, provided the observer made no operation from
that live state before receiving its deletion. Recreate the same visible
insertion intents with the same replica IDs. The required property is:

```text
visible(final(H)) = visible(final(H+G))
```

This is subject to seven preservation rules:

1. Reverse-right-origin clumping must still hold.
2. A forward continuation `LO(q)=p` must not be split.
3. Deletion alone must not reorder surviving content.
4. A tombstone referenced by surviving content is meaningful history and
   cannot be erased as though it were an unobserved ghost. This must remain
   true when the reference is in flight and the delete was already published.
5. Transport handoff alone must not change insertion semantics.
6. A local insert-delete pair must not change the structural bucket of the
   author's next insertion when no survivor depends on the pair.
7. Ordinary insertion after deletion and replacement of deleted content are
   distinct intents. Replacement must be declared and retain the pre-delete
   slot; ordinary insertion must use the current supported visible gap.

The suite separates these semantic comparisons from delivery-order
convergence. Published FugueMax already converges for one fixed operation set;
that does not prevent an invisible insert/delete pair from creating an extra
visible ordering variant.

## Ghost-history counterexamples

### N1 — invisible pair at document start

```text
H:    R:(LO=root, RO=end)  S:(LO=root, RO=end)  -> RS
H+G:  g:(root,end), delete(g)
      R generated after receiving g+delete; S generated without g -> SR
```

This is the smallest remote-ghost witness. In `H+G`, `R` becomes a left child
of `g†`; the invisible subtree changes the order of the surviving `R,S` pair.

### N2 — minimal interior reverse-RO barrier

```text
X:  LO=A, RO=C
Y0: LO=A, RO=end   (B never existed)
Y1: LO=A, RO=B†    (B arrived already deleted)

without B†: AYXC
with B†:    AXYC
```

This isolates the reverse-RO mechanism with the smallest useful interior
context. The same visible insertion of `Y` joins a different clump solely
because hidden `B†` exists.

### N3 — original ABCD figure

```text
A,B,C,D concurrent; B is invisible
X:(LO=A, RO=C)
Z:(LO=A, RO=D)
Y0:(LO=A, RO=end)
Y1:(LO=A, RO=B†)

without B†: AYZXCD
with B†:    AZXYCD
```

N3 is larger than N2 but remains because it exactly reproduces the motivating
diagram and prevents the minimal reduction from drifting away from the original
reported defect.

### N4 — left-child/right-child routing asymmetry

```text
visible slot: (A,C)

without B†: Y is encoded as a right child of A, logical LO=A, RO=C
with B†:    Y is encoded as a left child of B†, logical LO=A, RO=B†
```

This is distinct from N2/N3: changing only an insert's explicit right origin
cannot repair the left-child branch because that payload stores its parent/RO
and does not execute a right-child-only “next live RO” rule.

### N5 — consecutive invisible tombstones

```text
hidden chain: B† -> C† between A and live D,E
X:(LO=A, RO=D)
Z:(LO=A, RO=E)
Y without chain:(LO=A, RO=D)
Y with chain:   (LO=A, RO=B†)

without chain: AZYXDE
with chain:    AZXYDE
```

N5 prevents a single-hop repair from passing the one-tombstone examples while
still failing when several invisible boundaries must be neutralized.

## Regressions for proposed simple fixes

### N7 — declared replacement preserves the live slot

```text
shared visible state: A Y B
M inserted in (Y,B): LO(M)=Y, RO(M)=B

reference lowering: insert C in (Y,B), then delete B
                    LO(C)=Y, RO(C)=B
declared lowering:  splice(index(B), 1, C)
                    captures the same live (Y,B) slot
```

For each fixed sender assignment, both lowerings must agree. With `M<C` the
result is `AYMC`; with `C<M` it is `AYCM`. This preserves exact-RO clumping
without making ordinary post-delete insertion depend on B†.

The generalized checker varies the arbitrary settled prefix, selected target
range, replacement run, one to three concurrent witnesses, and both relative ID
directions. It compares the declared API with the canonical insert-before-delete
lowering—not arbitrary raw command orders. A transport handoff is separately
tested as an irrelevant stutter step.

### S1 — deletion cannot re-sort surviving siblings

Before deletion, `X:(A,C)` and `Y:(A,B)` produce `AXYBC`. Deleting `B` must
project that order to `AXYC`. Rewriting `Y.RO` from `B` to `C` and re-sorting
instead produces `AYXC`.

### S2 — chained deletion cannot move anchors repeatedly

`P,Q,R` use right origins `B,C,D`. Deleting `B`, then `C`, then `D` must only
remove those characters; it must not rewrite `P` through `B→C→D→end`. This
guards the separate failure mode of the old replacement-origin chain hopper.

## Structural controls

### C1 — preserve FugueMax reverse-RO clumping

```text
A < B < C concurrent
X:(LO=A, RO=C)
Y:(LO=A, RO=B)
required: AXYBC
```

This is the paper's Figure 7 and the reason a fix cannot flatten all siblings
to sender-ID order.

### C2 — preserve forward non-interleaving

```text
shared AB
author: P in (A,B), delete B, then Q with LO(Q)=P
concurrent: Y in (A,B)
```

Valid results keep `PQ` adjacent: `APQY` or `AYPQ`. `APYQ` is forbidden. This
rejects global Era separation.

### C3 — preserve a referenced tombstone

```text
shared AB
Z typed after live B: LO(Z)=B
another peer deletes B without seeing Z and types ordinary Y after A
deliver Z before or after that edit; insert irrelevant transport handoffs
run Y IDs on both sides of B's ID
required: Z survives; delete/insert steps do not reorder established survivors
```

`B†` is meaningful because surviving `Z` depends on it. Treating every deleted
node as physically disposable would lose Z or break convergence. B† therefore
remains in the replicated support closure.

Either `AYZ` or `AZY` can be valid under different immutable ID/tree
relationships. Y's author does not know in-flight Z and cannot use Z as an
origin. C3 requires survival, convergence, and stepwise stability; it does not
invent a universal Y-before-Z rule. Transport handoff is not part of the
semantic premise.

### D1 — ordinary insertion is not inferred replacement

```text
shared AB
X sees only A: X:(LO=A, RO=END)
D deletes B, then ordinarily inserts R after A
M saw live B: M:(LO=A, RO=B), still in flight
IDs M < R < X
```

D cannot know whether M exists. Ordinary R uses the current supported gap
`(A,END)` and gives `ARX`, then `ARXM` when M arrives. Declared replacement R
uses B's captured live slot `(A,B)` and gives `AXR`, then `AXMR`.

The same raw local state cannot determine both immutable coordinates. This case
rules out the old local-outbox/publication heuristic and explains why `splice`
is an explicit edit-level operation. Its generalized sensor varies the settled
prefix and gap, both ID directions, and whether late `RO=B` content arrives
before or after the ordinary/replacement operation.

## Current results

| Case | Published FugueMax | Support projection + splice |
|---|:---:|:---:|
| N1 document-start ghost | fail | pass |
| N2 interior RO barrier | fail | pass |
| N3 original ABCD figure | fail | pass |
| N4 left/right route | fail | pass |
| N5 dead chain | fail | pass |
| N7 declared splice lowering | unsupported | pass |
| S1 deletion stability | pass | pass |
| S2 chain deletion stability | pass | pass |
| C1 reverse-RO clumping | pass | pass |
| C2 forward continuation | pass | pass |
| C3 referenced tombstone, parent and RO safety | pass | pass |
| D1 ordinary insertion versus explicit replacement | fail | pass |

Published FugueMax passes 5/12 under the active contract; support-projected
FugueMax with explicit splice passes 12/12. The generalized staged-ghost,
splice-lowering, reverse-RO, and referenced-tombstone sensors exercise lifecycle
and structural boundaries beyond the hand-written cases.

This is strong evidence for the candidate, not an exhaustive correctness proof.
Bounded causal enumeration, deeper support chains, restart cuts, concurrent
range splices, mutation testing, and formal proof remain open.

## Why the rest was removed

The archived cases fell into one of these categories:

- convergence-only replays of one operation set;
- sender-ID mirrors or longer-run extensions of an existing case;
- disputed universal Era-separation expectations;
- the former C4 sender-ID swap, because changing author identities is not a
  semantics-preserving transformation; its valid fixed-ID commuting relation
  is now covered by N7's fixed-ID splice relation;
- delete-free performance and benchmark workloads;
- implementation plumbing for abandoned receiver-walk/RO-shifting designs;
- randomized property families better evaluated after the semantic oracle is
  agreed; or
- unrecovered scratch descriptions without enough operations to execute.

They remain useful research provenance in `1a4f60b`, but keeping them in the
active review obscured the twelve independent obligations above.
