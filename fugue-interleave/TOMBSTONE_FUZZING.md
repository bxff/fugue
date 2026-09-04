# Generalized tombstone-property fuzzer

`fuzz_tombstone_properties.js` uses the architecture of
[collaborative-text-editing-algorithms PR #36](https://github.com/samiabobaker/collaborative-text-editing-algorithms/pull/36):
generate arbitrary legal executions first, record their states and causal
events, and run independent predicates or metamorphic rewrites over them.

It does not generate renamed copies of N1, N2, and the other hand-written
examples. Those examples are small reviewable witnesses; the fuzzer asks
whether their underlying laws survive arbitrary settled prefixes, gaps,
authors, ID orderings, runs, and delivery schedules.

## What is being benchmarked

The retained suite has three distinct roles:

| Cases | Role |
|---|---|
| N1-N5 | Published FugueMax defects: unsupported insert/delete history adds visible variants |
| N7 and D1 | Define the required distinction between declared replacement and ordinary insertion |
| S1-S2, C1-C3 | Controls that a repair must preserve: stability, clumping, non-interleaving, and referenced history |

Published FugueMax is therefore expected to fail the ghost sensors. It is not
made red for arbitrary raw insert/delete commutation: that law is false. It also
cannot satisfy the declared-splice API relation because published FugueMax has
no such API.

## One arbitrary trace generator

For each deterministic seed, the generator repeatedly chooses among:

- insertion at any visible gap on any replica;
- deletion of any visible token;
- handoff of any locally created update to the simulated transport; and
- delivery of any handed-off update whose causal dependencies are present.

Handoff is represented only to generate legal asynchronous delivery histories.
It is not exposed to the algorithm as semantic state. Inserting or removing a
handoff between two otherwise identical document actions is tested as a
stutter step.

Every local insertion records its visible gap and emitted structural bucket.
Every event records the resulting visible sequence. Outstanding updates are
eventually delivered in shuffled, causally valid orders.

## Metamorphic sensors

### `ghost-neutrality`

At an arbitrary causal cut, gap, and replica, a fresh author inserts and
immediately deletes a fresh node. A selected editor receives the pair
back-to-back before its next base edit. Any transformed causal dependent is
given the pair before that dependent is applied.

The baseline and mutant retain the same base author IDs, commands, and delivery
schedule. They are compared after the injection and after every later base
event:

~~~text
visible(baseline) = visible(with unsupported dead ghost)
~~~

No expected output string or N-case shape is used. This discovers the root,
interior reverse-RO, and left/right routing forms when the random prefix exposes
them.

### `staged-ghost-neutrality`

This varies the lifecycle without changing the semantic premise:

~~~text
insert G; publish/deliver G
observer creates no surviving structural reference to G
delete G; publish/deliver delete(G)
observer performs the same later insertion as in a G-free world
~~~

The generator varies the settled prefix, gap, unrelated edits elsewhere while G
is live, one to three concurrent witnesses, and ID rank in both directions.
The oracle is final visible-order equality. Raw buckets are diagnostics.

This covers the important case where an insert was separately synchronized and
only became observationally irrelevant after its later deletion. “Still in the
outbox” is neither required nor meaningful to the algorithm.

### `local-ghost-neutrality`

A local fresh insert/delete pair is added before the author's next insertion.
The pair must change neither the next insertion's structural bucket nor its
visible merge against fixed witnesses. This is a structural repair control, not
a transport-state rule.

### `transport-stutter`

Two branches execute the same delete(s), then ordinary insertion, with identical
authors, observations, and witnesses. One branch contains a simulated handoff
between the document actions. The emitted bucket and final order must agree.

This sensor replaced the unsound raw “insert-delete equals delete-insert” rule.
Those command sequences can encode different intents and are not generally
equivalent.

### `splice-lowering-equivalence`

From an arbitrary settled prefix, the sensor chooses:

- any nonempty target range of length one to three;
- a replacement run of length one to three;
- one to three concurrent same-gap witnesses; and
- replacement IDs on either side of witness IDs.

It compares:

~~~text
reference:
  insert the replacement run while targets are live
  delete the captured targets

declared:
  splice(index, targetCount, ...replacementRun)
~~~

The two branches must emit the same first structural bucket, converge to the
same visible order, and keep the replacement run adjacent. This generalizes N7
without claiming that arbitrary raw commands commute.

### `referenced-tombstone`

The sensor creates a node G that becomes deleted while a surviving reference is
in flight. It covers both direct dependency geometries:

- parent/left-origin support: `LO(X)=G`; and
- right-origin support: `RO(X)=G`.

It then varies delivery order and both relevant ID orientations. Deleting G must
remove only G; late delivery must add only X; established survivors must not
move; and all legal delivery orders must converge.

This is the generalized C3 boundary. It does **not** require a universal
post-delete `Y<X` order. An author who has not seen in-flight X cannot use X as
an origin. The immutable tree may choose either final relative order, but it may
not lose X or retroactively reorder existing content.

### `intent-boundary`

This is the generalized D1 construction. From an arbitrary settled prefix and
gap it creates:

- a fresh target B;
- concurrent current-gap content X that never saw B;
- ordinary R generated after deleting unsupported B;
- replacement R generated in B's captured live slot; and
- an in-flight insertion M with `RO(M)=B`.

Both ID-rank directions and both late-M delivery positions are exercised. The
oracle requires ordinary R to share X's projected bucket, replacement R to
share M's captured-B bucket, convergence in both schedules, and no survivor
movement when M arrives. This makes the explicit-intent boundary independently
testable instead of deriving it only from N7 and C3.

### `reverse-ro-buckets`

From an arbitrary settled context, the sensor creates one common left origin,
two to five concurrent right boundaries, one to three insertions in each exact
RO bucket, and an `RO=END` bucket. It derives expected bucket order from the
implementation-observed boundary order:

~~~text
END first, then distinct RO buckets in reverse boundary order
~~~

The assertion checks bucket identities and contiguity rather than token names.
This generalizes Figure 7/C1 and detects both flattened sibling ordering and
loss of same-RO clumping.

### Stability and convergence controls

- `step-projection`: one insert adds only its node and one delete removes only
  its target; neither operation reorders prior survivors.
- `forward-non-interleaving`: when the recorded causal observations prove an
  earliest left-origin continuation, it remains adjacent.
- `convergence`: all settled replicas agree for one fixed operation set.
- `backward-non-interleaving`: an experimental conservative checker available
  only in the `all` profile; it is not a validity oracle or completion gate.

The non-interleaving predicates use recorded co-visibility and transitive
observed order to report only when their premises are established. Unit tests
pin future siblings, cross-replica observations, unresolved siblings,
transitive order, and non-vacuous discovery behavior.

## Profiles

- `published-bugs`: atomic and staged ghost-neutrality sensors—the visible
  defect score for published FugueMax.
- `controls`: preservation properties and splice lowering.
- `required`: the full candidate contract, excluding only the experimental
  backward checker.
- `all`: everything, including experimental diagnostics.

## What the fuzzer establishes—and what it does not

A reported failure is deterministic and replayable from its seed and trace
index. A zero count means no failure was found under that finite search; it is
not a proof.

The present generalizations are substantive, but they still extend a random
settled prefix with targeted metamorphic motifs. Before a completion claim they
must be broadened to:

- bounded exhaustive small histories and every causal linearization;
- longer alternating parent/right-origin support chains and nested left-child
  routes;
- several staged tombstones whose support changes over time;
- restarts and save/load at arbitrary event cuts;
- concurrent overlapping/multi-element splices and edits inside replaced
  ranges; and
- a mutation suite proving each sensor rejects the specific broken strategy it
  is meant to detect.

The true ghost premise is “no surviving structural operation depends on G,” not
merely “no edit happened while G was visible.” An unrelated edit elsewhere is
allowed. Conversely, an unseen in-flight reference makes G meaningful even if
the deleting editor never observed that reference.

## Running it

From `fugue-interleave`:

~~~sh
# Published-FugueMax defect search.
npm run fuzz:tombstones

# Repair-preservation controls.
npm run fuzz:tombstones:controls

# Complete candidate gate.
npm run fuzz:tombstones:check

# Checker unit tests.
npm run test:tombstone-fuzzer

# Larger/focused deterministic runs.
node fuzz_tombstone_properties.js \
  --module fugue-max-canonical --profile published-bugs \
  --seed review-1 --traces 1000 --steps 40 --clients 4

node fuzz_tombstone_properties.js \
  --sensor splice-lowering-equivalence \
  --traces 500 --commutation-trials 5

node fuzz_tombstone_properties.js \
  --sensor referenced-tombstone \
  --traces 500 --commutation-trials 5

node fuzz_tombstone_properties.js \
  --sensor intent-boundary \
  --traces 500 --commutation-trials 5

node fuzz_tombstone_properties.js \
  --sensor reverse-ro-buckets \
  --traces 500 --bucket-trials 5
~~~

Trace `i` has seed `<root>/trace/<i>`. Metamorphic choices use stable child
seeds, so raising the search bound does not change earlier traces.

## Current deterministic snapshot

With the repository's checked default bounds:

- support-projected FugueMax + splice: zero failures in every required sensor;
- published FugueMax: reproducible atomic/staged ghost counterexamples and no
  `splice` API; and
- ordinary FugueSimple: rejected by the reverse-RO non-vacuity control.

Use the command output as the authoritative count for a particular seed and
bound. The result supports the candidate; it does not elevate bounded fuzzing
to a correctness proof.
