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

console.log("=== Test 1: insert c then delete b  vs  delete b then insert c ===\n");

const base = new Doc("0");
base.insert(0, 'a'); const a_up = base.pop();
base.insert(1, 'b'); const b_up = base.pop();

// Order 1: insert c between a and b, then delete b
const d1 = new Doc("1");
d1.apply(a_up); d1.apply(b_up);
d1.insert(1, 'c'); const c1 = d1.pop();
d1.del(2); const b1_del = d1.pop();
console.log("O1: ab -> acb -> ac");

// Order 2: delete b, then insert c
const d2 = new Doc("1");
d2.apply(a_up); d2.apply(b_up);
d2.del(1); const b2_del = d2.pop();
d2.insert(1, 'c'); const c2 = d2.pop();
console.log("O2: ab -> a -> ac");

// Concurrent y from peer "2" who only sees "a"
const yDoc = new Doc("2");
yDoc.apply(a_up);
yDoc.insert(1, 'y'); const y_up = yDoc.pop();

console.log("\nMerge results:");
for (const [label, c_up, b_del] of [["order1", c1, b1_del], ["order2", c2, b2_del]]) {
  for (const [mlabel, order] of [
    ["all+y   ", [a_up, b_up, c_up, b_del, y_up]],
    ["y-first ", [a_up, y_up, b_up, c_up, b_del]],
    ["y-mid   ", [a_up, b_up, b_del, y_up, c_up]],
  ]) {
    const f = new Doc("f");
    order.forEach(u => f.apply(u));
    console.log("  " + label + " " + mlabel + ": " + f.val);
  }
}

console.log("\n=== Test 2: bdac scenario ===\n");
const db = new Doc("0"); db.insert(0, 'b'); const bu = db.pop();
const da = new Doc("1"); da.insert(0, 'a'); const au = da.pop();
const dc = new Doc("2"); dc.insert(0, 'c'); const cu = dc.pop();

const dd = new Doc("3");
dd.apply(bu); dd.apply(cu);
console.log("Peer sees:", dd.val);
dd.insert(1, 'd'); const du = dd.pop();

const f = new Doc("final");
[bu, au, cu, du].forEach(u => f.apply(u));
console.log("Final:", f.val, "(should ideally be badc or bdac?)");

console.log("\n=== Test 3: LO-side phantom barrier ===");
console.log("Setup: sequential a->b->c. Delete b.");
console.log("Peer Q sees 'ac' (b deleted), inserts y between a and c");
console.log("Peer R sees 'abc' (b alive), inserts z between b and c\n");

const s = new Doc("0");
s.insert(0, 'a'); const s_a = s.pop();
s.insert(1, 'b'); const s_b = s.pop();
s.insert(2, 'c'); const s_c = s.pop();

// Peer Q: sees b deleted
const pq = new Doc("5");
pq.apply(s_a); pq.apply(s_b); pq.apply(s_c);
pq.del(1);
const pq_bdel = pq.pop();
pq.insert(1, 'y');
const pq_y = pq.pop();
console.log("Q: abc -> ac (del b) -> ayc");

// Peer R: sees b alive
const pr = new Doc("6");
pr.apply(s_a); pr.apply(s_b); pr.apply(s_c);
pr.insert(2, 'z');
const pr_z = pr.pop();
console.log("R: abc -> abzc (insert z between b and c)");

console.log("\nMerge results:");
for (const [label, order] of [
  ["order1", [s_a, s_b, s_c, pq_bdel, pq_y, pr_z]],
  ["order2", [s_a, s_b, s_c, pr_z, pq_bdel, pq_y]],
  ["order3", [s_a, s_b, pr_z, s_c, pq_y, pq_bdel]],
  ["order4", [s_a, pr_z, s_b, s_c, pq_bdel, pq_y]],
]) {
  const f = new Doc("f");
  order.forEach(u => f.apply(u));
  console.log("  " + label + ": " + f.val);
}

// Now the key question: if BOTH peers wanted to insert at the same logical
// position (between a and c, where b is/was), do they get different tree parents?
console.log("\n=== Test 4: Same intent, different visibility ===");
console.log("Both peers want to insert right after 'a', before 'c'");
console.log("Peer Q sees 'ac' (b deleted), Peer R sees 'abc'\n");

// Peer Q2: sees b deleted, inserts y at index 1 (after a)
const pq2 = new Doc("5");
pq2.apply(s_a); pq2.apply(s_b); pq2.apply(s_c);
pq2.del(1);
const pq2_bdel = pq2.pop();
pq2.insert(1, 'y');
const pq2_y = pq2.pop();

// Peer R2: sees b alive, inserts z at index 1 (between a and b)
const pr2 = new Doc("6");
pr2.apply(s_a); pr2.apply(s_b); pr2.apply(s_c);
pr2.insert(1, 'z');
const pr2_z = pr2.pop();

console.log("Merge results (y=Q sees ac, z=R sees abc, z between a and b):");
for (const [label, order] of [
  ["order1", [s_a, s_b, s_c, pq2_bdel, pq2_y, pr2_z]],
  ["order2", [s_a, s_b, s_c, pr2_z, pq2_bdel, pq2_y]],
  ["order3", [s_a, pr2_z, s_b, s_c, pq2_bdel, pq2_y]],
]) {
  const f = new Doc("f");
  order.forEach(u => f.apply(u));
  console.log("  " + label + ": " + f.val);
}
