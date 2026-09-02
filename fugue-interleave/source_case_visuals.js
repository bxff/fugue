// Original-source traces that are not part of the 12-case semantic gate.
//
// These remain visible so that proposed reductions can be reviewed instead of
// accepted from prose alone.  `evidence` deliberately distinguishes an exact
// reconstruction from a topology-only or missing trace.

const result = (label, value, pass, status) => ({ label, value, pass, status });

const review = ({
  id, name, property, role = "source case", decision = "provisional",
  evidence = "exact reconstructed trace", rationale, question, catches,
  required, worlds,
}) => ({ id, name, property, role, decision, evidence, rationale, question, catches, required, worlds });

export const sourceReviewCases = [
  review({
    id: "I7", name: "legacy bdac / concurrent DE-between-BC trace", property: "delete-free same-origin ordering",
    decision: "outside", evidence: "exact source trace from index.js",
    rationale: "Kept visible rather than silently pruned. It contains no deletion, so it cannot witness tombstone neutrality; the later correspondence explicitly withdrew it as a bug claim.",
    question: "Does a peer that saw only B,C legitimately keep its D,E run together even when unseen A later appears?",
    catches: "The withdrawn bdac objection and its two-character DE extension.",
    required: "Review independently. Its observed FugueMax result is bdeac; it does not compare histories that differ by a ghost.",
    worlds: [{
      title: "Peers insert D and E into the visible B,C gap", source: ["B", "A", "C"],
      branches: [
        { actor: "DE", view: ["B", "D", "E", "C"], from: ["B", "C"], origin: "D,E saw only B,C; both target LO=B, RO=C" },
        { actor: "A", view: ["B", "A", "C"], from: ["B", "A", "C"], origin: "A was concurrent and absent from the DE authors' views" },
      ],
      results: [result("FugueMax", "bdeac", true, "OBSERVED")],
    }],
  }),
  review({
    id: "I8", name: "legacy PhantomBarrier_Basic convergence test", property: "delivery convergence",
    evidence: "exact source trace from index.js",
    rationale: "Not a duplicate assertion of N2/N3: it merges two different Y operations into one op-set and only compares delivery orders. Retained as a separate non-gating source test.",
    question: "Do two merge schedules agree after including both Y-from-dead-history and Y-from-no-history operations?",
    catches: "Delivery-order divergence in the abandoned live-RO implementation.",
    required: "Both schedules produce ayycd. This does not require the two Y operations to have neutral placement when compared separately.",
    worlds: [
      { title: "All inserts/deletion, then both Y operations", source: ["A", "B†", "C", "D"], branches: [
        { actor: "Y₁", view: ["A", "Y", "C", "D"], from: ["A", "B†", "C", "D"], origin: "author saw A,B†,C,D" },
        { actor: "Y₂", view: ["A", "Y"], from: ["A"], origin: "author saw only A" },
      ], results: [result("Legacy assertion", "ayycd", true, "PASS")] },
      { title: "Y₂ delivered before hidden B† history", source: ["A", "B†", "C", "D"], branches: [
        { actor: "Y₂", view: ["A", "Y"], from: ["A"], origin: "delivered before B†,C,D" },
        { actor: "Y₁", view: ["A", "Y", "C", "D"], from: ["A", "B†", "C", "D"], origin: "delivered after its causal history" },
      ], results: [result("Legacy assertion", "ayycd", true, "PASS")] },
    ],
  }),
  review({
    id: "I9", name: "legacy ChainDelete convergence test", property: "delivery convergence + dead-chain stress",
    evidence: "exact source trace from index.js",
    rationale: "Related to N5 and S2 but not identical: this original test checks two schedules of one op-set with B†,C† and two surviving inserts.",
    question: "Do different schedules agree when Y saw B†,C† but Z saw only live A,D?",
    catches: "One-hop replacement and delivery-sensitive chain hopping in the abandoned fix.",
    required: "Both schedules produce azyd. It remains a useful implementation regression even though it is not ghost-neutrality by itself.",
    worlds: [
      { title: "Dead chain delivered before Y", source: ["A", "B†", "C†", "D"], branches: [
        { actor: "Y", view: ["A", "Y", "D"], from: ["A", "B†", "C†", "D"], origin: "Y saw the complete dead chain" },
        { actor: "Z", view: ["A", "Z", "D"], from: ["A", "D"], origin: "Z saw only A,D" },
      ], results: [result("Legacy assertion", "azyd", true, "PASS")] },
      { title: "Z and Y arrive before the delete messages", source: ["A", "B†", "C†", "D"], branches: [
        { actor: "Z", view: ["A", "Z", "D"], from: ["A", "D"], origin: "Z delivered first" },
        { actor: "Y", view: ["A", "Y", "D"], from: ["A", "B†", "C†", "D"], origin: "Y before delete delivery at the merger" },
      ], results: [result("Legacy assertion", "azyd", true, "PASS")] },
    ],
  }),
  review({
    id: "I10", name: "legacy MultiPeerDelete convergence test", property: "multiple delete dots",
    evidence: "exact source trace from index.js",
    rationale: "This must not be reduced away. Three concurrent authors delete the same B with different visible suffixes; C4 does not execute this stress topology.",
    question: "Can three concurrent delete dots for B make a later Y placement depend on delivery order?",
    catches: "Conflicting delete metadata or replacement origins from A,B versus B,C versus B,C,D views.",
    required: "All three schedules produce aycd. The semantic order is not new, but the multiple-delete implementation obligation is distinct.",
    worlds: [
      { title: "Delete dots delivered in author order", source: ["A", "B†", "C", "D"], branches: [
        { actor: "ΔA", view: ["A", "B†"], from: ["A", "B†"], origin: "deleted B while seeing A,B" },
        { actor: "ΔC", view: ["B†", "C"], from: ["B†", "C"], origin: "deleted B while seeing B,C" },
        { actor: "ΔD", view: ["B†", "C", "D"], from: ["B†", "C", "D"], origin: "deleted B while seeing B,C,D" },
        { actor: "Y", view: ["A", "Y", "C", "D"], from: ["A", "B†", "C", "D"], origin: "typed after receiving all delete dots" },
      ], results: [result("Legacy assertion", "aycd", true, "PASS")] },
      { title: "Delete dots delivered in conflicting orders", source: ["A", "B†", "C", "D"], branches: [
        { actor: "ΔC", view: ["B†", "C"], from: ["B†", "C"], origin: "C-view delete arrives first" },
        { actor: "ΔD", view: ["B†", "C", "D"], from: ["B†", "C", "D"], origin: "D-view delete arrives next" },
        { actor: "ΔA+Y", view: ["A", "Y", "C", "D"], from: ["A", "B†", "C", "D"], origin: "remaining delete and Y arrive later" },
      ], results: [result("Legacy assertion", "aycd", true, "PASS")] },
    ],
  }),
  review({
    id: "I11", name: "legacy ResortingConvergence test", property: "delete-time re-sorting",
    evidence: "exact source trace from index.js",
    rationale: "Related to S1, but preserved separately because the original assertion compares three delivery schedules and includes X,Y sharing RO=B plus Z below B.",
    question: "Can deleting B re-sort X,Y differently on incrementally integrated and freshly reconstructed replicas?",
    catches: "Delete-time right-origin mutation and save/rebuild ordering disagreements.",
    required: "Before deletion aXYbZc; afterward every schedule gives aXYZc.",
    worlds: [
      { title: "Before deleting B", source: ["A", "B", "C"], branches: [
        { actor: "XY", view: ["A", "X", "Y", "B", "C"], from: ["A", "B", "C"], origin: "X,Y both LO=A, RO=B" },
        { actor: "Z", view: ["A", "B", "Z", "C"], from: ["B", "C"], origin: "Z has LO=B, RO=C" },
      ], results: [result("Observed", "aXYbZc", true, "BASELINE")] },
      { title: "After B deletion under three schedules", source: ["A", "B†", "C"], branches: [
        { actor: "XY", view: ["A", "X", "Y", "C"], from: ["A", "B†", "C"], origin: "X,Y keep B's structural slot" },
        { actor: "Z", view: ["A", "Z", "C"], from: ["B†", "C"], origin: "Z remains B's continuation" },
      ], results: [result("All schedules", "aXYZc", true, "PASS")] },
    ],
  }),
  review({
    id: "E01", name: "POINT 1 global pre-era/post-era ordering", property: "disputed global Era separation",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Not reduced to N5/C3. It is shown independently because AYM W-before-N is a stronger global ordering proposal, not a consequence of ghost neutrality.",
    question: "Must every insertion made while B,D were live precede N, which was typed after deleting both?",
    catches: "The full global Era rule across a two-tombstone chain.",
    required: "Proposal: AYM WN. Published FugueMax gives AYNMW; this expectation remains disputed.",
    worlds: [{ title: "Y,M,W pre-delete; N post-delete", source: ["A", "B†", "D†"], branches: [
      { actor: "Y/M", view: ["A", "Y", "M", "B", "D"], from: ["A", "B†"], origin: "Y in (A,B); M in (Y,B) while alive" },
      { actor: "W", view: ["A", "B", "W", "D"], from: ["B†", "D†"], origin: "W in (B,D) while alive" },
      { actor: "N", view: ["A", "Y", "N"], from: ["A", "B†", "D†"], origin: "N after deleting B and D" },
    ], results: [result("Current Era", "AYMWN", true, "PROPOSAL"), result("Published FugueMax", "AYNMW", false, "DIFFERS")] }],
  }),
  review({
    id: "E08", name: "right-side Era mirror", property: "disputed Era override of structural order",
    decision: "disputed", evidence: "exact source trace; E08/E09 are sender mirrors",
    rationale: "Kept independent. Z is a live continuation of U while X is typed after deleting U; AZX requires an Era exception to canonical structural ordering.",
    question: "Must Z, typed after live U, precede X, typed after deleting U, for both sender assignments?",
    catches: "A proposed symmetric Era rule on the right side of a tombstone.",
    required: "Proposal AZX; published FugueMax deterministically gives AXZ. This is not implied by C4's exact same-boundary tie.",
    worlds: [{ title: "Both sender assignments have the same topology", source: ["A", "U†"], branches: [
      { actor: "Z", view: ["A", "U", "Z"], from: ["U†"], origin: "Z typed after U while U was live" },
      { actor: "X", view: ["A", "X"], from: ["A", "U†"], origin: "delete U, then X after A" },
    ], results: [result("Current Era", "AZX", true, "PROPOSAL"), result("Published FugueMax", "AXZ", false, "DIFFERS")] }],
  }),
  review({
    id: "E10", name: "left-child Era layering across a dead gap", property: "disputed Era re-anchoring",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Kept independent because it exercises two left children of M and cannot be established by the smaller C4 tie.",
    question: "Must pre-delete Z precede post-delete X after T,U are removed?",
    catches: "The after-tombstone comparator on the left-child branch.",
    required: "Proposal AYZXM; published FugueMax gives AXYZM.",
    worlds: [{ title: "Two dead boundaries before live M", source: ["A", "T†", "U†", "M"], branches: [
      { actor: "Y", view: ["A", "T", "Y", "U", "M"], from: ["T†", "U†"], origin: "Y between live T,U" },
      { actor: "Z", view: ["A", "U", "Z", "M"], from: ["U†", "M"], origin: "Z between live U,M" },
      { actor: "X", view: ["A", "X", "M"], from: ["A", "T†", "U†", "M"], origin: "delete T,U then X in (A,M)" },
    ], results: [result("Current Era", "AYZXM", true, "PROPOSAL"), result("Published FugueMax", "AXYZM", false, "DIFFERS")] }],
  }),
  review({
    id: "E11", name: "pre-delete UV run versus post-delete XYZ run", property: "same-boundary run extension",
    decision: "provisional", evidence: "exact source trace; E11/E12 are sender mirrors",
    rationale: "Not silently collapsed into C4/N6. It combines a two-character pre-delete run and a three-character post-delete run and therefore remains a separately inspectable stress case.",
    question: "Do both complete runs remain contiguous, and should UV precede XYZ independently of sender IDs?",
    catches: "Run-sized extension of the C4 sender lottery.",
    required: "Proposed AUVXYZ for both sender assignments. Published FugueMax gives AXYZUV for one assignment and AUVXYZ for the other.",
    worlds: [
      { title: "Post sender 1, pre sender 9", source: ["A", "B†"], branches: [
        { actor: "UV", view: ["A", "U", "V", "B"], from: ["A", "B†"], origin: "pre-delete forward run in (A,B)" },
        { actor: "XYZ", view: ["A", "X", "Y", "Z"], from: ["A", "B†"], origin: "delete B, then post-delete forward run" },
      ], results: [result("Current Era", "AUVXYZ", true, "PROPOSAL"), result("Published FugueMax", "AXYZUV", false, "DIFFERS")] },
      { title: "Post sender 9, pre sender 1", source: ["A", "B†"], branches: [
        { actor: "UV", view: ["A", "U", "V", "B"], from: ["A", "B†"], origin: "same pre-delete run" },
        { actor: "XYZ", view: ["A", "X", "Y", "Z"], from: ["A", "B†"], origin: "same post-delete run" },
      ], results: [result("Current Era", "AUVXYZ", true, "PROPOSAL"), result("Published FugueMax", "AUVXYZ", true, "MATCHES") ] },
    ],
  }),
  review({
    id: "E13", name: "three stacked deletion eras", property: "disputed recursive Era ordering",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Kept independent because recursive delete→insert→delete→insert behavior is not executed by C4.",
    question: "Should Y from B's live slot precede Q after deleting B, inserting P, deleting P, then inserting Q?",
    catches: "Recursive/stacked tombstone knowledge.",
    required: "Proposal AYQ; published FugueMax gives AQY.",
    worlds: [{ title: "B† then P† then Q", source: ["A", "B†", "P†"], branches: [
      { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B†"], origin: "Y typed in (A,B) before either deletion" },
      { actor: "Q", view: ["A", "Q"], from: ["A", "B†", "P†"], origin: "delete B; insert/delete P; insert Q" },
    ], results: [result("Current Era", "AYQ", true, "PROPOSAL"), result("Published FugueMax", "AQY", false, "DIFFERS")] }],
  }),
  review({
    id: "E17", name: "UWZX mixed-era, different-right-origin trace", property: "disputed Era-first comparator",
    decision: "disputed", evidence: "exact source trace; E17/E18 differ only in whether X saw concurrent W",
    rationale: "Kept independent. It is specifically the case where Era-first conflicts with reverse-RO-first ordering rather than an exact tie.",
    question: "Should pre-delete Z precede post-delete X even though reverse-RO geometry orders X first?",
    catches: "Mixed Era classes with different ROs and an unrelated-sync-state mirror.",
    required: "Proposal ZXWE; published FugueMax gives XZWE. E18 verifies the result is unchanged when X had also received W.",
    worlds: [
      { title: "X did not receive concurrent W", source: ["U†", "W", "E"], branches: [
        { actor: "Z", view: ["U", "Z", "W", "E"], from: ["U†", "W"], origin: "Z between live U,W" },
        { actor: "X", view: ["X", "E"], from: ["U†", "E"], origin: "delete U, then X; W unseen" },
      ], results: [result("Current Era", "ZXWE", true, "PROPOSAL"), result("Published FugueMax", "XZWE", false, "DIFFERS")] },
      { title: "X received W before deleting U", source: ["U†", "W", "E"], branches: [
        { actor: "Z", view: ["U", "Z", "W", "E"], from: ["U†", "W"], origin: "same Z operation" },
        { actor: "X", view: ["X", "W", "E"], from: ["U†", "W", "E"], origin: "delete U, then X after receiving W" },
      ], results: [result("Current Era", "ZXWE", true, "PROPOSAL"), result("Published FugueMax", "XZWE", false, "DIFFERS")] },
    ],
  }),
  review({
    id: "E19", name: "POINT1-minus-M", property: "direct Era versus forward-NI conflict",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Kept independent because it demonstrates a normative conflict, not a redundant failure: Era puts W before N while canonical forward structure keeps Y,N together.",
    question: "May W, typed in the live B,D gap, separate Y from N after B,D are deleted?",
    catches: "The minimal chain case where global Era separation overrides a forward continuation.",
    required: "Era proposal AYWN; forward-NI-compatible published result AYNW.",
    worlds: [{ title: "W pre-delete, N post-delete", source: ["A", "B†", "D†"], branches: [
      { actor: "Y", view: ["A", "Y", "B", "D"], from: ["A", "B†"], origin: "Y in (A,B)" },
      { actor: "W", view: ["A", "B", "W", "D"], from: ["B†", "D†"], origin: "W in (B,D) while alive" },
      { actor: "N", view: ["A", "Y", "N"], from: ["A", "B†", "D†"], origin: "delete B,D; N after Y" },
    ], results: [result("Current Era", "AYWN", true, "PROPOSAL"), result("Published FugueMax", "AYNW", false, "FORWARD NI")] }],
  }),
  review({
    id: "E21", name: "T1 sender-9 continuation split", property: "direct Era versus forward-NI conflict",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Kept separately and also linked to C2. This is the actual APYQ versus APQY conflict that triggered the specification correction.",
    question: "Can concurrent Y appear between P and Q when LO(Q)=P?",
    catches: "The common type-before-B, backspace-B, continue-typing pattern.",
    required: "Era proposes APYQ; forward non-interleaving requires APQY for this sender assignment.",
    worlds: [{ title: "Y sender 9", source: ["A", "B†"], branches: [
      { actor: "PQ", view: ["A", "P", "Q"], from: ["A", "B†"], origin: "P in (A,B); delete B; Q with LO= P" },
      { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B†"], origin: "concurrent Y in (A,B)" },
    ], results: [result("Current Era", "APYQ", true, "ERA PROPOSAL"), result("Published FugueMax", "APQY", true, "FORWARD NI")] }],
  }),
  review({
    id: "E24", name: "T3 batched delete-and-insert", property: "same-transaction C4 extension",
    evidence: "exact source trace from test_solution.js",
    rationale: "Kept independently because a single transaction envelope containing delete(B)+insert(C) is an implementation path not exercised by C4's two transactions.",
    question: "Does batching delete(B) and insert(C) preserve the proposed AYC exact-boundary order?",
    catches: "Causal metadata for multiple primitives in one transaction.",
    required: "Proposed AYC. Published FugueMax gives ACY for the failing sender assignment.",
    worlds: [{ title: "Delete B and insert C in one transaction", source: ["A", "B†"], branches: [
      { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B†"], origin: "concurrent Y in live (A,B) slot" },
      { actor: "ΔB+C", view: ["A", "C"], from: ["A", "B†"], origin: "one envelope: delete B, insert C" },
    ], results: [result("Current Era", "AYC", true, "PROPOSAL"), result("Published FugueMax", "ACY", false, "DIFFERS")] }],
  }),
  review({
    id: "E30", name: "T8 same-anchor multi-stop pins", property: "disputed Era stop-node semantics",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Kept independent. Three post-delete inserts know different live stop nodes; neither C4 nor C3 executes this topology.",
    question: "Should each post-delete insert sit immediately before the first live stop node it knew?",
    catches: "Multiple post-delete operations sharing an anchor but carrying different visible right pins.",
    required: "Era proposal A1M2N3; published FugueMax gives A123MN.",
    worlds: [{ title: "Three post-delete inserts with M, N, or END stop", source: ["A", "B†", "M", "N"], branches: [
      { actor: "1", view: ["A", "1", "M"], from: ["A", "B†", "M"], origin: "saw delete B and live M" },
      { actor: "2", view: ["A", "2", "N"], from: ["A", "B†", "N"], origin: "saw delete B and live N" },
      { actor: "3", view: ["A", "3"], from: ["A", "B†"], origin: "saw delete B only" },
    ], results: [result("Current Era", "A1M2N3", true, "PROPOSAL"), result("Published FugueMax", "A123MN", false, "DIFFERS")] }],
  }),
  review({
    id: "E32", name: "T10 backward post-delete run", property: "disputed Era placement + backward run",
    decision: "disputed", evidence: "exact source trace from test_solution.js",
    rationale: "Kept independent because it composes a backward-typed run with pre-delete Y and a live M boundary.",
    question: "Should the backward 789 run remain contiguous after pre-delete Y but before M?",
    catches: "Backward run preservation under the proposed Era layer.",
    required: "Era proposal AY789M; published FugueMax keeps the run but gives A789YM.",
    worlds: [{ title: "Delete B, type 9 then 8 then 7 at the gap", source: ["A", "B†", "M"], branches: [
      { actor: "Y", view: ["A", "Y", "B", "M"], from: ["A", "B†", "M"], origin: "Y typed before B deletion" },
      { actor: "789", view: ["A", "7", "8", "9", "M"], from: ["A", "B†", "M"], origin: "post-delete backward run" },
    ], results: [result("Current Era", "AY789M", true, "PROPOSAL"), result("Published FugueMax", "A789YM", false, "DIFFERS")] }],
  }),
];

// Source-ledger aliases. An alias means the original source row can open an
// exact graph, but it does not by itself prove that the proposed reduction is
// valid. Rows absent from this map get an explicit metadata-only view.
export const auditVisualAliases = {
  I2: "C1", I3: "C1", I4: "C1", I5: "N3", I6: "N3", I7: "I7",
  I8: "I8", I9: "I9", I10: "I10", I11: "I11", I12: "N6", I13: "N3",
  "F2.1": "N4", LO1: "N7", LO2: "I7", LO3: "C3", LO4: "C4",
  "LO2.1": "N7", "LO2.2": "N6", "LO2.3": "I7", "LO2.4": "I7",
  E01: "E01", E02: "C4", E03: "C4", E04: "C4", E08: "E08", E09: "E08",
  E10: "E10", E11: "E11", E12: "E11", E13: "E13", E14: "C1",
  E17: "E17", E18: "E17", E19: "E19", E21: "E21", E22: "C2",
  E24: "E24", E30: "E30", E32: "E32", MC2: "N5", MC3: "N1",
  D1: "C1", D2: "N3", D3: "C1", D4: "N7", D5: "I7", D6: "S2", D7: "N4", D8: "N3",
  M1: "C4", M2: "E01", M3: "N7", M4: "N7", M5: "N4", M6: "E17",
  M7: "E30", M8: "I10", M9: "N1", M12: "I10",
};
