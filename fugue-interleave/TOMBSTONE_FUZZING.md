# Generalized FugueMax tombstone property benchmark

[`fuzz_tombstone_properties.js`](./fuzz_tombstone_properties.js) has one input
generator: arbitrary legal multi-replica executions containing local inserts,
local deletes, and causally valid message deliveries. It does not generate
variations of the hand-written N/C/S diagrams.

This follows the architecture of
[collaborative-text-editing-algorithms PR #36](https://github.com/samiabobaker/collaborative-text-editing-algorithms/pull/36): generate arbitrary executions first, record every state and origin, and then run independent predicates or metamorphic transformations over the trace.

## Which filtered cases are published FugueMax bugs?

The filtered suite has two roles that must not be conflated:

| Cases | Published FugueMax | Role |
|---|:---:|---|
| N1–N5 | fail | Five minimal geometries of invisible-ghost history variance |
| N7 | pass | Regression guard against the proposed next-live-RO repair |
| S1–S2 | pass | Regression guards against delete-time re-anchoring |
| C1 | pass | Preserve reverse-right-origin clumping |
| C2 | pass | Preserve forward non-interleaving |
| C3 | pass | Preserve meaningful referenced tombstones |

Therefore the default published-FugueMax bug benchmark has two generalized
sensors:

1. `ghost-neutrality`, representing the receiver-side N1–N5 family;
2. `staged-ghost-neutrality`, checking an insert and delete that are published
   and delivered separately, with no observer edit during the live interval.

`local-ghost-neutrality` remains a repair-design control: it checks that an
unpublished local insert-delete pair cannot alter the structural bucket of that
author's next insertion. Published FugueMax fails that structural comparison,
but the current witnesses do not expose a different visible merge, so it is not
counted as a published visible defect.

N7 and C1–C3 are not additional published-FugueMax failures. They constrain a
future repair. S1–S2 likewise reject abandoned repair strategies.

## Why reverse-RO and N7 pull in opposite directions

For insertions with one left origin, FugueMax groups exact right origins into
contiguous buckets and reverses the order of those buckets:

```text
bucket(LO,END), bucket(LO,C), bucket(LO,B)
```

N7 creates a concurrent witness `M` in `bucket(Y,B)` and compares:

```text
insert C immediately before B; delete B
delete B; insert C at B's former visible index
```

If the second C is assigned `RO=END`, reverse-RO moves it before the entire B
bucket. The first C remains inside the B bucket and is ID-ordered with M. Thus
the two locally commuting histories can disagree. Published FugueMax avoids
that particular failure by retaining B as the stable gap coordinate in both
histories.

This does not solve ghost neutrality: an unseen B† must not manufacture a new
bucket for a later edit. It shows that one immutable field cannot safely mean
both "current visible successor" and "stable historical gap." A repair needs a
normalized bucket or separate stable-gap identity, not merely `RO=next-live`.

## One arbitrary trace generator

For each seed, the generator repeatedly chooses among:

- insertion at any visible gap on any replica;
- deletion of any visible token on any replica; and
- handoff of any local outbox prefix to the transport; and
- delivery of any handed-off update whose causal dependencies are present.

Handoff and remote delivery are distinct events. The generator can keep several
local operations queued, hand off any captured prefix, delay network delivery,
and continue editing. This separation is essential because the current
experiment incorrectly lets handoff timing influence insertion origins.

Every insertion records its visible left and right origins. Every local or
remote event records its resulting visible state. At the end, all outstanding
updates are delivered in random causally valid order. Independent sensors then
transform this arbitrary trace; none selects a pre-written example shape.

## Bug sensor 1: invisible-ghost neutrality

The sensor independently chooses:

1. any causal cut in the random trace;
2. any replica at that cut;
3. any visible gap; and
4. a fresh ghost replica ID.

The fresh replica reconstructs that exact causal state, inserts one token, and
deletes it immediately. A selected base replica receives the insert and delete
back-to-back before it can edit. Any later update causally depending on the
ghost carries the pair to its receiver before that update is applied. Everyone
eventually receives the pair.

The original trace and transformed trace use identical base replica IDs, local
operation counts, user commands, and delivery schedule. They are compared
after the atomic pair and after every later base event:

```text
baseline visible state == visible state with the fresh dead ghost
```

No base edit can see the ghost alive. No expected output string, right-origin
geometry, or N-case identifier participates in this comparison.

This one relation discovers N1's root reversal, N2/N3's reverse-RO barriers,
N4's left/right routing distinction, and N5's chained hidden boundaries when
the random trace and injection cut contain the necessary structure.

## Bug sensor 2: staged published-ghost neutrality

Publication is not the same as semantic observation. From an arbitrary settled
trace, this sensor chooses a gap and constructs the following lifecycle:

```text
ghost author: insert G; publish G
future editor: receive G                       (G is visibly present)
future editor: perform no operation referencing G
ghost author: delete G; publish delete(G)
future editor: receive delete(G)               (original text is restored)
future editor: insert C into the restored gap
```

It compares that branch with the same editor inserting the same `C` into the
same gap in a world where `G` never existed. One to three identical concurrent
witnesses are merged into both branches. Trials alternate the relative ID rank
of G, C, and the witnesses so that either possible phantom barrier is exposed.
The pass/fail oracle is visible-order equality; C's raw structural bucket is
reported only as a diagnostic.

On alternating trials, the editor performs an unrelated insertion in a
different gap while G is visible; the identical insertion is made in the
ghost-free branch. This verifies the actual premise—no surviving operation
references G—rather than the overly strict proxy that the editor must remain
completely idle.

This spells out a lifecycle that atomic-delivery wording alone omits: an insert
may be independently published and visibly delivered, then become irrelevant
to future placement after its separately published deletion, provided the
observer created no operation from the live state. In the present operation
format, no CRDT event between the two receives means the final internal tree is
the same as back-to-back delivery; elapsed wall time itself is not state. The
sensor nevertheless exposes published FugueMax behaviorally using concurrent
post-delete continuations rather than treating raw parent/RO equality as the
contract.

## Repair sensor: local outbox ghost neutrality

From an arbitrary settled trace, the sensor chooses any visible gap and creates
one to three concurrent witnesses at that gap. It compares:

```text
baseline: insert C
mutant:   insert g; delete g; insert C
```

The same author ID, base history, visible insertion index, and witnesses are
used in both branches, and there is no publication boundary inside the mutant
sequence. The oracle compares both visible merged order and C's structural
FugueMax bucket. Published FugueMax commonly has the same immediate text but a
different parent/RO for C. Until a generated continuation exposes that
structure as a visible variant, this is a normalization control rather than
part of the published-bug score.

## Repair sensor: delete/insert commutation

This is the generalized version of filtered case N7.

[Open N7 in the generated visual review](./generated/tombstone-tests/index.html#N7).

Starting from any settled random trace, the sensor independently chooses a
contiguous live target run of length one to three and creates one to three
concurrent witnesses in the gap immediately before it. It then constructs three
worlds:

```text
world 1: insert fresh C immediately before B; delete B
world 2: delete B; insert C before handing the delete to transport
world 3: delete B; hand the delete to transport; insert the same C
```

The C author ID and every witness ID are identical between corresponding worlds.
The checker repeats the construction with C's ID before and after the witness
IDs. The oracle is equality between all worlds for each fixed assignment:

```text
merge(world 1, fixed witnesses)
  == merge(world 2, fixed witnesses)
  == merge(world 3, fixed witnesses)
```

This is not the rejected C4 oracle: it never compares different author-ID
assignments or demands that all pre-delete roots precede all post-delete roots.
It changes only the order of two adjacent local commands and an orthogonal
transport schedule. The failure report includes C's structural bucket in all
three worlds and every witness bucket.

The projected-gap experiment currently fails world 3. That is not an exotic
schedule: the repository adapters hand each generated update to their callback
immediately. N7 is therefore a known blocker, not a green control.

## Controls, kept separate from the bug score

`--profile controls` runs properties a repair must preserve:

| Sensor | Predicate | Filtered cases |
|---|---|---|
| `local-ghost-neutrality` | A queued local insert-delete pair changes neither the next insert's visible merge nor structural bucket | local cancellation |
| `delete-insert-commutation` | With IDs fixed, N7 is unchanged by command order or transport handoff | N7 |
| `referenced-tombstone` | Deleting a referenced token and later delivering its dependent are pure projections; all legal delivery orders converge without reordering established survivors | C3's live-reference boundary |
| `reverse-ro-buckets` | For one LO, same-RO items form contiguous buckets; distinct buckets occur in descending RO order, with END first | C1 |
| `step-projection` | Insert adds only its token; delete removes only its target; neither reorders survivors | S1–S2 |
| `forward-non-interleaving` | A provably earliest observed left-origin child remains adjacent | C2 |
| `backward-non-interleaving` | Conservative equal-LO subset of backward adjacency | Formal core related to C1 |
| `convergence` | Settled replicas agree | Diagnostic only |

The non-interleaving predicates use the PR #36 technique:

1. record every pair ever co-visible in an observed state;
2. compute the transitive closure of that observed order;
3. track only insertions delivered to the relevant replica through that state;
4. accept unresolved deleted-sibling ordering; and
5. report only when the premise is certain in every compatible totalization.

[`test_tombstone_fuzzer.js`](./test_tombstone_fuzzer.js) pins future-sibling,
cross-replica, unresolved-sibling, transitive-order, and discovery behavior.

The backward-with-deletes predicate is experimental and conservative. It runs
only when selected explicitly or under `--profile all`; it is excluded from
both `controls` and the candidate `required` profile. Its findings are
candidate cases for review, not part of the filtered contract.

### Generalized reverse-RO bucket control

The reverse-RO sensor extends an arbitrary settled trace rather than replaying
Figure 7. At the trace's final gap it generates:

- one fresh common left origin;
- two to five concurrent right boundaries;
- one to three concurrent insertions per exact right-origin bucket; and
- an additional `RO=END` bucket.

It first observes the implementation's actual order of the concurrent boundary
nodes. It then derives the expected bucket order by reversing that order and
placing `END` first. Delivery of the bucket items is shuffled independently.
The assertion checks the sequence of bucket identities, not token names or one
hard-coded string, so it simultaneously verifies outer ordering and same-RO
clumping.

## Scope of the N7 generalization

The sensor does not claim that arbitrary inserts and deletes commute. Its two
commands are deliberately adjacent and target different elements at the same
gap:

```text
insert C before B; delete B
delete B; insert C into the resulting gap
```

The arbitrary prefix, selected target, number of witnesses, left/right-child
routing, and relative author IDs vary. The local commands themselves do not.
Handoff is varied independently because transport timing must not choose
document semantics. This is the scoped commuting square actually justified by
N7.

There is nevertheless an unresolved semantic ambiguity: raw
`delete(B); insert(C)` can describe either a logical replacement in B's old
slot or an unrelated later insertion into the new visible gap. Ghost neutrality
and unconditional raw-command N7 commutation demand different coordinates in
some histories. The current best design direction is to make replacement an
explicit `splice`/`replace` intent and fuzz alternate internal schedules of that
same logical edit. That API and oracle have not yet been implemented.

C3 also remains an explicit positive witness because the fresh-ghost transform
never erases an existing tombstone referenced by surviving content. C1 remains
the exact Figure-7 reverse-RO regression. Neither should count red against
published FugueMax.

### Why the staged ghost is not physically deleted

The staged sensor establishes *future-placement transparency*, not immediate
garbage collection. A replica cannot know, merely from receiving `delete(G)`,
whether a concurrent operation created elsewhere while `G` was live is still
in flight. The implementation therefore retains `G` and its immutable tree
position. It only excludes the dead node from the projection used to generate
new insertions; traversal continues through its descendants.

The paired `referenced-tombstone` control exercises the unsafe mirror:

```text
publish G; observer receives G; observer inserts X after live G;
delete G; another editor inserts Y after learning the deletion
```

Both delivery orders must converge; deleting G must remove only G; and delivery
of late X must add only X without swapping the already-visible W/Y survivors.
The sensor repeats both relevant ID-rank directions. This makes the test
boundary behavioral—whether an operation was actually authored from the live
state—instead of guessing from packet timing.
Physical removal would require causal stability/acknowledgements proving no
such reference can still arrive.

The sensor deliberately does not demand `Y<X` after the delete is handed to
sync. Y's author did not know X, so immutable FugueMax structure decides their
relative order. The required properties are reference survival, convergence,
and pure insert/delete projection without moving previously visible content.

### Remaining lifecycle coverage

The following are not yet claimed by the generalized suite and should be added
before a replacement algorithm is called complete:

- unrelated causally valid deliveries during the interval in which a staged
  insert is visible (unrelated local editing is now covered);
- staged chains of two or more published dead nodes;
- surviving references with `RO=G` and left-child-of-`G` geometry, in addition
  to the current `LO=G` continuation;
- a same-author target that is created, published, then later deleted and
  replaced; and
- crash/restart integration tests that restore the CRDT snapshot, durable
  transport outbox, and `saveLocalPublicationState()` together. The checker
  suite already pins the local-state round trip, fresh-replica requirement,
  partial publication watermarks, and rejection of mismatched shared/local
  snapshots in isolation.

The semantically relevant premise is ultimately “no surviving operation
references G,” not the coarser phrase “no edit occurred while G was visible.”
An edit elsewhere in the document may be unrelated to G. Conversely, a hidden
in-flight operation can make G meaningful even though the replacing replica
performed no live-period edit itself.

A published insert-delete pair followed by a later edit from the *same* author
was also tested as a possible fourth published-FugueMax bug sensor. Across the
general trace corpus it produced no visible counterexample: the raw ancestry
differs, but the same-author causal continuation keeps the surviving edit in
the same observable order. It is therefore not counted as a defect merely to
make the candidate look better. The valid local pending-pair test remains
because its explicit requirement is cancellable outbox structure, not a
claimed published-FugueMax visible failure.

## Running it

From `fugue-interleave`:

```sh
# Default: the generalized published-FugueMax ghost defect.
npm run fuzz:tombstones

# Preservation controls, reported separately.
npm run fuzz:tombstones:controls

# Run the complete candidate contract. This currently exits nonzero on the
# N7 transport-handoff counterexample documented above.
npm run fuzz:tombstones:check

# Unit tests for the general checkers and discoveries.
npm run test:tombstone-fuzzer

# Larger or focused deterministic searches.
node fuzz_tombstone_properties.js \
  --module fugue-max-canonical --profile published-bugs \
  --seed review-1 --traces 1000 --steps 40 --clients 4

node fuzz_tombstone_properties.js \
  --sensor delete-insert-commutation --traces 500 --commutation-trials 5

node fuzz_tombstone_properties.js \
  --sensor reverse-ro-buckets --traces 500 --bucket-trials 5

# Replay an exact trace index printed with a failure.
node fuzz_tombstone_properties.js \
  --seed review-1 --trace 37 --steps 40 --clients 4
```

Trace `i` has seed `<root>/trace/<i>`. Metamorphic choices use child seeds
ending in `/ghost/<trial>`, `/commutation/<trial>`, or `/bucket/<trial>`. Increasing the search bound
cannot perturb earlier traces.

## Validation snapshot

For 100 traces, 30 random commands, three replicas, and three trials per sensor
with the default seed:

| Implementation | Atomic remote | Staged published | Local outbox | N7 | Referenced tombstone |
|---|---:|---:|---:|---:|---:|
| Frozen published FugueMax | 29 | 300 | 300 structural | 0 | 0 |
| Projected-gap experiment | 0 | 0 | 0 | **261** | 0 |

Only the two remote/staged ghost columns are the published visible-bug score.
The local column is a structural repair control. N7 and referenced-history
safety are also repair constraints that published FugueMax already preserves.
The experiment repairs the generated ghost lifecycles but is not complete: its
N7 result depends on transport handoff.

Across the same 100 published-FugueMax traces, 300 generalized reverse-RO
bucket trials produced zero control failures, as expected. This control is
reported separately because a correct repair must keep it green rather than
make published FugueMax red.

As a non-vacuity check, the same reverse-RO sensor rejects ordinary
`FugueSimple`, which lacks FugueMax's reverse-right-origin comparator: 20/20
trials fail under the small checker-test configuration.

Random search is not exhaustive proof. A nonzero result is a deterministic,
replayable counterexample; a zero result only means no failure was found under
the selected seeds and bounds.
