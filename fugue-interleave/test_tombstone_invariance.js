// Semantic regression suite for FugueMax tombstones.
//
// This file intentionally does NOT ask only whether one op-set converges.
// The published FugueMax already converges.  The main tests instead replay
// two histories that differ only by invisible insert/delete history, then
// compare their visible orders.  A failure means that the implementation
// has introduced an extra user-visible variant.
//
// Run against the working implementation:
//   node test_tombstone_invariance.js
//
// Run as a diagnostic without a non-zero exit status:
//   node test_tombstone_invariance.js --report-only
//
// Run against another FugueMaxSimple build:
//   node test_tombstone_invariance.js --module fugue-max-canonical

import { pathToFileURL } from "node:url";
import { CRuntime } from "@collabs/collabs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const reportOnly = args.includes("--report-only");
const explainOnly = args.includes("--explain");
const jsonOutput = args.includes("--json");
const moduleArg = option("--module", "fugue-max-simple");
const exportName = option("--export", "FugueMaxSimple");
const moduleSpecifier = moduleArg.startsWith("/")
  ? pathToFileURL(moduleArg).href
  : moduleArg;
const implementationModule = await import(moduleSpecifier);
const ListClass = implementationModule[exportName];
if (ListClass === undefined) {
  throw new Error(`Module ${moduleArg} has no export named ${exportName}`);
}

const decoder = new TextDecoder();
let mergeCounter = 0;

function extractPrimitive(message) {
  // Collabs wraps the primitive in a binary transaction envelope.  The JSON
  // object is still embedded verbatim, so extract it for origin diagnostics.
  const text = decoder.decode(message);
  for (const marker of ['{"type":"insert"', '{"type":"delete"']) {
    const start = text.indexOf(marker);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

class Doc {
  constructor(id) {
    this.runtime = new CRuntime({ debugReplicaID: id });
    this.updates = [];
    this.primitives = [];
    this.runtime.on("Send", (event) => {
      const update = new Uint8Array(event.message.length + 1);
      update.set(event.message);
      update[event.message.length] = 0;
      this.updates.push(update);
      this.primitives.push(extractPrimitive(event.message));
    });
    this.list = this.runtime.registerCollab(
      "array",
      (init) => new ListClass(init)
    );
  }

  insert(index, value) {
    this.runtime.transact(() => this.list.insert(index, value));
  }

  delete(index) {
    this.runtime.transact(() => this.list.delete(index, 1));
  }

  splice(index, deleteCount, value) {
    this.runtime.transact(() => this.list.splice(index, deleteCount, value));
  }

  apply(update) {
    this.runtime.receive(update.subarray(0, update.length - 1));
  }

  applyAll(updates) {
    for (const update of updates) this.apply(update);
  }

  take() {
    const update = this.updates.shift();
    if (update === undefined) throw new Error("Expected a generated update");
    return update;
  }

  // Compatibility probe for the rejected publication-sensitive prototype.
  simulateTransportHandoff() {
    this.list.markLocalUpdatesSent?.();
  }

  get value() {
    return [...this.list.values()].join("");
  }
}

function merge(updates) {
  const doc = new Doc(`zz-merge-${mergeCounter++}`);
  doc.applyAll(updates);
  return doc.value;
}

function shape(op) {
  if (op === null || op === undefined) return "unknown";
  const id = (value) => {
    if (value === null || value === undefined) return "end";
    if (value.sender === "") return "root";
    return `${value.sender}:${value.counter}`;
  };
  if (op.type === "delete") return `delete(${id(op.id)})`;
  // Fugue's payload does not store LO directly.  For a right child, parent
  // is the LO.  For a left child, parent is the RO; the logical LO is the
  // visible predecessor used by the generator and is only encoded by shape.
  return op.side === "L"
    ? `side=L, parent/RO=${id(op.parent)} (LO implicit)`
    : `side=R, parent/LO=${id(op.parent)}, RO=${id(op.rightOrigin)}`;
}

function equalResult(left, right, details = []) {
  return {
    pass: left === right,
    expected: "paired histories have identical visible order",
    actual: `${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
    details,
    observations: [
      { label: "History A", value: left },
      { label: "History B", value: right },
    ],
  };
}

function exactResult(actual, expected, details = []) {
  return {
    pass: actual === expected,
    expected: JSON.stringify(expected),
    actual: JSON.stringify(actual),
    details,
    observations: [{ label: "Merged result", value: actual }],
  };
}

function predicateResult(pass, expected, actual, details = [], observations = []) {
  return { pass, expected, actual, details, observations };
}

const cases = [
  {
    id: "N1",
    name: "unseen insert-delete pair at document start is neutral",
    property: "ghost-history neutrality",
    catches: "The smallest remote-ghost counterexample; no pre-existing text is needed.",
    diagram: [
      "without ghost:  R:(root,end), S:(root,end)",
      "with ghost:     g:(root,end), g†; R is placed at index 0 after seeing only g†; S is concurrent",
      "required:       removing invisible g† cannot reverse R and S",
    ],
    run() {
      const noGhost = () => {
        const r = new Doc("0"); r.insert(0, "R"); const R = r.take();
        const s = new Doc("1"); s.insert(0, "S"); const S = s.take();
        return { value: merge([R, S]), rOp: r.primitives.at(-1) };
      };
      const withGhost = () => {
        const g = new Doc("2");
        g.insert(0, "g"); const G = g.take();
        g.delete(0); const Gdel = g.take();
        const r = new Doc("0");
        r.applyAll([G, Gdel]);
        r.insert(0, "R"); const R = r.take();
        const s = new Doc("1"); s.insert(0, "S"); const S = s.take();
        return { value: merge([G, Gdel, R, S]), rOp: r.primitives.at(-1) };
      };
      const a = noGhost();
      const b = withGhost();
      return equalResult(a.value, b.value, [
        `R without ghost: ${shape(a.rOp)}`,
        `R after receiving g+delete back-to-back: ${shape(b.rOp)}`,
      ]);
    },
  },
  {
    id: "N2",
    name: "minimal interior RO phantom barrier is neutral",
    property: "ghost-history neutrality",
    catches: "The smallest reverse-RO witness: an invisible B changes Y from RO=end to RO=B and flips Y/X.",
    diagram: [
      "base: A, B, C concurrent in ID order; B is deleted",
      "X: LO=A, RO=C",
      "Y0: sees only A             -> LO=A, RO=end",
      "Y1: sees A plus delivered B† -> LO=A, RO=B†",
      "required: merge(A,C,X,Y0) == merge(A,B†,C,X,Y1)",
    ],
    run() {
      const world = (includeGhost) => {
        const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
        const b = new Doc("1"); b.insert(0, "B"); const B = b.take();
        b.delete(0); const Bdel = b.take();
        const c = new Doc("2"); c.insert(0, "C"); const C = c.take();
        const x = new Doc("4"); x.applyAll([A, C]); x.insert(1, "X"); const X = x.take();
        const y = new Doc("5"); y.apply(A);
        if (includeGhost) y.applyAll([B, Bdel]);
        y.insert(1, "Y"); const Y = y.take();
        const updates = includeGhost
          ? [A, B, C, Bdel, X, Y]
          : [A, C, X, Y];
        return { value: merge(updates), yOp: y.primitives.at(-1) };
      };
      const absent = world(false);
      const deliveredDead = world(true);
      return equalResult(absent.value, deliveredDead.value, [
        `Y without B: ${shape(absent.yOp)}`,
        `Y after B+delete: ${shape(deliveredDead.yOp)}`,
      ]);
    },
  },
  {
    id: "N3",
    name: "original ABCD phantom-barrier figure is neutral",
    property: "ghost-history neutrality",
    catches: "The original AYZXCD/AZXYCD report, with two distinct right-origin witnesses.",
    diagram: [
      "A,B,C,D concurrent; B† is invisible",
      "X:(LO=A,RO=C), Z:(LO=A,RO=D)",
      "Y0 sees A only: RO=end; Y1 sees A+B†: RO=B†",
      "required: B† must not move Y across the Z/X clumps",
    ],
    run() {
      const world = (includeGhost) => {
        const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
        const b = new Doc("1"); b.insert(0, "B"); const B = b.take();
        b.delete(0); const Bdel = b.take();
        const c = new Doc("2"); c.insert(0, "C"); const C = c.take();
        const d = new Doc("3"); d.insert(0, "D"); const D = d.take();
        const x = new Doc("4"); x.applyAll([A, C]); x.insert(1, "X"); const X = x.take();
        const z = new Doc("5"); z.applyAll([A, D]); z.insert(1, "Z"); const Z = z.take();
        const y = new Doc("6"); y.apply(A);
        if (includeGhost) y.applyAll([B, Bdel]);
        y.insert(1, "Y"); const Y = y.take();
        const updates = includeGhost
          ? [A, B, C, D, Bdel, X, Z, Y]
          : [A, C, D, X, Z, Y];
        return { value: merge(updates), yOp: y.primitives.at(-1) };
      };
      const absent = world(false);
      const deliveredDead = world(true);
      return equalResult(absent.value, deliveredDead.value, [
        `Y without B: ${shape(absent.yOp)}`,
        `Y after B+delete: ${shape(deliveredDead.yOp)}`,
      ]);
    },
  },
  {
    id: "N4",
    name: "tombstone must not change the left-child/right-child route",
    property: "ghost-history neutrality (LO-side)",
    catches: "A next-live-RO-only patch cannot pass: Fugue's left-child branch never consults RO.",
    diagram: [
      "A and C are concurrent root siblings",
      "ghost B was inserted after A, then deleted: A -> B†",
      "X sees AC and inserts in (A,C): right child of A, RO=C",
      "Y sees the same visible AC, with or without B†",
      "published routing: without B, Y is (A,R,RO=C); with B†, Y is (B†,L)",
    ],
    run() {
      const world = (includeGhost) => {
        const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
        const c = new Doc("2"); c.insert(0, "C"); const C = c.take();
        const b = new Doc("1"); b.apply(A); b.insert(1, "B"); const B = b.take();
        b.delete(1); const Bdel = b.take();
        const x = new Doc("3"); x.applyAll([A, C]); x.insert(1, "X"); const X = x.take();
        const y = new Doc("9"); y.applyAll([A, C]);
        if (includeGhost) y.applyAll([B, Bdel]);
        y.insert(1, "Y"); const Y = y.take();
        const updates = includeGhost
          ? [A, B, C, Bdel, X, Y]
          : [A, C, X, Y];
        return { value: merge(updates), yOp: y.primitives.at(-1) };
      };
      const absent = world(false);
      const deliveredDead = world(true);
      return equalResult(absent.value, deliveredDead.value, [
        `Y without B: ${shape(absent.yOp)}`,
        `Y after B+delete: ${shape(deliveredDead.yOp)}`,
      ]);
    },
  },
  {
    id: "N5",
    name: "a chain of unseen tombstones is neutral",
    property: "ghost-history neutrality (chain)",
    catches: "Single-hop fixes and replacement chains that stop at the wrong dead node.",
    diagram: [
      "A,B,C,D,E concurrent; B and C are delivered already dead",
      "X sees AD and inserts in (A,D), RO=D; Z sees AE and gets RO=E",
      "Y performs the same visible insertion in ADE, with or without B†,C† metadata",
      "required: the length of the invisible dead chain cannot create a new order",
    ],
    run() {
      const world = (includeGhosts) => {
        const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
        const b = new Doc("1"); b.insert(0, "B"); const B = b.take(); b.delete(0); const Bdel = b.take();
        const c = new Doc("2"); c.insert(0, "C"); const C = c.take(); c.delete(0); const Cdel = c.take();
        const d = new Doc("3"); d.insert(0, "D"); const D = d.take();
        const e = new Doc("4"); e.insert(0, "E"); const E = e.take();
        const x = new Doc("5"); x.applyAll([A, D]); x.insert(1, "X"); const X = x.take();
        const z = new Doc("6"); z.applyAll([A, E]); z.insert(1, "Z"); const Z = z.take();
        const y = new Doc("4-y"); y.applyAll([A, D, E]);
        if (includeGhosts) y.applyAll([B, C, Bdel, Cdel]);
        y.insert(1, "Y"); const Y = y.take();
        const updates = includeGhosts
          ? [A, B, C, D, E, Bdel, Cdel, X, Z, Y]
          : [A, D, E, X, Z, Y];
        return { value: merge(updates), yOp: y.primitives.at(-1) };
      };
      const absent = world(false);
      const deliveredDead = world(true);
      return equalResult(absent.value, deliveredDead.value, [
        `Y without chain: ${shape(absent.yOp)}`,
        `Y after B†,C†: ${shape(deliveredDead.yOp)}`,
      ]);
    },
  },
  {
    id: "N7",
    name: "a declared replacement keeps the pre-edit gap",
    property: "splice lowering equivalence",
    catches: "A next-live-only replacement lowering that moves C from B's reverse-RO bucket to the successor bucket.",
    diagram: [
      "shared AYB, with Y inserted in (A,B)",
      "reference lowering: insert C in (Y,B), then delete B",
      "declared splice: capture the live (Y,B) gap, insert C there, then tombstone B",
      "concurrent M was inserted in (Y,B) while B was alive",
      "required: for each fixed C/M sender assignment, both lowerings have the same result; transport handoff is irrelevant",
    ],
    run() {
      const world = (useSplice, cSender, mSender) => {
        const base = new Doc("0");
        base.insert(0, "A"); const A = base.take();
        base.insert(1, "B"); const B = base.take();
        const y = new Doc("7"); y.applyAll([A, B]); y.insert(1, "Y"); const Y = y.take();
        const c = new Doc(cSender); c.applyAll([A, B, Y]);
        let replacement;
        if (useSplice) {
          c.splice(2, 1, "C"); replacement = c.take();
        } else {
          c.insert(2, "C"); const C = c.take();
          c.delete(3); const Bdel = c.take();
          replacement = [C, Bdel];
        }
        const m = new Doc(mSender); m.applyAll([A, B, Y]); m.insert(2, "M"); const M = m.take();
        return {
          value: merge([A, B, Y, ...[replacement].flat(), M]),
          cOp: c.primitives.find((op) => op?.type === "insert"),
        };
      };
      const assignments = [
        { label: "C=9, M=3", cSender: "9", mSender: "3" },
        { label: "C=3, M=9", cSender: "3", mSender: "9" },
      ].map(({ label, cSender, mSender }) => ({
        label,
        reference: world(false, cSender, mSender),
        splice: world(true, cSender, mSender),
      }));
      const pass = assignments.every(({ reference, splice }) =>
        reference.value === splice.value
      );
      return predicateResult(
        pass,
        "a declared splice equals the canonical insert-before-delete lowering under each fixed sender assignment",
        assignments.map(({ label, reference, splice }) =>
          `${label}: reference ${JSON.stringify(reference.value)}, splice ${JSON.stringify(splice.value)}`
        ).join("; "),
        assignments.flatMap(({ label, reference, splice }) => [
          `${label} reference C: ${shape(reference.cOp)}`,
          `${label} splice C: ${shape(splice.cOp)}`,
        ]),
        assignments.flatMap(({ label, reference, splice }) => [
          { label: `${label} · insert then delete`, value: reference.value, pass: true },
          { label: `${label} · declared splice`, value: splice.value, pass: reference.value === splice.value },
        ])
      );
    },
  },
  {
    id: "S1",
    name: "deleting an RO cannot reorder surviving siblings",
    property: "delete stability / no jump",
    catches: "Delete-time RO rewriting plus sibling re-sorting.",
    diagram: [
      "A,B,C concurrent",
      "X:(LO=A,RO=C), Y:(LO=A,RO=B); choose IDs so X<Y by reverse RO but Y<X if their ROs become equal",
      "delete B; required: post-delete order equals the old order with B merely removed",
    ],
    run() {
      const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
      const b = new Doc("1"); b.insert(0, "B"); const B = b.take();
      const c = new Doc("2"); c.insert(0, "C"); const C = c.take();
      const x = new Doc("9"); x.applyAll([A, C]); x.insert(1, "X"); const X = x.take();
      const y = new Doc("3"); y.applyAll([A, B]); y.insert(1, "Y"); const Y = y.take();
      const before = merge([A, B, C, X, Y]);
      const del = new Doc("8"); del.applyAll([A, B, C, X, Y]);
      del.delete(del.value.indexOf("B")); const Bdel = del.take();
      const after = merge([A, B, C, X, Y, Bdel]);
      return predicateResult(
        after === before.replace("B", ""),
        "post-delete order is the pre-delete order with only B removed",
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
        [`before delete: ${before}`, `after delete:  ${after}`],
        [
          { label: "Before deletion", value: before },
          { label: "After deleting B", value: after },
        ]
      );
    },
  },
  {
    id: "S2",
    name: "a deletion chain cannot cascade an old anchor to the end",
    property: "delete stability / no jump (chain)",
    catches: "Destructive B->C->D->end replacement chains that forget the insertion's original slot.",
    diagram: [
      "A,B,C,D concurrent, plus witnesses with RO=B, RO=C, and RO=D",
      "delete B, then C, then D",
      "required after each deletion: only the deleted character disappears; all survivors retain relative order",
    ],
    run() {
      const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
      const b = new Doc("1"); b.insert(0, "B"); const B = b.take();
      const c = new Doc("2"); c.insert(0, "C"); const C = c.take();
      const d = new Doc("3"); d.insert(0, "D"); const D = d.take();
      const wb = new Doc("7"); wb.applyAll([A, B]); wb.insert(1, "P"); const P = wb.take();
      const wc = new Doc("8"); wc.applyAll([A, C]); wc.insert(1, "Q"); const Q = wc.take();
      const wd = new Doc("9"); wd.applyAll([A, D]); wd.insert(1, "R"); const R = wd.take();
      const updates = [A, B, C, D, P, Q, R];
      let expected = merge(updates);
      const before = expected;
      const del = new Doc("6"); del.applyAll(updates);
      const deleteAndCheck = (character) => {
        const index = del.value.indexOf(character);
        del.delete(index);
        const update = del.take();
        updates.push(update);
        expected = expected.replace(character, "");
        return merge(updates) === expected;
      };
      const bOkay = deleteAndCheck("B");
      const cOkay = deleteAndCheck("C");
      const dOkay = deleteAndCheck("D");
      return predicateResult(
        bOkay && cOkay && dOkay,
        "each delete is a pure removal from the previous visible order",
        `final ${JSON.stringify(merge(updates))}, expected ${JSON.stringify(expected)}`,
        [],
        [
          { label: "Before deletion chain", value: before },
          { label: "After B,C,D deleted", value: merge(updates) },
        ]
      );
    },
  },
  {
    id: "C1",
    name: "reverse-RO clumping remains intact without deletions",
    property: "published FugueMax clumping",
    catches: "A fix that discards the reason FugueMax orders right siblings by reverse RO.",
    diagram: [
      "A,B,C concurrent in that order",
      "X sees AC and inserts in (A,C): LO=A,RO=C",
      "Y sees AB and inserts in (A,B): LO=A,RO=B",
      "reverse RO requires A X Y B C (not A Y X B C)",
    ],
    run() {
      const a = new Doc("0"); a.insert(0, "A"); const A = a.take();
      const b = new Doc("1"); b.insert(0, "B"); const B = b.take();
      const c = new Doc("2"); c.insert(0, "C"); const C = c.take();
      const x = new Doc("3"); x.applyAll([A, C]); x.insert(1, "X"); const X = x.take();
      const y = new Doc("4"); y.applyAll([A, B]); y.insert(1, "Y"); const Y = y.take();
      return exactResult(merge([A, B, C, X, Y]), "AXYBC", [
        `X: ${shape(x.primitives.at(-1))}`,
        `Y: ${shape(y.primitives.at(-1))}`,
      ]);
    },
  },
  {
    id: "C2",
    name: "forward continuation remains adjacent across a backspace",
    property: "forward non-interleaving",
    catches: "Era-first placement that inserts concurrent Y between the author's P->Q continuation.",
    diagram: [
      "shared AB",
      "author: insert P in (A,B), delete B, then type Q after P (LO(Q)=P)",
      "concurrent Y was inserted in (A,B)",
      "required: Y may be before or after PQ, but may not split P,Q",
    ],
    run() {
      const run = (ySender) => {
        const base = new Doc("4"); base.insert(0, "A"); const A = base.take(); base.insert(1, "B"); const B = base.take();
        const pq = new Doc("1"); pq.applyAll([A, B]);
        pq.insert(1, "P"); const P = pq.take();
        pq.delete(2); const Bdel = pq.take();
        pq.insert(2, "Q"); const Q = pq.take();
        const y = new Doc(ySender); y.applyAll([A, B]); y.insert(1, "Y"); const Y = y.take();
        return merge([A, B, P, Bdel, Q, Y]);
      };
      const high = run("9");
      const low = run("0");
      return predicateResult(
        high.includes("PQ") && low.includes("PQ"),
        "PQ is contiguous for both sender-ID assignments",
        `Y=9 -> ${JSON.stringify(high)}, Y=0 -> ${JSON.stringify(low)}`,
        [],
        [
          { label: "Y sender = 9", value: high, pass: high.includes("PQ") },
          { label: "Y sender = 0", value: low, pass: low.includes("PQ") },
        ]
      );
    },
  },
  {
    id: "C3",
    name: "a tombstone with a live continuation remains a meaningful clumping boundary",
    property: "do not erase referenced history",
    catches: "Physical/reference erasure, non-convergence, and survivor reordering when a dependent operation arrives after its origin was deleted.",
    diagram: [
      "shared AB; Z is typed after B while B is alive, so LO(Z)=B",
      "another peer deletes B and, without seeing Z, inserts Y after A",
      "run with Y IDs on both sides of B's ID and with irrelevant transport handoffs inserted",
      "required: Z remains valid and Y insertion is a pure addition; AYZ and AZY are both permitted",
    ],
    run() {
      const run = (ySender, withTransportStutter) => {
        const base = new Doc("4"); base.insert(0, "A"); const A = base.take(); base.insert(1, "B"); const B = base.take();
        base.simulateTransportHandoff();
        const z = new Doc("9"); z.applyAll([A, B]); z.insert(2, "Z"); const Z = z.take();
        const y = new Doc(ySender); y.applyAll([A, B]); y.delete(1); const Bdel = y.take();
        if (withTransportStutter) y.simulateTransportHandoff();
        y.insert(1, "Y"); const Y = y.take();
        const beforeY = merge([A, B, Z, Bdel]);
        const value = merge([A, B, Z, Bdel, Y]);
        return {
          value,
          beforeY,
          stable: value.replace("Y", "") === beforeY,
          yShape: shape(y.primitives.findLast((op) => op?.type === "insert")),
          zShape: shape(z.primitives.at(-1)),
        };
      };
      const histories = [
        { label: "no intervening handoff · Y sender 1", ...run("1", false) },
        { label: "no intervening handoff · Y sender 8", ...run("8", false) },
        { label: "transport handoff inserted · Y sender 1", ...run("1", true) },
        { label: "transport handoff inserted · Y sender 8", ...run("8", true) },
      ];
      return predicateResult(
        histories.every(({ value, stable }) =>
          stable && (value === "AYZ" || value === "AZY")
        ),
        "late Z remains reachable and inserting Y does not reorder existing A/Z; transport handoff changes nothing",
        histories.map(({ label, value }) => `${label}: ${value}`).join(", "),
        histories.flatMap(({ label, yShape, zShape }) => [
          `${label} · Z: ${zShape}`,
          `${label} · Y: ${yShape}`,
        ]),
        histories.map(({ label, value }) => ({
          label,
          value,
          pass: value === "AYZ" || value === "AZY",
        }))
      );
    },
  },
  {
    id: "D1",
    name: "late right-origin reference separates insertion from replacement",
    property: "explicit-intent boundary",
    catches: "The impossibility of making every raw delete-then-insert act like replacement while also preserving ghost neutrality, reverse-RO buckets, and insertion stability.",
    diagram: [
      "A and B are concurrent root siblings; X sees only A and inserts after it with RO=end",
      "another author either inserts R before live B then deletes B (declared replacement), or deletes B then performs an ordinary projected insertion",
      "M was inserted in (A,B) with RO=B but remains in flight until after R and X are visible",
      "required: neither late M delivery may reorder existing R/X; the two explicit intents deliberately use different buckets",
    ],
    run() {
      const a = new Doc("0-A"); a.insert(0, "A"); const A = a.take();
      const b = new Doc("9-B"); b.insert(0, "B"); const B = b.take();
      const x = new Doc("9-X"); x.apply(A); x.insert(1, "X"); const X = x.take();
      const m = new Doc("0-M"); m.applyAll([A, B]); m.insert(1, "M"); const M = m.take();

      const ordinary = new Doc("5-R"); ordinary.applyAll([A, B]);
      ordinary.delete(1); const ordinaryDelete = ordinary.take();
      ordinary.insert(1, "R"); const ordinaryR = ordinary.take();

      const replacement = new Doc("5-R"); replacement.applyAll([A, B]);
      replacement.insert(1, "R"); const replacementR = replacement.take();
      replacement.delete(2); const replacementDelete = replacement.take();

      const ordinaryPrefix = merge([A, B, X, ordinaryDelete, ordinaryR]);
      const ordinaryLate = merge([A, B, X, ordinaryDelete, ordinaryR, M]);
      const replacementPrefix = merge([A, B, X, replacementR, replacementDelete]);
      const replacementLate = merge([A, B, X, replacementR, replacementDelete, M]);
      const pass = ordinaryPrefix === "ARX" && ordinaryLate === "ARXM" &&
        replacementPrefix === "AXR" && replacementLate === "AXMR" &&
        ordinaryLate.replace("M", "") === ordinaryPrefix &&
        replacementLate.replace("M", "") === replacementPrefix;
      return predicateResult(
        pass,
        "ordinary insertion stays in the projected end bucket (ARX→ARXM), while declared replacement stays in B's captured bucket (AXR→AXMR); late M reorders neither prefix",
        `ordinary ${JSON.stringify(ordinaryPrefix)}→${JSON.stringify(ordinaryLate)}; replacement ${JSON.stringify(replacementPrefix)}→${JSON.stringify(replacementLate)}`,
        [
          `ordinary R: ${shape(ordinary.primitives.findLast((op) => op?.type === "insert"))}`,
          `replacement R: ${shape(replacement.primitives.find((op) => op?.type === "insert"))}`,
          `late M: ${shape(m.primitives.at(-1))}`,
          `X: ${shape(x.primitives.at(-1))}`,
        ],
        [
          { label: "ordinary · before late M", value: ordinaryPrefix, pass: ordinaryPrefix === "ARX" },
          { label: "ordinary · after late M", value: ordinaryLate, pass: ordinaryLate === "ARXM" },
          { label: "replacement · before late M", value: replacementPrefix, pass: replacementPrefix === "AXR" },
          { label: "replacement · after late M", value: replacementLate, pass: replacementLate === "AXMR" },
        ]
      );
    },
  },
];

// Curation is part of the test specification. Each remaining case contributes
// a distinct geometry, fix regression, or structural control. The complete
// 134-row research audit is preserved in git history at commit 1a4f60b.
const decisions = {
  N1: {
    decision: "retained",
    role: "core counterexample",
    rationale: "Smallest instance of the original requirement: adding and delivering an unseen insert-delete pair changes the order of two surviving inserts.",
  },
  N2: {
    decision: "retained",
    role: "core counterexample",
    rationale: "Minimal interior reverse-RO witness. It isolates the exact phantom boundary without the larger ABCD construction.",
  },
  N3: {
    decision: "retained",
    role: "reference reproduction",
    rationale: "Not minimal, but retained because it is the exact original AYZXCD/AZXYCD report and anchors every reduction to the motivating figure.",
  },
  N4: {
    decision: "retained",
    role: "core counterexample",
    rationale: "Distinct from the RO cases: the unseen tombstone switches FugueMax's right-child/left-child route, which an RO-only repair never touches.",
  },
  N5: {
    decision: "retained",
    role: "chain generalization",
    rationale: "The minimal multi-tombstone extension. It prevents a repair that neutralizes only one dead boundary or performs only one replacement hop.",
  },
  N7: {
    decision: "retained",
    role: "naive-fix regression",
    rationale: "This is the remembered concrete failure of RO=next-live: adjacent insert/delete order changes C from RO=B to RO=end and creates AYMC/AYCM.",
  },
  S1: {
    decision: "retained",
    role: "preservation control",
    rationale: "A delete must project an established visible order by removing one item, not re-sort surviving siblings. It rejects eager origin rewriting.",
  },
  S2: {
    decision: "retained",
    role: "chain preservation",
    rationale: "Extends delete stability through B-to-C-to-D-to-end replacement chains, the separate failure mode of the old chain-hopper repair.",
  },
  C1: {
    decision: "retained",
    role: "paper control",
    rationale: "The paper's Figure 7. It protects the reverse-right-origin clumping rule that a tombstone repair must not flatten into ID order.",
  },
  C2: {
    decision: "retained",
    role: "paper control",
    rationale: "Direct guard for forward non-interleaving: LO(Q)=P requires the P-Q continuation to remain contiguous for either sender ordering.",
  },
  C3: {
    decision: "retained",
    role: "referenced-history control",
    rationale: "B is meaningful because live Z has LO=B. B must remain a valid origin, late Z must remain reachable, and adding Y must not reorder existing survivors. No universal Y-before-Z rule is part of C3.",
  },
  D1: {
    decision: "retained",
    role: "design boundary",
    rationale: "This is the minimal late-RO proof that raw delete/insert cannot simultaneously mean ordinary insertion and replacement. It justifies explicit splice intent rather than a transport or timing heuristic.",
  },
};
for (const test of cases) Object.assign(test, decisions[test.id]);

// Diagram data lives beside the executable cases so the generated review
// pages have one source of truth.  "state" is the relevant tombstone-inclusive
// order for that panel (dagger = tombstone); origins describe each insertion
// op's logical interval, even when Fugue encodes it as a left-child relation.
const visuals = {
  N1: {
    question: "Can an insert that was created and deleted off-screen reverse two surviving concurrent inserts?",
    panels: [
      {
        title: "History A — ghost never existed",
        state: ["ROOT", "END"],
        origins: [
          { node: "R", lo: "ROOT", ro: "END", note: "author R inserts at document start" },
          { node: "S", lo: "ROOT", ro: "END", note: "concurrent author S inserts at document start" },
        ],
      },
      {
        title: "History B — ghost delivered already dead",
        state: ["ROOT", "g†", "END"],
        steps: ["remote inserts g", "remote deletes g", "R receives both before inserting"],
        origins: [
          { node: "R", lo: "ROOT", ro: "g†", note: "same visible insertion; canonical encoding is before g†" },
          { node: "S", lo: "ROOT", ro: "END", note: "same concurrent insert" },
        ],
      },
    ],
    required: "The invisible g† must not introduce a second R/S ordering variant.",
  },
  N2: {
    question: "Can one invisible interior tombstone change which clump Y joins?",
    panels: [
      {
        title: "History A — B never existed",
        state: ["A", "C"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "witness for the (A,C) interval" },
          { node: "Y", lo: "A", ro: "END", note: "Y saw only A" },
        ],
      },
      {
        title: "History B — B arrives as B†",
        state: ["A", "B†", "C"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "unchanged witness" },
          { node: "Y", lo: "A", ro: "B†", note: "same visible insertion, different metadata" },
        ],
      },
    ],
    required: "Removing B† from history must not flip X/Y in the visible result.",
  },
  N3: {
    question: "Does the original ABCD phantom barrier create AYZXCD versus AZXYCD?",
    panels: [
      {
        title: "History A — B never existed",
        state: ["A", "C", "D"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "nearer right-origin witness" },
          { node: "Z", lo: "A", ro: "D", note: "farther right-origin witness" },
          { node: "Y", lo: "A", ro: "END", note: "author saw only A" },
        ],
      },
      {
        title: "History B — B delivered then deleted",
        state: ["A", "B†", "C", "D"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "same X" },
          { node: "Z", lo: "A", ro: "D", note: "same Z" },
          { node: "Y", lo: "A", ro: "B†", note: "same visible intent after A" },
        ],
      },
    ],
    required: "B† must not move Y across the Z/X clumps; both histories need one visible order.",
  },
  N4: {
    question: "Can a tombstone switch the emitted op from a right child of A to a left child of B†?",
    panels: [
      {
        title: "History A — visible A C only",
        state: ["A", "C"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "concurrent witness" },
          { node: "Y", lo: "A", ro: "C", note: "encoded as right child of A" },
        ],
      },
      {
        title: "History B — A has dead right child B†",
        state: ["A", "B†", "C"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "same X" },
          { node: "Y", lo: "A", ro: "B†", note: "published route: left child of B†" },
        ],
      },
    ],
    required: "The dead child must not make the same visible insertion take a different structural route.",
  },
  N5: {
    question: "Does a multi-hop chain of invisible tombstones remain neutral?",
    panels: [
      {
        title: "History A — no dead chain",
        state: ["A", "D", "E"],
        origins: [
          { node: "X", lo: "A", ro: "D", note: "first live witness" },
          { node: "Z", lo: "A", ro: "E", note: "second live witness" },
          { node: "Y", lo: "A", ro: "D", note: "same visible insertion in ADE" },
        ],
      },
      {
        title: "History B — B† and C† are known",
        state: ["A", "B†", "C†", "D", "E"],
        origins: [
          { node: "X", lo: "A", ro: "D", note: "same X" },
          { node: "Z", lo: "A", ro: "E", note: "same Z" },
          { node: "Y", lo: "A", ro: "B†", note: "first tombstone in the hidden chain" },
        ],
      },
    ],
    required: "Neither the presence nor the length of a dead chain may add a visible order.",
  },
  N7: {
    question: "Does a declared replacement preserve the pre-edit gap instead of guessing from a later tombstone?",
    panels: [
      {
        title: "History A — insert C before deleting B",
        state: ["A", "Y", "B"],
        steps: ["insert C between Y and B", "delete B"],
        origins: [
          { node: "Y", lo: "A", ro: "B", note: "shared insertion" },
          { node: "C", lo: "Y", ro: "B†", note: "B was live when C was generated" },
          { node: "M", lo: "Y", ro: "B†", note: "concurrent witness" },
        ],
      },
      {
        title: "History B — one logical splice",
        state: ["A", "Y", "B"],
        steps: ["capture the live (Y,B) gap", "insert C", "delete captured B by ID"],
        origins: [
          { node: "Y", lo: "A", ro: "B†", note: "same shared insertion" },
          { node: "C", lo: "Y", ro: "B†", note: "splice captures B before deleting it" },
          { node: "M", lo: "Y", ro: "B†", note: "same concurrent witness" },
        ],
      },
    ],
    required: "For each fixed C/M sender assignment, splice and insert-before-delete lowerings agree. Transport timing is not an input.",
  },
  S1: {
    question: "May deleting a right origin reorder surviving siblings that were already visible?",
    panels: [
      {
        title: "Before deletion",
        state: ["A", "B", "C"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "sender chosen so X < Y after RO collapse" },
          { node: "Y", lo: "A", ro: "B", note: "reverse-RO puts X before Y initially" },
        ],
      },
      {
        title: "After deleting B",
        state: ["A", "B†", "C"],
        steps: ["B becomes invisible; no insertion occurs"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "must retain its slot" },
          { node: "Y", lo: "A", ro: "B†", note: "must not jump across X" },
        ],
      },
    ],
    required: "The post-delete output must equal the old output with only B removed.",
  },
  S2: {
    question: "Can repeated deletion rewrite an old anchor through B†→C†→D†→END and cause a jump?",
    panels: [
      {
        title: "Initial visible geometry",
        state: ["A", "B", "C", "D"],
        origins: [
          { node: "P", lo: "A", ro: "B", note: "B-anchored witness" },
          { node: "Q", lo: "A", ro: "C", note: "C-anchored witness" },
          { node: "R", lo: "A", ro: "D", note: "D-anchored witness" },
        ],
      },
      {
        title: "Deletion chain",
        state: ["A", "B†", "C†", "D†"],
        steps: ["delete B", "then delete C", "then delete D"],
        origins: [
          { node: "P", lo: "A", ro: "B†", note: "original slot must survive" },
          { node: "Q", lo: "A", ro: "C†", note: "original slot must survive" },
          { node: "R", lo: "A", ro: "D†", note: "original slot must survive" },
        ],
      },
    ],
    required: "At each step, deletion is pure removal; P/Q/R never reorder.",
  },
  C1: {
    question: "Does a fix preserve FugueMax's intended reverse-right-origin clumping when no deletion exists?",
    panels: [
      {
        title: "Concurrent base characters",
        state: ["A", "B", "C"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "larger/farther RO" },
          { node: "Y", lo: "A", ro: "B", note: "smaller/nearer RO" },
        ],
      },
      {
        title: "Required merged clumps",
        state: ["A", "X", "Y", "B", "C"],
        steps: ["sort same-LO right siblings by reverse RO"],
        origins: [
          { node: "X", lo: "A", ro: "C", note: "must precede Y" },
          { node: "Y", lo: "A", ro: "B", note: "stays nearer its B clump" },
        ],
      },
    ],
    required: "The exact result is AXYBC, not AYXBC.",
  },
  C2: {
    question: "May concurrent Y split an author's forward continuation P→Q after backspace?",
    panels: [
      {
        title: "Author lane",
        state: ["A", "P", "Q", "B†"],
        steps: ["insert P before B", "delete B", "type Q after P"],
        origins: [
          { node: "P", lo: "A", ro: "B†", note: "first character" },
          { node: "Q", lo: "P", ro: "B†", note: "direct causal continuation of P" },
        ],
      },
      {
        title: "Concurrent lane",
        state: ["A", "Y", "B"],
        origins: [
          { node: "Y", lo: "A", ro: "B", note: "concurrent with P, delete, and Q" },
        ],
        steps: ["run with Y sender both below and above the author's sender"],
      },
    ],
    required: "Both APQY and AYPQ are acceptable; APYQ is not, because LO(Q)=P.",
  },
  C3: {
    question: "When an in-flight live Z depends on B, does deleting B preserve Z and the order of existing survivors?",
    panels: [
      {
        title: "Continuation created while B is live",
        state: ["A", "B", "Z"],
        origins: [
          { node: "Z", lo: "B", ro: "END", note: "Z is a live continuation of B" },
        ],
      },
      {
        title: "Delete B, then ordinary insertion Y",
        state: ["A", "Y", "B†"],
        steps: ["delete B without seeing Z", "insert Y after visible A"],
        origins: [
          { node: "Y", lo: "A", ro: "END", note: "Y cannot know that Z is still in flight" },
        ],
      },
      {
        title: "Same edit with an irrelevant transport handoff",
        state: ["A", "Y", "B†"],
        steps: ["delete B without seeing Z", "transport handoff", "insert Y after visible A"],
        origins: [
          { node: "Y", lo: "A", ro: "END", note: "Y cannot know that Z is still in flight" },
        ],
      },
    ],
    required: "AYZ and AZY are both valid. Z must survive, existing A/Z order cannot move, and transport handoff cannot change Y's operation.",
  },
  D1: {
    question: "Why can bare delete-then-insert not safely mean both ordinary insertion and replacement?",
    panels: [
      {
        title: "Ordinary insertion into the visible projection",
        state: ["A", "B†", "X"],
        steps: ["X saw only A: RO=end", "delete B", "ordinary insert R: RO=end", "late M arrives with RO=B"],
        origins: [
          { node: "X", lo: "A", ro: "END", note: "already visible end-bucket sibling" },
          { node: "R", lo: "A", ro: "END", note: "ordinary insertion ignores unsupported B†" },
          { node: "M", lo: "A", ro: "B†", note: "in-flight reference created while B was live" },
        ],
      },
      {
        title: "Declared replacement using the captured gap",
        state: ["A", "B", "X"],
        steps: ["capture gap (A,B)", "insert R with RO=B", "delete B", "late M arrives with RO=B"],
        origins: [
          { node: "X", lo: "A", ro: "END", note: "end bucket stays before B bucket" },
          { node: "R", lo: "A", ro: "B†", note: "explicit replacement chooses B's old slot" },
          { node: "M", lo: "A", ro: "B†", note: "joins the same captured bucket" },
        ],
      },
    ],
    required: "Ordinary ARX→ARXM and replacement AXR→AXMR are separately stable. The caller must state which intent it means.",
  },
};

// Causal graph views mirror the slide notation used in the original report:
// shared/source state at the top, each peer's local state in the middle, and
// the executable merge result at the bottom.  `from` identifies which source
// elements supply that insert's LO/RO arrows.  These are review metadata for
// the exact histories executed above, not independent examples.
const causalGraphs = {
  N1: {
    worlds: [
      {
        title: "Ghost never existed",
        source: [],
        branches: [
          { actor: "R", view: ["R"], from: [], origin: "R: LO=root, RO=end" },
          { actor: "S", view: ["S"], from: [], origin: "S: LO=root, RO=end" },
        ],
      },
      {
        title: "g was inserted, deleted, then delivered",
        source: ["g†"],
        annotation: "R receives insert(g)+delete(g) back-to-back",
        branches: [
          { actor: "R", view: ["R", "g†"], from: ["g†"], origin: "R: LO=root, RO=g† (left child of g†)" },
          { actor: "S", view: ["S"], from: [], origin: "S: LO=root, RO=end" },
        ],
      },
    ],
  },
  N2: {
    worlds: [
      {
        title: "B never existed",
        source: ["A", "C"],
        branches: [
          { actor: "Y", view: ["A", "Y"], from: ["A"], origin: "Y: LO=A, RO=end" },
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
        ],
      },
      {
        title: "B arrives already deleted",
        source: ["A", "B†", "C"],
        annotation: "same visible insertion of Y after A",
        branches: [
          { actor: "Y", view: ["A", "Y", "B†"], from: ["A", "B†"], origin: "Y: LO=A, RO=B†" },
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
        ],
      },
    ],
  },
  N3: {
    worlds: [
      {
        title: "B never existed",
        source: ["A", "C", "D"],
        branches: [
          { actor: "Y", view: ["A", "Y"], from: ["A"], origin: "Y: LO=A, RO=end" },
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
          { actor: "Z", view: ["A", "Z", "D"], from: ["A", "D"], origin: "Z: LO=A, RO=D" },
        ],
      },
      {
        title: "B was inserted, deleted, then delivered",
        source: ["A", "B†", "C", "D"],
        annotation: "same user intent: insert Y after visible A",
        branches: [
          { actor: "Y", view: ["A", "Y", "B†"], from: ["A", "B†"], origin: "Y: LO=A, RO=B†" },
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
          { actor: "Z", view: ["A", "Z", "D"], from: ["A", "D"], origin: "Z: LO=A, RO=D" },
        ],
      },
    ],
  },
  N4: {
    worlds: [
      {
        title: "A has no dead right child",
        source: ["A", "C"],
        branches: [
          { actor: "Y", view: ["A", "Y", "C"], from: ["A", "C"], origin: "Y: right child of A; LO=A, RO=C" },
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
        ],
      },
      {
        title: "A has dead right child B†",
        source: ["A", "B†", "C"],
        branches: [
          { actor: "Y", view: ["A", "Y", "B†", "C"], from: ["A", "B†"], origin: "Y: left child of B†; logical LO=A, RO=B†" },
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
        ],
      },
    ],
  },
  N5: {
    worlds: [
      {
        title: "No hidden chain",
        source: ["A", "D", "E"],
        branches: [
          { actor: "Y", view: ["A", "Y", "D", "E"], from: ["A", "D"], origin: "Y: LO=A, RO=D" },
          { actor: "X", view: ["A", "X", "D"], from: ["A", "D"], origin: "X: LO=A, RO=D" },
          { actor: "Z", view: ["A", "Z", "E"], from: ["A", "E"], origin: "Z: LO=A, RO=E" },
        ],
      },
      {
        title: "B†,C† chain delivered",
        source: ["A", "B†", "C†", "D", "E"],
        branches: [
          { actor: "Y", view: ["A", "Y", "B†", "C†", "D", "E"], from: ["A", "B†"], origin: "Y: LO=A, RO=B†" },
          { actor: "X", view: ["A", "X", "D"], from: ["A", "D"], origin: "X: LO=A, RO=D" },
          { actor: "Z", view: ["A", "Z", "E"], from: ["A", "E"], origin: "Z: LO=A, RO=E" },
        ],
      },
    ],
  },
  N7: {
    worlds: [
      {
        title: "C=9, M=3 · canonical lowering",
        source: ["A", "Y", "B"],
        annotation: "insert C at the live gap, then delete B",
        branches: [
          { actor: "C", view: ["A", "Y", "C", "B†"], from: ["Y", "B"], origin: "C: LO=Y, RO=B" },
          { actor: "M", view: ["A", "Y", "M", "B"], from: ["Y", "B"], origin: "M: LO=Y, RO=B" },
        ],
      },
      {
        title: "C=9, M=3 · declared splice",
        source: ["A", "Y", "B"],
        annotation: "capture gap (Y,B), insert C there, then delete B by ID",
        branches: [
          { actor: "C", view: ["A", "Y", "C", "B†"], from: ["Y", "B"], origin: "C: LO=Y, RO=B from the captured gap" },
          { actor: "M", view: ["A", "Y", "M", "B"], from: ["Y", "B"], origin: "M: LO=Y, RO=B" },
        ],
      },
      {
        title: "C=3, M=9 · canonical lowering",
        source: ["A", "Y", "B"],
        annotation: "same commands, reversed relative sender order",
        branches: [
          { actor: "C", view: ["A", "Y", "C", "B†"], from: ["Y", "B"], origin: "C: LO=Y, RO=B" },
          { actor: "M", view: ["A", "Y", "M", "B"], from: ["Y", "B"], origin: "M: LO=Y, RO=B" },
        ],
      },
      {
        title: "C=3, M=9 · declared splice",
        source: ["A", "Y", "B"],
        annotation: "the captured gap is unchanged by sender ordering",
        branches: [
          { actor: "C", view: ["A", "Y", "C", "B†"], from: ["Y", "B"], origin: "C: LO=Y, RO=B from the captured gap" },
          { actor: "M", view: ["A", "Y", "M", "B"], from: ["Y", "B"], origin: "M: LO=Y, RO=B" },
        ],
      },
    ],
  },
  S1: {
    worlds: [
      {
        title: "Before deleting B",
        source: ["A", "B", "C"],
        branches: [
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
          { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B"], origin: "Y: LO=A, RO=B" },
        ],
      },
      {
        title: "After deleting B",
        source: ["A", "B†", "C"],
        annotation: "no new insertion; B merely becomes invisible",
        branches: [
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X retains LO=A, RO=C" },
          { actor: "Y", view: ["A", "Y", "B†"], from: ["A", "B†"], origin: "Y retains its B slot" },
        ],
      },
    ],
  },
  S2: {
    worlds: [
      {
        title: "Before the deletion chain",
        source: ["A", "B", "C", "D"],
        branches: [
          { actor: "P", view: ["A", "P", "B"], from: ["A", "B"], origin: "P: LO=A, RO=B" },
          { actor: "Q", view: ["A", "Q", "C"], from: ["A", "C"], origin: "Q: LO=A, RO=C" },
          { actor: "R", view: ["A", "R", "D"], from: ["A", "D"], origin: "R: LO=A, RO=D" },
        ],
      },
      {
        title: "After deleting B, then C, then D",
        source: ["A", "B†", "C†", "D†"],
        branches: [
          { actor: "P", view: ["A", "P", "B†"], from: ["A", "B†"], origin: "P keeps B's original slot" },
          { actor: "Q", view: ["A", "Q", "C†"], from: ["A", "C†"], origin: "Q keeps C's original slot" },
          { actor: "R", view: ["A", "R", "D†"], from: ["A", "D†"], origin: "R keeps D's original slot" },
        ],
      },
    ],
  },
  C1: {
    worlds: [
      {
        title: "No tombstones: preserve reverse-RO clumping",
        source: ["A", "B", "C"],
        branches: [
          { actor: "X", view: ["A", "X", "C"], from: ["A", "C"], origin: "X: LO=A, RO=C" },
          { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B"], origin: "Y: LO=A, RO=B" },
        ],
      },
    ],
  },
  C2: {
    worlds: [
      {
        title: "Concurrent Y has sender 9",
        source: ["A", "B"],
        branches: [
          { actor: "PQ", view: ["A", "P", "Q", "B†"], from: ["A", "B"], origin: "P: LO=A, RO=B; Q: LO=P, RO=B†" },
          { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B"], origin: "Y: LO=A, RO=B" },
        ],
      },
      {
        title: "Concurrent Y has sender 0",
        source: ["A", "B"],
        branches: [
          { actor: "PQ", view: ["A", "P", "Q", "B†"], from: ["A", "B"], origin: "P: LO=A, RO=B; Q: LO=P, RO=B†" },
          { actor: "Y", view: ["A", "Y", "B"], from: ["A", "B"], origin: "Y: LO=A, RO=B" },
        ],
      },
    ],
  },
  C3: {
    worlds: [
      {
        title: "No transport event between delete and insert",
        source: ["A", "B"],
        branches: [
          { actor: "Z", view: ["A", "B", "Z"], from: ["B"], origin: "Z: LO=B, RO=end" },
          { actor: "Y", view: ["A", "Y", "B†"], from: ["A"], origin: "delete B; ordinary Y: LO=A, RO=end" },
        ],
      },
      {
        title: "Irrelevant transport handoff inserted",
        source: ["A", "B"],
        branches: [
          { actor: "Z", view: ["A", "B", "Z"], from: ["B"], origin: "Z was authored while B was live and may still be in flight" },
          { actor: "Y", view: ["A", "Y", "B†"], from: ["A"], origin: "same Y: LO=A, RO=end; transport is not semantic input" },
        ],
      },
    ],
  },
  D1: {
    worlds: [
      {
        title: "Ordinary post-delete insertion",
        source: ["A", "B", "X"],
        annotation: "B is unsupported when R is generated; M is still in flight",
        branches: [
          { actor: "R", view: ["A", "R", "B†", "X"], from: ["A"], origin: "ordinary R: LO=A, RO=end" },
          { actor: "M", view: ["A", "M", "B"], from: ["A", "B"], origin: "late M: LO=A, RO=B" },
        ],
      },
      {
        title: "Declared replacement splice",
        source: ["A", "B", "X"],
        annotation: "R captures (A,B) while B is live; M is still in flight",
        branches: [
          { actor: "R", view: ["A", "R", "B†", "X"], from: ["A", "B"], origin: "replacement R: LO=A, RO=B" },
          { actor: "M", view: ["A", "M", "B"], from: ["A", "B"], origin: "late M: LO=A, RO=B" },
        ],
      },
    ],
  },
};

for (const test of cases) {
  test.visual = visuals[test.id];
  if (test.visual === undefined) {
    throw new Error(`Missing diagram metadata for ${test.id}`);
  }
  test.visual.graph = causalGraphs[test.id];
  if (test.visual.graph === undefined) {
    throw new Error(`Missing causal graph metadata for ${test.id}`);
  }
}

if (explainOnly && !jsonOutput) {
  for (const test of cases) {
    console.log(`${test.id} ${test.name}`);
    console.log(`  decision: ${test.decision} — ${test.rationale}`);
    console.log(`  property: ${test.property}`);
    console.log(`  catches:  ${test.catches}`);
    for (const line of test.diagram) console.log(`  ${line}`);
    console.log();
  }
  process.exit(0);
}

const selectedCases = cases;

if (!jsonOutput) {
  console.log(`Tombstone semantic invariance suite (${moduleArg})`);
  console.log("These assertions compare semantic variants, not just delivery-order convergence.\n");
}

let passed = 0;
let failed = 0;
const executions = [];
for (const test of selectedCases) {
  let result;
  try {
    result = test.run();
  } catch (error) {
    result = {
      pass: false,
      expected: "scenario executes",
      actual: error instanceof Error ? error.stack ?? error.message : String(error),
      details: [],
    };
  }
  executions.push({
    id: test.id,
    name: test.name,
    role: test.role,
    decision: test.decision,
    rationale: test.rationale,
    property: test.property,
    catches: test.catches,
    diagram: test.diagram,
    visual: test.visual,
    result,
  });
  if (result.pass) {
    passed++;
    if (!jsonOutput) console.log(`  PASS ${test.id} ${test.name}`);
  } else {
    failed++;
    if (!jsonOutput) {
      console.log(`  FAIL ${test.id} ${test.name}`);
      console.log(`       property: ${test.property}`);
      console.log(`       expected: ${result.expected}`);
      console.log(`       actual:   ${result.actual}`);
      for (const detail of result.details) console.log(`       ${detail}`);
    }
  }
}

if (jsonOutput) {
  console.log(JSON.stringify({
    implementation: moduleArg,
    exportName,
    summary: { passed, failed, total: cases.length },
    cases: executions,
  }, null, 2));
} else {
  console.log(`\n${passed} passed, ${failed} failed`);
}
if (!jsonOutput && !reportOnly && failed > 0) process.exit(1);
