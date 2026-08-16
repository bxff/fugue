import { CRuntime } from "@collabs/collabs";
import { FugueMaxSimple } from "fugue-max-simple";

class Doc {
  constructor(id) {
    this.doc = new CRuntime({ debugReplicaID: id });
    this.ups = [];
    this.doc.on("Send", (e) => {
      const u = new Uint8Array(e.message.length + 1);
      u.set(e.message);
      u[e.message.length] = 0;
      this.ups.push(u);
    });
    this.arr = this.doc.registerCollab("array", (init) => new FugueMaxSimple(init));
  }
  insert(idx, val) { this.doc.transact(() => this.arr.insert(idx, val)); }
  del(idx) { this.doc.transact(() => this.arr.delete(idx, 1)); }
  apply(u) { this.doc.receive(u.subarray(0, u.length - 1)); }
  pop() { return this.ups.shift(); }
  get val() { return [...this.arr.values()].join(''); }
}

// Figure 2 scenario:
// Base author publishes "ab"; concurrently another peer deletes b.
// Two replicas, RA and RB, both see "a" and both want to insert "y" after a.
//   RA: has applied a, b, and bdel  (its view is "a")
//   RB: has applied only a          (its view is "a")
// After RB then applies b and bdel, both replicas must produce the SAME tree
// (Fugue's premise: same user intent → same tree).
console.log("=== Figure 2: same user intent, different tombstone visibility ===\n");

const base = new Doc("0");
base.insert(0, 'a'); const a_up = base.pop();
base.insert(1, 'b'); const b_up = base.pop();
base.del(1);         const bdel_up = base.pop();

// RA: sees a, b, bdel — visible doc is "a"
const RA = new Doc("A");
RA.apply(a_up); RA.apply(b_up); RA.apply(bdel_up);
console.log("RA sees:", JSON.stringify(RA.val), "(expected 'a')");
RA.insert(1, 'y'); const ya_up = RA.pop();
console.log("RA after insert y:", JSON.stringify(RA.val));

// RB: sees only a — visible doc is "a"
const RB = new Doc("B");
RB.apply(a_up);
console.log("RB sees:", JSON.stringify(RB.val), "(expected 'a')");
RB.insert(1, 'y'); const yb_up = RB.pop();
console.log("RB after insert y:", JSON.stringify(RB.val));

// Now sync both directions and check both replicas converge AND have same tree.
RB.apply(b_up); RB.apply(bdel_up); RB.apply(ya_up);
RA.apply(yb_up);

console.log("\nAfter full sync:");
console.log("  RA:", JSON.stringify(RA.val));
console.log("  RB:", JSON.stringify(RB.val));
console.log("  Convergent:", RA.val === RB.val);

// Independent witnesses: apply same updates in different orders and ensure
// all produce the same value (tree convergence under causal delivery).
console.log("\nIndependent witness orderings:");
const orders = [
  ["abYaYbBdel", [a_up, b_up, ya_up, yb_up, bdel_up]],
  ["abBdelYaYb", [a_up, b_up, bdel_up, ya_up, yb_up]],
  ["abYbBdelYa", [a_up, b_up, yb_up, bdel_up, ya_up]],
  ["aYbbBdelYa", [a_up, yb_up, b_up, bdel_up, ya_up]],
];
const results = [];
for (const [label, order] of orders) {
  const w = new Doc("W");
  order.forEach(u => w.apply(u));
  results.push(w.val);
  console.log("  " + label + ": " + JSON.stringify(w.val));
}
const allEqual = results.every(v => v === results[0]);
console.log("  All witnesses equal:", allEqual);

// Tree-identity check: after both replicas have everything, compare saves.
// FugueMaxSimple.save serializes tree structure (without replicaID-dependent
// noise), so equal saves => isomorphic trees.
function fullSync(a, b) {
  // drain any pending messages between two docs
  while (a.ups.length || b.ups.length) {
    while (a.ups.length) b.apply(a.pop());
    while (b.ups.length) a.apply(b.pop());
  }
}
fullSync(RA, RB);

// Compare contents via values()
console.log("\nFinal value check:");
console.log("  RA:", JSON.stringify(RA.val));
console.log("  RB:", JSON.stringify(RB.val));
console.log("  Convergent:", RA.val === RB.val);
