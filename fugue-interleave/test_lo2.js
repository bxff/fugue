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

// ==========================================
// POINT 2: Prove the two structures diverge
// ==========================================
// Setup: "a b" exists. Same user either:
//   Order 1: insert c between a and b, then delete b
//   Order 2: delete b, then insert c after a
// Then a SECOND peer inserts multiple chars. Show divergence.

console.log("=== Proving structural divergence (Point 2) ===\n");

const base = new Doc("0");
base.insert(0, 'a'); const a_up = base.pop();
base.insert(1, 'b'); const b_up = base.pop();

// Order 1: insert c, then delete b
const d1 = new Doc("1");
d1.apply(a_up); d1.apply(b_up);
d1.insert(1, 'c');  // c between a and b → c is LEFT child of b
const c1 = d1.pop();
d1.del(2);          // delete b
const bdel1 = d1.pop();

// Order 2: delete b, then insert c
const d2 = new Doc("1");
d2.apply(a_up); d2.apply(b_up);
d2.del(1);          // delete b first
const bdel2 = d2.pop();
d2.insert(1, 'c');  // c after a → c should be RIGHT child of a (but is LEFT child of b̶)
const c2 = d2.pop();

// Now add MORE concurrent operations: peer "3" types a run "xyz" after a
// This peer only saw "a" (never saw b)
const p3 = new Doc("3");
p3.apply(a_up);
p3.insert(1, 'x'); const x_up = p3.pop();
p3.insert(2, 'y'); const y_up = p3.pop();
p3.insert(3, 'z'); const z_up = p3.pop();

// And peer "4" inserts 'w' after a (only sees a)
const p4 = new Doc("4");
p4.apply(a_up);
p4.insert(1, 'w'); const w_up = p4.pop();

console.log("Order 1 (insert c then del b) + concurrent xyz, w:");
for (const [label, order] of [
  ["merge-A", [a_up, b_up, c1, bdel1, x_up, y_up, z_up, w_up]],
  ["merge-B", [a_up, x_up, y_up, z_up, w_up, b_up, c1, bdel1]],
  ["merge-C", [a_up, b_up, bdel1, x_up, c1, y_up, z_up, w_up]],
]) {
  const f = new Doc("f");
  order.forEach(u => f.apply(u));
  console.log("  " + label + ": " + f.val);
}

console.log("\nOrder 2 (del b then insert c) + concurrent xyz, w:");
for (const [label, order] of [
  ["merge-A", [a_up, b_up, c2, bdel2, x_up, y_up, z_up, w_up]],
  ["merge-B", [a_up, x_up, y_up, z_up, w_up, b_up, c2, bdel2]],
  ["merge-C", [a_up, b_up, bdel2, x_up, c2, y_up, z_up, w_up]],
]) {
  const f = new Doc("f");
  order.forEach(u => f.apply(u));
  console.log("  " + label + ": " + f.val);
}

// ==========================================
// POINT 3: bdac problem - more extreme
// ==========================================
console.log("\n=== bdac problem - longer runs ===\n");

// b, a, c concurrent. Then peer types "de" between b and c (run of 2)
const db = new Doc("0"); db.insert(0, 'b'); const bu = db.pop();
const da = new Doc("1"); da.insert(0, 'a'); const au = da.pop();
const dc = new Doc("2"); dc.insert(0, 'c'); const cu = dc.pop();

// Peer types "de" between b and c (sees only b,c)
const dd = new Doc("3");
dd.apply(bu); dd.apply(cu);
console.log("Peer sees:", dd.val);
dd.insert(1, 'd'); const du = dd.pop();
dd.insert(2, 'e'); const eu = dd.pop();
console.log("After typing de:", dd.val);

const f = new Doc("final");
[bu, au, cu, du, eu].forEach(u => f.apply(u));
console.log("Final:", f.val, "← 'de' run is broken by 'a'? 'de' should be between b and c");

// What if there's also a run from another peer?
// Peer "4" types "fg" between b and c (also sees only b,c)
const df = new Doc("4");
df.apply(bu); df.apply(cu);
df.insert(1, 'f'); const fu_up = df.pop();
df.insert(2, 'g'); const gu = df.pop();

const f2 = new Doc("final2");
[bu, au, cu, du, eu, fu_up, gu].forEach(u => f2.apply(u));
console.log("With two runs:", f2.val, "← are runs de and fg non-interleaved?");
