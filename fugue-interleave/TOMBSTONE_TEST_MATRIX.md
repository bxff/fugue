# FugueMax tombstone semantic tests

The executable suite is [`test_tombstone_invariance.js`](./test_tombstone_invariance.js).
Its twelve cases are visualized in
[`generated/tombstone-tests/index.html`](./generated/tombstone-tests/index.html).
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
compared surviving edit observed alive. Recreate the same visible insertion
intents with the same replica IDs. The required property is:

```text
visible(final(H)) = visible(final(H+G))
```

This is subject to four preservation rules:

1. Reverse-right-origin clumping must still hold.
2. A forward continuation `LO(q)=p` must not be split.
3. Deletion alone must not reorder surviving content.
4. A tombstone referenced by surviving content is meaningful history and
   cannot be erased as though it were an unobserved ghost.

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

### N7 — next-live RO changes insert/delete order semantics

```text
shared visible state: A Y B
M inserted in (Y,B): LO(M)=Y, RO(M)=B

history 1: insert C in (Y,B), then delete B
           LO(C)=Y, RO(C)=B
history 2: delete B, then insert C after Y
           canonical RO(C)=B†; naive next-live RO(C)=end
```

Published FugueMax gives `AYMC` in both histories. The plain next-live repair
gives `AYMC` versus `AYCM`, because `C` changes from an ID tie with `M` to a
different reverse-RO class.

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
rejects global Era separation while allowing a narrow exact-boundary rule.

### C3 — preserve a referenced tombstone

```text
shared AB
Z typed after live B: LO(Z)=B
another peer deletes B and types Y in (A,B)
required: AYZ
```

`B†` is meaningful because surviving `Z` depends on it. Treating every deleted
node as irrelevant destroys the clumping boundary and gives `AZY`.

### C4 — exact-boundary tie is not a sender-ID lottery

```text
Y typed in (A,B) while B is live
concurrent author deletes B and inserts C after A

Y and C both encode as side=L, parent/RO=B
required for both sender assignments: AYC
```

C4 is intentionally narrow. It orders content already occupying the exact
`(LO=A,RO=B)` slot before a direct post-delete insertion in that same structural
class. It does not impose universal pre-era/post-era ordering and therefore does
not justify splitting C2's `P→Q` continuation.

## Current results

| Case | Published FugueMax | Current Fugue-Era |
|---|:---:|:---:|
| N1 document-start ghost | fail | fail |
| N2 interior RO barrier | fail | fail |
| N3 original ABCD figure | fail | fail |
| N4 left/right route | fail | fail |
| N5 dead chain | fail | fail |
| N7 next-live regression | pass | pass |
| S1 deletion stability | pass | pass |
| S2 chain deletion stability | pass | pass |
| C1 reverse-RO clumping | pass | pass |
| C2 forward continuation | pass | fail |
| C3 referenced tombstone | pass | fail |
| C4 exact-boundary tie | fail | pass |

Published FugueMax passes 6/12; current Fugue-Era passes 5/12. No existing
implementation satisfies the distilled suite.

## Why the rest was removed

The archived cases fell into one of these categories:

- convergence-only replays of one operation set;
- sender-ID mirrors or longer-run extensions of an existing case;
- disputed universal Era-separation expectations;
- delete-free performance and benchmark workloads;
- implementation plumbing for abandoned receiver-walk/RO-shifting designs;
- randomized property families better evaluated after the semantic oracle is
  agreed; or
- unrecovered scratch descriptions without enough operations to execute.

They remain useful research provenance in `1a4f60b`, but keeping them in the
active review obscured the twelve independent obligations above.
