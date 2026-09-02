# FugueMax tombstone semantic test matrix

For the generated single-page review, open
[`generated/tombstone-tests/index.html`](./generated/tombstone-tests/index.html).
It visualizes all 13 reviewed semantic candidates on one page. Twelve are
retained as gating requirements; N6 remains executable and visible but is
explicitly excluded, with the reason shown beside its graph. The same page also
contains 16 separately reconstructed historical traces and an inspect link for
every one of the 134 source rows found across the repository, git history,
adjacent checkers, project documents, and Fugue research memory. Each link is
labeled as exact evidence, a proposed comparison that still needs review, or a
metadata-only unverified gap. In particular, `represented` is no longer a claim
that two cases have been proved equivalent. Regenerate the page with
`npm run diagrams:tombstones`.

This is only a complete **ledger of the corpus we recovered**, not proof that
the reductions are correct and not coverage of every possible execution trace.
Six scratch artifacts remain unrecovered: the exact-boundary double-delete
variant, an interleaved dead-chain trace, deterministic save/load session
coverage, its 300-run randomized form, 1,200 local-echo comparisons, and the old
full strong-list randomized oracle. They are visibly marked missing and cannot
be pruned until their operations are reconstructed.

This document records what `test_tombstone_invariance.js` tests and how it
relates to the older test corpus.  It deliberately separates three properties
that the older files often mix together:

1. **Convergence:** one fixed operation set has one result under every legal
   delivery order.
2. **Ghost-history neutrality:** adding an insert/delete pair that no compared
   visible edit observed alive must not create another visible ordering.
3. **Clumping and non-interleaving:** removing phantom barriers must not discard
   FugueMax's reverse-RO ordering, move text on delete, or split a forward run.

The published implementation already provides (1).  The primary regression
target is (2), subject to the controls in (3).

The LO/RO labels below describe the generator's logical visible neighbours and,
where stated, the canonical FugueMax payload shape.  A left-child payload stores
its parent/RO but not its LO explicitly.  The current Era implementation keeps
that canonical payload and may derive a different effective parent/RO during
delivery; visible outcomes, rather than internal field equality, are therefore
the normative assertions.

## The paired-history contract

For a history `H`, construct `H+G` by adding a character `g`, deleting it, and
delivering the pair without allowing any compared visible insertion to observe
`g` alive.  Replay the same visible insertion intents at the same visible
indices with the same replica IDs.  The requirement is:

```text
visible(final(H)) = visible(final(H+G))
```

This is stronger than applying one op-set in different orders.  The operation
sets intentionally differ by `insert(g), delete(g)`; that is the history that
must be semantically irrelevant.

The boundary matters.  A dead node is **not** irrelevant when surviving content
was positioned relative to it while it was alive.  In that case its slot still
contains meaningful clumping information.  Tests `S1`, `S2`, and `C3` enforce
this boundary.

## New minimal cases

### N1 — unseen ghost at the document start

```text
H:     R:(LO=root, RO=end)       S:(LO=root, RO=end)
H+G:   g:(root,end), delete(g)
       R inserted at index 0 after receiving g+delete
       S inserted concurrently into an empty document
```

In `H`, published FugueMax orders the root siblings by ID and gives `RS`.  In
`H+G`, `R` is encoded as a left child of `g†`; the `g†` subtree sorts after `S`,
giving `SR`.  This is the smallest recovered counterexample for “insert and
delete locally, then sync the already-dead pair”: only one invisible operation
pair and two visible characters are needed.

### N2 — minimal interior reverse-RO witness

```text
A, B, C are concurrent and ordered A < B < C; B is deleted.

X:  logical LO=A, RO=C
Y0: logical LO=A, RO=end     (never receives B)
Y1: logical LO=A, RO=B†      (receives B+delete before typing)
```

The visible insertion intent for `Y0` and `Y1` is identical.  Reverse-RO
ordering yields `AYXC` without the ghost and `AXYC` with it.  This is the
smallest interior form of the attached ABCD figure.

### N3 — original ABCD phantom barrier

```text
A, B, C, D concurrent; B† invisible
X:(LO=A, RO=C), Z:(LO=A, RO=D)
Y0:(LO=A, RO=end), Y1:(LO=A, RO=B†)

without B†: AYZXCD
with B†:    AZXYCD
```

The test asserts equality between the two histories, not merely convergence
inside either history.

### N4 — LO-side routing asymmetry

```text
A and C are concurrent root siblings.
B was inserted after A and then deleted, so B† is a right child of A.
X inserts in visible (A,C): encoded (parent/LO=A, side=R, RO=C).

Y without B†: logical (LO=A,RO=C), encoded as A's right child.
Y with B†:    same logical slot, encoded (parent/RO=B†, side=L).
```

This is why changing only “RO = next live element” is insufficient: the
left-child branch stores no explicit RO and never executes that rule.

### N5 — multiple consecutive ghosts

`B†,C†` lie between `A` and the live `D,E` suffix.  `X` and `Z` supply
different live ROs (`D` and `E`), so changing `Y` from `RO=D` to `RO=B†`
becomes observable: `AZYXDE` versus `AZXYDE`.  This prevents a one-hop fix
from accidentally passing the single-tombstone case.

### N6 — run-level phantom barrier (excluded duplicate)

N3 is repeated with a forward run `U -> V` in place of `Y`.  Both documents
must agree and contain adjacent `UV`.  Current and published FugueMax keep the
run internally contiguous but move the entire run from `AUVZXCD` to
`AZXUVCD`; run contiguity alone therefore does not prove ghost neutrality.

This candidate no longer gates the suite. Its ghost-sensitive placement is
exactly N3, while C2 independently guards continuation adjacency. It remains
visualized so that the redundancy is reviewable rather than silently pruned.

### N7 — why “next live RO at insertion” fails

```text
shared visible state: A Y B
M concurrently inserted in (Y,B): LO(M)=Y, RO(M)=B

history 1: insert C in (Y,B), then delete B
           LO(C)=Y, RO(C)=B
history 2: delete B, then insert C after Y
           LO(C)=Y, naive-live-RO(C)=end
```

Published FugueMax retains `RO(C)=B` in both histories and produces `AYMC`.
A plain next-live-RO patch produces `AYMC` versus `AYCM`: `C` changes from an
ID tie with `M` to a different reverse-RO class.  This case uses the
right-child branch, so unlike N4 it directly executes the proposed rule.

### S1/S2 — no movement after deletion

`S1` chooses sender IDs so that rewriting `Y.RO` from `B` to `C` reverses
`X,Y`.  It compares the order before deleting `B` with the order afterward,
after removing only `B`.  `S2` repeats this across `B -> C -> D -> end`.
These reject the old delete-message `replacementRightOrigin`/chain-hopper
implementation: deleting characters changed `AXYBC` to `AYXC`, and the chain
ended `APQR` instead of the deletion projection `ARQP`.

### C1 — preserve reverse-RO clumping

This is the paper's Figure 7:

```text
A < B < C concurrent
X:(LO=A,RO=C)
Y:(LO=A,RO=B)
required: AXYBC
```

It is the reason a correct fix cannot replace reverse-RO ordering with a flat
ID order or treat all invisible structure as interchangeable.

### C2 — preserve forward non-interleaving

```text
shared AB
author: insert P in (A,B), delete B, type Q after P
concurrent: Y in (A,B)
```

`LO(Q)=P`, so valid results keep `PQ` together: `APQY` or `AYPQ`.  The current
Era implementation produces `APYQ` for one sender assignment and fails this
test.

### C3 — do not erase a tombstone with live dependants

```text
shared AB
Z typed after live B: LO(Z)=B
another peer deletes B and types Y after A without seeing Z
required visible order: AYZ
```

Here `B†` is not a disposable ghost: `Z` preserves its right-side continuation.
Keeping `Y` in the `(A,B)` slot clumps it before `Z`.  Published FugueMax passes;
the current Era implementation gives `AZY`.

### C4 — preserve a same-boundary slot across deletion

`Y` was placed in `(A,B)` while `B` was alive; a concurrent author deletes `B`
and then inserts direct continuation `C` after `A`. Both operations are encoded
as `side=L, parent/RO=B`. Reverse-RO ordering therefore keeps them in one
B-boundary clump but cannot order them internally; published FugueMax falls
through to sender ID and gives `ACY` for one assignment.

C4 is retained as a distinct slot-continuity control: content already occupying
the deleted boundary's slot precedes a direct post-delete insertion into that
same structural clump, so both assignments must give `AYC`. This is narrower
than universal Era separation. It resolves only the otherwise arbitrary exact
boundary tie and does not override a causal continuation such as C2's `P -> Q`.

## Results against the known variants

`P` means the implementation satisfies the assertion; `F` means the test
exposes it.  The plain-live and old-shifting builds were reconstructed from
upstream and commit `720a020`, respectively.

| Case | Decision | Published FugueMax | Plain next-live RO | Old RO shifting | Current Era |
|---|---|:---:|:---:|:---:|:---:|
| N1 remote dead pair | retained | F | F | F | F |
| N2 minimal RO barrier | retained | F | P | P | F |
| N3 original ABCD | retained reference | F | P | P | F |
| N4 LO routing | retained | F | F | F | F |
| N5 dead chain | retained | F | P | P | F |
| N6 run-level barrier | excluded duplicate | F | P | P | F |
| N7 insert/delete commute | retained fix regression | P | F | P | P |
| S1 one-delete stability | retained control | P | P | F | P |
| S2 chain-delete stability | retained control | P | P | F | P |
| C1 reverse-RO clumping | retained control | P | P | P | P |
| C2 forward continuation | retained control | P | P | P | F |
| C3 live continuation of tombstone | retained control | P | P | P | F |
| C4 same-boundary slot continuity | retained control | F | F | F | P |

Across the 12 retained requirements, published FugueMax passes 6, plain
next-live passes 8, old RO shifting passes 7, and current Era passes 5. No
known implementation passes the retained matrix. N6 is the only semantic
candidate excluded from the gate. Historical source cases that are outside the
target, disputed, provisional, or missing remain separately inspectable and
are not silently removed.

## Audit of the existing corpus

### `index.js`

- `runFigure7` is the source of C1 and remains an essential positive control.
- `runABCD_Deletion` and `runABCD_Deletion_SyncFirst` are the two halves of N3.
  Their comparison was the useful assertion in commit `720a020`; it was later
  weakened to “Y lies somewhere between A and C.”
- `PhantomBarrier_Basic`, `ChainDelete`, `MultiPeerDelete`, and
  `ResortingConvergence` mostly compare delivery orders of one combined op-set.
  They test convergence of the old RO-shifting machinery, not ghost neutrality.
  They now have their own I8–I11 source graphs because that implementation
  topology is not literally duplicated by N5 or S1/S2.
- `MaximalNonInterleaving` checks two delete-free runs only. C1/C2 cover the
  relevant clumping boundaries; excluded N6 shows why the larger composition
  adds no independent requirement.
- `ConcurrentDE_BetweenBC` is the separate delete-free `bdac` question. It is
  not evidence for or against tombstone neutrality, but its exact I7 source
  graph remains available for independent review.

### `test_fig2.js`

The comments state the right question, but the file prints results without an
assertion and ultimately checks replicas that receive the same complete
operation set.  It does not compare the no-ghost history to the dead-pair
history.  N1, N2, and N4 are assertion-based replacements.

### `test_lo.js` and `test_lo2.js`

These are print-only exploratory scripts.  Their useful cases map to:

- insert-before-delete versus delete-before-insert: N7;
- LO-side phantom route: N4;
- AYC: retained C4, but only as the narrow same-B-boundary tie rather than a
  general pre-era/post-era ordering rule;
- longer-run structural divergence: excluded N6 plus the retained C2 guard.

Their `bdac` experiments remain out of scope for this tombstone suite.

### `test_solution.js`

This is a conformance suite for the later Era specification, not for the
original neutrality requirement.  The following parts remain useful controls:

- Figure 7 -> C1;
- forward/backward run checks -> C2; N6 is the visible redundant composition;
- AYC -> retained C4's exact-boundary control;
- explicit position pins -> the general rule that an observed live dependency
  is not a disposable ghost, represented minimally by C3.

The following expected strings are not imported as requirements because they
define the disputed Era semantics: POINT 1 whole-chain ordering, right/left Era,
stacked eras, UWZX era-first ordering, POINT1-minus-m, T1=`APYQ`, and the
corollary/T8/T9 theory cases.  In particular, POINT1-minus-m and T1 explicitly
permit forward/backward non-interleaving violations, which C2 now rejects.

Payload synchrony, same-transaction batches, save/load, and fresh-merge/local-
echo checks are valuable implementation tests, but payload equality and
convergence do not imply visible ghost-history neutrality.

### `model_check.js`

This untracked exploratory checker is the only existing file that states
`ghost-neutrality` and `prune-neutrality` directly.  Its random counterexamples
are hard to reason about as specifications.  N1 is a reduction of one such
failure to four operations (`insert g`, `delete g`, `insert R`, `insert S`).
The randomized checker remains useful after the minimal suite defines what a
failure means.

### Published upstream corpus

Upstream commit `31e74fe` contains no FugueMax semantic test suite; it contains
the implementation and benchmarks only.  Therefore these cases are new
regressions rather than duplicates of published tests.
