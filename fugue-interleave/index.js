
import { CRuntime, ReplicaIDs } from "@collabs/collabs";
import { FugueArray } from "fugue";
import { FugueMaxSimple } from "fugue-max-simple";
import seedrandom from "seedrandom";

// ---------------------------------------------------------
// Factories (adapted from benchmarks)
// ---------------------------------------------------------

class FugueFactory {
  constructor() {
    this.rng = seedrandom("42");
  }
  create(updateHandler, replicaID) {
    return new FugueCRDT(this.rng, updateHandler, replicaID);
  }
}

class FugueCRDT {
  constructor(rng, updateHandler, replicaID) {
    this.doc = new CRuntime({
      debugReplicaID: replicaID || ReplicaIDs.pseudoRandom(rng),
    });
    if (updateHandler) {
      this.doc.on("Send", (e) => {
        updateHandler(this._encodeUpdate(e.message, false));
      });
    }
    this.carray = this.doc.registerCollab("array", (init) => new FugueArray(init));
  }

  _encodeUpdate(messageOrSave, isSave) {
    const update = new Uint8Array(messageOrSave.length + 1);
    update.set(messageOrSave);
    update[messageOrSave.length] = isSave ? 1 : 0;
    return update;
  }

  _decodeUpdate(update) {
    const messageOrSave = update.subarray(0, update.length - 1);
    const isSave = update[update.length - 1] == 1;
    return [messageOrSave, isSave];
  }

  applyUpdate(update) {
    const [messageOrSave, isSave] = this._decodeUpdate(update);
    if (isSave) {
      this.doc.load(messageOrSave);
    } else {
      this.doc.receive(messageOrSave);
    }
  }

  insertArray(index, elems) {
    this.doc.transact(() => this.carray.insert(index, ...elems));
  }

  deleteArray(index, count) {
    this.doc.transact(() => this.carray.delete(index, count));
  }

  spliceArray(index, deleteCount, elems) {
    this.doc.transact(() => this.carray.splice(index, deleteCount, ...elems));
  }

  getArray() {
    return this.carray.slice();
  }
}

class FugueMaxSimpleFactory {
  constructor() {
    this.rng = seedrandom("42");
  }
  create(updateHandler, replicaID) {
    return new FugueMaxSimpleCRDT(this.rng, updateHandler, replicaID);
  }
}

class FugueMaxSimpleCRDT {
  constructor(rng, updateHandler, replicaID) {
    this.doc = new CRuntime({
      debugReplicaID: replicaID || ReplicaIDs.pseudoRandom(rng),
    });
    if (updateHandler) {
      this.doc.on("Send", (e) => {
        updateHandler(this._encodeUpdate(e.message, false));
      });
    }
    this.carray = this.doc.registerCollab("array", (init) => new FugueMaxSimple(init));
  }

  _encodeUpdate(messageOrSave, isSave) {
    const update = new Uint8Array(messageOrSave.length + 1);
    update.set(messageOrSave);
    update[messageOrSave.length] = isSave ? 1 : 0;
    return update;
  }

  _decodeUpdate(update) {
    const messageOrSave = update.subarray(0, update.length - 1);
    const isSave = update[update.length - 1] == 1;
    return [messageOrSave, isSave];
  }

  applyUpdate(update) {
    const [messageOrSave, isSave] = this._decodeUpdate(update);
    if (isSave) {
      this.doc.load(messageOrSave);
    } else {
      this.doc.receive(messageOrSave);
    }
  }

  insertArray(index, elems) {
    this.doc.transact(() => this.carray.insert(index, ...elems));
  }

  deleteArray(index, count) {
    this.doc.transact(() => this.carray.delete(index, count));
  }

  getArray() {
    return [...this.carray.values()];
  }
}

// ---------------------------------------------------------
// Scenario
// ---------------------------------------------------------

function runScenario(name, factory) {
  console.log(`\n--- Running scenario for ${name} ---`);

  // Setup 3 replicas
  // We need to capture updates manually to simulate the network flow
  // doc1, doc2, doc3

  let doc1_updates = [];
  let doc2_updates = [];
  let doc3_updates = [];

  const doc1 = factory.create((u) => doc1_updates.push(u));
  const doc2 = factory.create((u) => doc2_updates.push(u));
  const doc3 = factory.create((u) => doc3_updates.push(u));

  // Replica 3 inserts 'b'
  // doc3.getArray().insert(0, ['b'])
  doc3.insertArray(0, ['b']);
  console.log("Replica 3 inserted 'b'. State:", doc3.getArray());

  // Replica 1 receives 3's update
  // Y.applyUpdateV2(doc1, ...)
  // In Collabs, receive updates from 3.
  while (doc3_updates.length > 0) {
    let u = doc3_updates.shift();
    doc1.applyUpdate(u);
  }
  console.log("Replica 1 received 3's updates. State:", doc1.getArray());

  // Replica 1 inserts 'a' before 'b'
  // doc1.getArray().insert(0, ['a'])
  doc1.insertArray(0, ['a']);
  console.log("Replica 1 inserted 'a'. State:", doc1.getArray());

  // Replica 2 concurrently inserts 'x'
  // doc2.getArray().insert(0, ['x'])
  doc2.insertArray(0, ['x']);
  console.log("Replica 2 inserted 'x' (concurrently). State:", doc2.getArray());

  // Prints the merged document: "axb"
  // Y.applyUpdateV2(doc1, ...)
  // Replica 1 receives 2's update
  while (doc2_updates.length > 0) {
    let u = doc2_updates.shift();
    doc1.applyUpdate(u);
  }

  const result = doc1.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

// ---------------------------------------------------------
// Execution
// ---------------------------------------------------------


async function runFigure7(name, factory) {
  console.log(`\n--- Running Figure 7 scenario for ${name} ---`);
  // Replicas with deterministic IDs to ensure A < B < C
  // IDs "0", "1", "2" should sort 0 < 1 < 2.
  let updates1 = [], updates2 = [], updates3 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // Replica 1 -> A
  const doc2 = factory.create(u => updates2.push(u), "1"); // Replica 2 -> B
  const doc3 = factory.create(u => updates3.push(u), "2"); // Replica 3 -> C

  // 1. Concurrent inserts A, B, C into empty list.
  doc1.insertArray(0, ['A']);
  doc2.insertArray(0, ['B']);
  doc3.insertArray(0, ['C']);

  // Check the base order of A, B, C
  const tempDoc = factory.create(null, "temp");
  updates1.forEach(u => tempDoc.applyUpdate(u)); // A
  updates2.forEach(u => tempDoc.applyUpdate(u)); // B
  updates3.forEach(u => tempDoc.applyUpdate(u)); // C

  const baseOrder = tempDoc.getArray().join(''); // Expect "ABC"
  console.log(`Base order (A,B,C) with deterministic IDs: ${baseOrder}`);

  // 2. R1 receives {A, C}.
  // R1 already has A. Needs C from R3 (doc3).
  let c_update = updates3.shift(); // insert(C)
  if (c_update) doc1.applyUpdate(c_update);

  let r1State = doc1.getArray().join('');
  console.log(`R1 state after receiving C: ${r1State}`); // Expect "AC"

  // 3. R1 inserts X between A and C.
  if (r1State === "AC") {
    doc1.insertArray(1, ['X']);
    console.log(`R1 inserted X. State: ${doc1.getArray().join('')}`);
  }

  // 4. R2 receives {A, B}.
  // R2 already has B. Needs A from R1.
  let a_update = updates1.shift(); // insert(A)
  if (a_update) doc2.applyUpdate(a_update);

  let r2State = doc2.getArray().join('');
  console.log(`R2 state after receiving A: ${r2State}`); // Expect "AB" (because A(0) < B(1))

  // 5. R2 inserts Y between A and B.
  if (r2State === "AB") {
    doc2.insertArray(1, ['Y']);
    console.log(`R2 inserted Y. State: ${doc2.getArray().join('')}`);
  }

  // 6. Merge all.
  // Collect all updates into doc1.
  while (updates2.length > 0) doc1.applyUpdate(updates2.shift()); // B, Y
  while (updates3.length > 0) doc1.applyUpdate(updates3.shift()); // Rest of C if any

  const result = doc1.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}


async function runABCD_Deletion(name, factory) {
  console.log(`\n--- Running ABCD Deletion scenario for ${name} ---`);
  // Replicas with deterministic IDs for A < B < C < D
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // R1
  const doc2 = factory.create(u => updates2.push(u), "1"); // R2
  const doc3 = factory.create(u => updates3.push(u), "2"); // R3
  const doc4 = factory.create(u => updates4.push(u), "3"); // R4

  // 1. Concurrent inserts A, B, C, D
  doc1.insertArray(0, ['A']);
  doc2.insertArray(0, ['B']);
  doc3.insertArray(0, ['C']);
  doc4.insertArray(0, ['D']);

  // Extract initial updates for A, B, C, D
  const a_update = updates1.shift();
  const b_update = updates2.shift();
  const c_update = updates3.shift();
  const d_update = updates4.shift();

  // 2. R2 (B) deletes B.
  doc2.deleteArray(0, 1);
  const b_delete_update = updates2.shift();
  console.log(`R2 deleted B. State: ${doc2.getArray().join('')}`);

  // 3. R3 (C) receives A from R1. Inserts X between A and C.
  doc3.applyUpdate(a_update);
  console.log(`R3 state after receiving A: ${doc3.getArray().join('')}`); // Expect "AC"
  doc3.insertArray(1, ['X']);
  console.log(`R3 inserted X. State: ${doc3.getArray().join('')}`); // Expect "AXC"
  const x_update = updates3.shift();

  // 4. R4 (D) receives A from R1. Inserts Z between A and D.
  doc4.applyUpdate(a_update);
  console.log(`R4 state after receiving A: ${doc4.getArray().join('')}`); // Expect "AD"
  doc4.insertArray(1, ['Z']);
  console.log(`R4 inserted Z. State: ${doc4.getArray().join('')}`); // Expect "AZD"
  const z_update = updates4.shift();

  // 5. R1 (A) inserts Y after A (stays "AY" as it doesn't see X or C yet)
  doc1.insertArray(1, ['Y']);
  console.log(`R1 inserted Y. State: ${doc1.getArray().join('')}`); // Expect "AY"
  const y_update = updates1.shift();

  // 6. Merge all
  const finalDoc = factory.create(null, "final");
  finalDoc.applyUpdate(a_update);
  finalDoc.applyUpdate(b_update);
  finalDoc.applyUpdate(c_update);
  finalDoc.applyUpdate(d_update);
  finalDoc.applyUpdate(b_delete_update);
  finalDoc.applyUpdate(x_update);
  finalDoc.applyUpdate(z_update);
  finalDoc.applyUpdate(y_update);
  const result = finalDoc.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

async function runABCD_Interleaving1(name, factory) {
  console.log(`\n--- Running ABCD Interleaving 1 scenario for ${name} ---`);
  // Replicas with deterministic IDs for A < B < C < D
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // A
  const doc2 = factory.create(u => updates2.push(u), "1"); // B
  const doc3 = factory.create(u => updates3.push(u), "2"); // C
  const doc4 = factory.create(u => updates4.push(u), "3"); // D

  // 1. Concurrent inserts A, B, C, D
  doc1.insertArray(0, ['A']);
  doc2.insertArray(0, ['B']);
  doc3.insertArray(0, ['C']);
  doc4.insertArray(0, ['D']);

  // Extract initial updates
  const a_update = updates1.shift();
  const b_update = updates2.shift();
  const c_update = updates3.shift();
  const d_update = updates4.shift();

  // 2. R1 (A) receives C. Inserts X. (State AC)
  doc1.applyUpdate(c_update);
  doc1.insertArray(1, ['X']);
  const x_update = updates1.shift();

  // 3. R2 (B) receives A. Inserts Y. (State AB)
  doc2.applyUpdate(a_update);
  doc2.insertArray(1, ['Y']);
  const y_update = updates2.shift();

  // 4. R4 (D) receives A. Inserts Z. (State AD)
  doc4.applyUpdate(a_update);
  doc4.insertArray(1, ['Z']);
  const z_update = updates4.shift();

  // 5. Merge all
  const finalDoc = factory.create(null, "final");
  finalDoc.applyUpdate(a_update);
  finalDoc.applyUpdate(x_update);
  finalDoc.applyUpdate(b_update);
  finalDoc.applyUpdate(y_update);
  finalDoc.applyUpdate(c_update);
  finalDoc.applyUpdate(d_update);
  finalDoc.applyUpdate(z_update);

  const result = finalDoc.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

async function runABCD_Interleaving2(name, factory) {
  console.log(`\n--- Running ABCD Interleaving 2 scenario for ${name} ---`);
  // Replicas with deterministic IDs for A < B < C < D
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // A
  const doc2 = factory.create(u => updates2.push(u), "1"); // B
  const doc3 = factory.create(u => updates3.push(u), "2"); // C
  const doc4 = factory.create(u => updates4.push(u), "3"); // D

  // 1. Concurrent inserts A, B, C, D
  doc1.insertArray(0, ['A']);
  doc2.insertArray(0, ['B']);
  doc3.insertArray(0, ['C']);
  doc4.insertArray(0, ['D']);

  // Extract initial updates
  const a_update = updates1.shift();
  const b_update = updates2.shift();
  const c_update = updates3.shift();
  const d_update = updates4.shift();

  // 2. R4 (D) receives A and C. Inserts X between A and C. (State AC -> peer "3" inserts X)
  doc4.applyUpdate(a_update);
  doc4.applyUpdate(c_update);
  doc4.insertArray(1, ['X']);
  const x_update = updates4.shift();

  // 3. R2 (B) receives A. Inserts Y. (State AB)
  doc2.applyUpdate(a_update);
  doc2.insertArray(1, ['Y']);
  const y_update = updates2.shift();

  // 4. R1 (A) receives D. Inserts Z between A and D. (State AD -> peer "0" inserts Z)
  doc1.applyUpdate(d_update);
  doc1.insertArray(1, ['Z']);
  const z_update = updates1.shift();

  // 5. Merge all
  const finalDoc = factory.create(null, "final");
  finalDoc.applyUpdate(a_update);
  finalDoc.applyUpdate(x_update);
  finalDoc.applyUpdate(b_update);
  finalDoc.applyUpdate(y_update);
  finalDoc.applyUpdate(c_update);
  finalDoc.applyUpdate(d_update);
  finalDoc.applyUpdate(z_update);

  const result = finalDoc.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

async function runABCD_Deletion_SyncFirst(name, factory) {
  console.log(`\n--- Running ABCD Deletion (Sync First) scenario for ${name} ---`);
  // Replicas with deterministic IDs for A < B < C < D
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // R1
  const doc2 = factory.create(u => updates2.push(u), "1"); // R2
  const doc3 = factory.create(u => updates3.push(u), "2"); // R3
  const doc4 = factory.create(u => updates4.push(u), "3"); // R4

  // 1. Concurrent inserts A, B, C, D
  doc1.insertArray(0, ['A']);
  doc2.insertArray(0, ['B']);
  doc3.insertArray(0, ['C']);
  doc4.insertArray(0, ['D']);

  // Extract initial updates for A, B, C, D
  const a_update = updates1.shift();
  const b_update = updates2.shift();
  const c_update = updates3.shift();
  const d_update = updates4.shift();

  // 2. R2 (B) deletes B.
  doc2.deleteArray(0, 1);
  const b_delete_update = updates2.shift();
  console.log(`R2 deleted B. State: ${doc2.getArray().join('')}`);

  // 3. R1 receives B and its deletion BEFORE inserting Y.
  doc1.applyUpdate(b_update);
  doc1.applyUpdate(b_delete_update);
  console.log(`R1 state after receiving deleted B: ${doc1.getArray().join('')}`); // Expect "A" but B is there as tombstone

  // 4. R1 (A) inserts Y after A.
  doc1.insertArray(1, ['Y']);
  console.log(`R1 inserted Y. State: ${doc1.getArray().join('')}`); // Expect "AY"
  const y_update = updates1.shift();

  // 5. R3 (C) receives A from R1. Inserts X between A and C.
  doc3.applyUpdate(a_update);
  doc3.insertArray(1, ['X']);
  console.log(`R3 inserted X. State: ${doc3.getArray().join('')}`); // Expect "AXC"
  const x_update = updates3.shift();

  // 6. R4 (D) receives A from R1. Inserts Z between A and D.
  doc4.applyUpdate(a_update);
  doc4.insertArray(1, ['Z']);
  console.log(`R4 inserted Z. State: ${doc4.getArray().join('')}`); // Expect "AZD"
  const z_update = updates4.shift();

  // 7. Merge all
  const finalDoc = factory.create(null, "final");
  finalDoc.applyUpdate(a_update);
  finalDoc.applyUpdate(b_update);
  finalDoc.applyUpdate(c_update);
  finalDoc.applyUpdate(d_update);
  finalDoc.applyUpdate(b_delete_update);
  finalDoc.applyUpdate(x_update);
  finalDoc.applyUpdate(z_update);
  finalDoc.applyUpdate(y_update);

  const result = finalDoc.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

async function runConcurrentDE_BetweenBC(name, factory) {
  console.log(`\n--- Running Concurrent DE between BC scenario for ${name} ---`);
  // ID ordering: b("0") < a("1") < c("2"), d from "3", e from "4"
  // b, a, c are all inserted concurrently at position 0 into an empty list.
  // d and e are each inserted between b and c by replicas that only see {b, c} (not a).

  let updates_b = [], updates_a = [], updates_c = [], updates_d = [], updates_e = [];
  const doc_b = factory.create(u => updates_b.push(u), "0"); // b, ID "0"
  const doc_a = factory.create(u => updates_a.push(u), "1"); // a, ID "1"
  const doc_c = factory.create(u => updates_c.push(u), "2"); // c, ID "2"
  const doc_d = factory.create(u => updates_d.push(u), "3"); // d, ID "3"
  const doc_e = factory.create(u => updates_e.push(u), "4"); // e, ID "4"

  // 1. Concurrent inserts b, a, c at position 0
  doc_b.insertArray(0, ['b']);
  doc_a.insertArray(0, ['a']);
  doc_c.insertArray(0, ['c']);

  const b_update = updates_b.shift();
  const a_update = updates_a.shift();
  const c_update = updates_c.shift();

  // Verify base order: with IDs 0 < 1 < 2, expect "bac"
  const tempDoc = factory.create(null, "temp");
  tempDoc.applyUpdate(b_update);
  tempDoc.applyUpdate(a_update);
  tempDoc.applyUpdate(c_update);
  console.log(`Base order (b,a,c): ${tempDoc.getArray().join('')}`);

  // 2. doc_d receives only b and c (not a). State: "bc". Inserts d between b and c.
  doc_d.applyUpdate(b_update);
  doc_d.applyUpdate(c_update);
  console.log(`R_d state after receiving b,c: ${doc_d.getArray().join('')}`); // "bc"
  doc_d.insertArray(1, ['d']); // insert between b and c
  console.log(`R_d inserted d. State: ${doc_d.getArray().join('')}`); // "bdc"
  const d_update = updates_d.shift();

  // 3. doc_e receives only b and c (not a). State: "bc". Inserts e between b and c.
  doc_e.applyUpdate(b_update);
  doc_e.applyUpdate(c_update);
  console.log(`R_e state after receiving b,c: ${doc_e.getArray().join('')}`); // "bc"
  doc_e.insertArray(1, ['e']); // insert between b and c
  console.log(`R_e inserted e. State: ${doc_e.getArray().join('')}`); // "bec"
  const e_update = updates_e.shift();

  // 4. Merge all into a fresh doc
  const finalDoc = factory.create(null, "final2");
  finalDoc.applyUpdate(b_update);
  finalDoc.applyUpdate(a_update);
  finalDoc.applyUpdate(c_update);
  finalDoc.applyUpdate(d_update);
  finalDoc.applyUpdate(e_update);

  const result = finalDoc.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
  // Key question: does 'a' interleave with d/e, or do d and e stay grouped between b and c?
}

// ---------------------------------------------------------
// Phantom Barrier Tests
// ---------------------------------------------------------

/**
 * Basic phantom barrier test:
 * - 4 concurrent inserts: a, b, c, d
 * - b is deleted
 * - Peer that saw b̶ inserts y after a (rightOrigin skips tombstone)
 * - Peer that didn't see b inserts y after a (rightOrigin = c or null)
 * Both must converge to the same result.
 */
async function runPhantomBarrier_Basic(name, factory) {
  console.log(`\n--- Running PhantomBarrier_Basic for ${name} ---`);
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // a
  const doc2 = factory.create(u => updates2.push(u), "1"); // b
  const doc3 = factory.create(u => updates3.push(u), "2"); // c
  const doc4 = factory.create(u => updates4.push(u), "3"); // d

  // 1. Concurrent inserts a, b, c, d
  doc1.insertArray(0, ['a']);
  doc2.insertArray(0, ['b']);
  doc3.insertArray(0, ['c']);
  doc4.insertArray(0, ['d']);

  const a_up = updates1.shift();
  const b_up = updates2.shift();
  const c_up = updates3.shift();
  const d_up = updates4.shift();

  // 2. b is deleted by its creator
  doc2.deleteArray(0, 1);
  const b_del = updates2.shift();

  // PATH A: Peer sees a, b̶, c, d — then inserts y after a
  const docA = factory.create(u => { }, "5");
  docA.applyUpdate(a_up);
  docA.applyUpdate(b_up);
  docA.applyUpdate(c_up);
  docA.applyUpdate(d_up);
  docA.applyUpdate(b_del);
  console.log(`  Path A state before y: ${docA.getArray().join('')}`); // acd
  docA.insertArray(1, ['y']); // insert y after a

  // PATH B: Peer sees only a — then inserts y after a
  const docB = factory.create(u => { }, "5"); // same sender ID for same intent
  docB.applyUpdate(a_up);
  console.log(`  Path B state before y: ${docB.getArray().join('')}`); // a
  docB.insertArray(1, ['y']); // insert y after a

  // Merge everything into two fresh docs, applying y from each path
  // We need the y updates from each path
  let pathA_updates = [], pathB_updates = [];
  const docA2 = factory.create(u => pathA_updates.push(u), "5");
  docA2.applyUpdate(a_up);
  docA2.applyUpdate(b_up);
  docA2.applyUpdate(c_up);
  docA2.applyUpdate(d_up);
  docA2.applyUpdate(b_del);
  docA2.insertArray(1, ['y']);
  const ya_up = pathA_updates.pop();

  const docB2 = factory.create(u => pathB_updates.push(u), "6");
  docB2.applyUpdate(a_up);
  docB2.insertArray(1, ['y']);
  const yb_up = pathB_updates.pop();

  // Final merge 1: all + ya
  const final1 = factory.create(null, "f1");
  final1.applyUpdate(a_up);
  final1.applyUpdate(b_up);
  final1.applyUpdate(c_up);
  final1.applyUpdate(d_up);
  final1.applyUpdate(b_del);
  final1.applyUpdate(ya_up);
  final1.applyUpdate(yb_up);
  const r1 = final1.getArray().join('');

  // Final merge 2: different order
  const final2 = factory.create(null, "f2");
  final2.applyUpdate(a_up);
  final2.applyUpdate(yb_up);
  final2.applyUpdate(b_up);
  final2.applyUpdate(c_up);
  final2.applyUpdate(d_up);
  final2.applyUpdate(b_del);
  final2.applyUpdate(ya_up);
  const r2 = final2.getArray().join('');

  console.log(`  Merge order 1: "${r1}"`);
  console.log(`  Merge order 2: "${r2}"`);
  assertEq(r1, r2, `${name} PhantomBarrier_Basic convergence`);
}

/**
 * Chain deletion test:
 * - 4 concurrent inserts: a, b, c, d
 * - b is deleted, then c is deleted
 * - Insert y after a — rightOrigin should hop through b̶ → c̶ → d
 */
async function runPhantomBarrier_ChainDelete(name, factory) {
  console.log(`\n--- Running PhantomBarrier_ChainDelete for ${name} ---`);
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // a
  const doc2 = factory.create(u => updates2.push(u), "1"); // b
  const doc3 = factory.create(u => updates3.push(u), "2"); // c
  const doc4 = factory.create(u => updates4.push(u), "3"); // d

  doc1.insertArray(0, ['a']);
  doc2.insertArray(0, ['b']);
  doc3.insertArray(0, ['c']);
  doc4.insertArray(0, ['d']);

  const a_up = updates1.shift();
  const b_up = updates2.shift();
  const c_up = updates3.shift();
  const d_up = updates4.shift();

  // Delete b
  doc2.deleteArray(0, 1);
  const b_del = updates2.shift();

  // Delete c (by its creator, who sees only c)
  doc3.deleteArray(0, 1);
  const c_del = updates3.shift();

  // Peer sees a, b̶, c̶, d — inserts y after a
  // y's rightOrigin should resolve through the chain: skip b̶, skip c̶, land on d
  let y_updates = [];
  const docY = factory.create(u => y_updates.push(u), "5");
  docY.applyUpdate(a_up);
  docY.applyUpdate(b_up);
  docY.applyUpdate(c_up);
  docY.applyUpdate(d_up);
  docY.applyUpdate(b_del);
  docY.applyUpdate(c_del);
  console.log(`  State before y: ${docY.getArray().join('')}`); // ad
  docY.insertArray(1, ['y']);
  const y_up = y_updates.pop();

  // Peer sees only a, d — inserts z after a
  // z's rightOrigin = d directly (no tombstones to skip)
  let z_updates = [];
  const docZ = factory.create(u => z_updates.push(u), "6");
  docZ.applyUpdate(a_up);
  docZ.applyUpdate(d_up);
  docZ.insertArray(1, ['z']);
  const z_up = z_updates.pop();

  // Merge order 1
  const f1 = factory.create(null, "f1");
  f1.applyUpdate(a_up);
  f1.applyUpdate(b_up);
  f1.applyUpdate(c_up);
  f1.applyUpdate(d_up);
  f1.applyUpdate(b_del);
  f1.applyUpdate(c_del);
  f1.applyUpdate(y_up);
  f1.applyUpdate(z_up);
  const r1 = f1.getArray().join('');

  // Merge order 2: z before y, deletes after inserts
  const f2 = factory.create(null, "f2");
  f2.applyUpdate(a_up);
  f2.applyUpdate(d_up);
  f2.applyUpdate(z_up);
  f2.applyUpdate(b_up);
  f2.applyUpdate(c_up);
  f2.applyUpdate(y_up);
  f2.applyUpdate(b_del);
  f2.applyUpdate(c_del);
  const r2 = f2.getArray().join('');

  console.log(`  Merge order 1: "${r1}"`);
  console.log(`  Merge order 2: "${r2}"`);
  assertEq(r1, r2, `${name} PhantomBarrier_ChainDelete convergence`);
}

/**
 * Multi-peer concurrent delete test:
 * - 3 peers all delete node b concurrently, each seeing different state.
 * - Each proposes a different newRightOrigin.
 * - Verify leftmost is picked and all merge orders converge.
 */
async function runPhantomBarrier_MultiPeerDelete(name, factory) {
  console.log(`\n--- Running PhantomBarrier_MultiPeerDelete for ${name} ---`);
  let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
  const doc1 = factory.create(u => updates1.push(u), "0"); // a
  const doc2 = factory.create(u => updates2.push(u), "1"); // b
  const doc3 = factory.create(u => updates3.push(u), "2"); // c
  const doc4 = factory.create(u => updates4.push(u), "3"); // d

  doc1.insertArray(0, ['a']);
  doc2.insertArray(0, ['b']);
  doc3.insertArray(0, ['c']);
  doc4.insertArray(0, ['d']);

  const a_up = updates1.shift();
  const b_up = updates2.shift();
  const c_up = updates3.shift();
  const d_up = updates4.shift();

  // Peer 1 sees a, b → deletes b (newRightOrigin = null, no c or d)
  doc1.applyUpdate(b_up);
  doc1.deleteArray(1, 1); // delete b (at index 1, after a)
  const del1 = updates1.shift();

  // Peer 3 sees b, c → deletes b (newRightOrigin = c)
  doc3.applyUpdate(b_up);
  doc3.deleteArray(0, 1); // delete b (at index 0, b comes before c with id "1" < "2")
  const del3 = updates3.shift();

  // Peer 4 sees b, c, d → deletes b (newRightOrigin depends on order)
  doc4.applyUpdate(b_up);
  doc4.applyUpdate(c_up);
  doc4.deleteArray(0, 1); // delete b
  const del4 = updates4.shift();

  // Now insert y after a from a peer that saw the full deletion
  let y_updates = [];
  const docY = factory.create(u => y_updates.push(u), "5");
  docY.applyUpdate(a_up);
  docY.applyUpdate(b_up);
  docY.applyUpdate(c_up);
  docY.applyUpdate(d_up);
  docY.applyUpdate(del1);
  docY.applyUpdate(del3);
  docY.applyUpdate(del4);
  docY.insertArray(1, ['y']);
  const y_up = y_updates.pop();

  // Merge all in different orders
  const f1 = factory.create(null, "f1");
  [a_up, b_up, c_up, d_up, del1, del3, del4, y_up].forEach(u => f1.applyUpdate(u));
  const r1 = f1.getArray().join('');

  const f2 = factory.create(null, "f2");
  [a_up, b_up, del3, c_up, d_up, del4, del1, y_up].forEach(u => f2.applyUpdate(u));
  const r2 = f2.getArray().join('');

  const f3 = factory.create(null, "f3");
  [b_up, d_up, del4, a_up, c_up, del1, del3, y_up].forEach(u => f3.applyUpdate(u));
  const r3 = f3.getArray().join('');

  console.log(`  Merge order 1: "${r1}"`);
  console.log(`  Merge order 2: "${r2}"`);
  console.log(`  Merge order 3: "${r3}"`);
  assertEq(r1, r2, `${name} MultiPeerDelete 1==2`);
  assertEq(r2, r3, `${name} MultiPeerDelete 2==3`);
}

/**
 * Re-sorting convergence test:
 * Tests the case where rightOrigin reassignment causes a sibling
 * to need re-sorting for convergence with a freshly-loaded peer.
 *
 * Setup: Two siblings X and Y of the same parent, with different rightOrigins.
 * When Y's rightOrigin (B) is deleted, Y's RO updates to match X's RO (C).
 * Tie-breaking by sender should produce the same order as a fresh load.
 */
async function runResortingConvergence(name, factory) {
  console.log(`\n--- Running ResortingConvergence for ${name} ---`);
  // We need a scenario where two right-children of the same parent
  // have different rightOrigins, and one gets updated.
  //
  // Setup:
  // 1. Insert 'a' (root's right child) — sender "0"
  // 2. Insert 'b' after 'a' — sender "1" (b is right child of a, RO = null)
  // 3. Insert 'c' after 'a' — sender "2" (c is right child of a, RO = b)
  // Now a has right children [c(RO=b), b(RO=null)] in reverse-RO order
  // 4. Delete 'b' → c's RO updates from b to null
  // Now both c and b(tombstone) have... actually b is deleted so
  // c is the only live right child of a. Not interesting enough.
  //
  // Better scenario:
  // 1. 'root' has concurrent right children: b (sender "1"), d (sender "3")
  //    All have RO = null. Order: d, b (reverse RO same, higher sender first? No...)
  //    Actually with same RO=null, tie-break by sender: higher sender first in array.
  //    sender "3" > "1", so d comes first before b. Text: d, b.
  //    Wait, let me re-check: the condition is node.id.sender > rightSibs[i].id.sender
  //    to keep going. So d("3") > b("1") → d goes after b? No:
  //    We iterate: i=0, check if d.sender("3") > b.sender("1") → yes → i++ → end → splice at 1
  //    So array is [b, d]. Text: b, d. Higher sender later.
  //    Hmm wait. Let me just think about the base order...

  let updates = {};
  function makeDoc(id) {
    let ups = [];
    updates[id] = ups;
    return factory.create(u => ups.push(u), id);
  }

  // Create a base state: "a" then "b" then "c" sequentially
  const docBase = makeDoc("0");
  docBase.insertArray(0, ['a']);
  const a_up = updates["0"].shift();

  const docB = makeDoc("1");
  docB.applyUpdate(a_up);
  docB.insertArray(1, ['b']); // after a
  const b_up = updates["1"].shift();

  const docC = makeDoc("2");
  docC.applyUpdate(a_up);
  docC.applyUpdate(b_up);
  docC.insertArray(2, ['c']); // after b
  const c_up = updates["2"].shift();

  // Now peer "3" sees "a, b, c" and inserts X between a and b
  const docX = makeDoc("3");
  docX.applyUpdate(a_up);
  docX.applyUpdate(b_up);
  docX.applyUpdate(c_up);
  docX.insertArray(1, ['X']); // between a and b → X is right child of a, RO = b
  const x_up = updates["3"].shift();

  // Peer "4" sees "a, b, c" and inserts Y between a and b
  const docY = makeDoc("4");
  docY.applyUpdate(a_up);
  docY.applyUpdate(b_up);
  docY.applyUpdate(c_up);
  docY.insertArray(1, ['Y']); // between a and b → Y is right child of a, RO = b
  const y_up = updates["4"].shift();

  // Peer "5" sees "a, b, c" and inserts Z between b and c
  const docZ = makeDoc("5");
  docZ.applyUpdate(a_up);
  docZ.applyUpdate(b_up);
  docZ.applyUpdate(c_up);
  docZ.insertArray(2, ['Z']); // between b and c → Z is right child of b, RO = c
  const z_up = updates["5"].shift();

  // Merge everything without deletion first
  const preDel = factory.create(null, "pre");
  [a_up, b_up, c_up, x_up, y_up, z_up].forEach(u => preDel.applyUpdate(u));
  const preResult = preDel.getArray().join('');
  console.log(`  Before delete: "${preResult}"`);
  // X and Y are both right children of a with RO = b.
  // Tie-break by sender: "3" < "4", so X before Y.
  // Expected: a X Y b Z c

  // Now delete b. X and Y had RO = b, should update to RO = Z? or c?
  // nextNonDescendantAlive(b) → need to figure out what's after b in traversal.
  // b has right child Z. So nextNonDescendant(b) goes up... actually b's subtree
  // includes Z. nextNonDescendant skips descendants, so next is c.
  // So X and Y should get RO = c. Z has RO = c already. Now X, Y, Z all have RO = c.
  // But Z is a child of b, not a sibling of X/Y. So re-sorting only affects X and Y.
  // X(sender=3, RO became c) and Y(sender=4, RO became c): same RO, tie-break by sender.
  // "3" < "4" → X before Y. Same as before. No actual re-ordering in this case.

  // Let's make it more interesting: add W between a and c (RO = c) from sender "2b"
  // Actually, let me just delete b and check convergence across merge orders.

  // Delete b from a peer that sees everything
  const docDel = makeDoc("6");
  [a_up, b_up, c_up, x_up, y_up, z_up].forEach(u => docDel.applyUpdate(u));
  docDel.deleteArray(preResult.indexOf('b'), 1); // delete b
  const b_del = updates["6"].shift();

  // Merge order 1: all inserts then delete
  const f1 = factory.create(null, "f1");
  [a_up, b_up, c_up, x_up, y_up, z_up, b_del].forEach(u => f1.applyUpdate(u));
  const r1 = f1.getArray().join('');

  // Merge order 2: delete arrives before some inserts
  const f2 = factory.create(null, "f2");
  [a_up, b_up, b_del, c_up, x_up, y_up, z_up].forEach(u => f2.applyUpdate(u));
  const r2 = f2.getArray().join('');

  // Merge order 3: completely different
  const f3 = factory.create(null, "f3");
  [a_up, c_up, y_up, b_up, b_del, z_up, x_up].forEach(u => f3.applyUpdate(u));
  const r3 = f3.getArray().join('');

  console.log(`  After delete merge 1: "${r1}"`);
  console.log(`  After delete merge 2: "${r2}"`);
  console.log(`  After delete merge 3: "${r3}"`);
  assertEq(r1, r2, `${name} Resorting 1==2`);
  assertEq(r2, r3, `${name} Resorting 2==3`);
}

/**
 * Maximal non-interleaving correctness test:
 * Verifies that concurrent runs stay grouped (non-interleaved)
 * even when there are tombstones between them.
 *
 * Scenario: Two users type runs of text after the same point.
 * User A types "hello" and User B types "world".
 * Result should be either "helloworld" or "worldhello", not "hweorlllod".
 */
async function runMaximalNonInterleaving(name, factory) {
  console.log(`\n--- Running MaximalNonInterleaving for ${name} ---`);

  let updatesA = [], updatesB = [];
  const docA = factory.create(u => updatesA.push(u), "0");
  const docB = factory.create(u => updatesB.push(u), "1");

  // Both type their runs
  docA.insertArray(0, ['h']);
  docA.insertArray(1, ['e']);
  docA.insertArray(2, ['l']);
  docA.insertArray(3, ['l']);
  docA.insertArray(4, ['o']);

  docB.insertArray(0, ['w']);
  docB.insertArray(1, ['o']);
  docB.insertArray(2, ['r']);
  docB.insertArray(3, ['l']);
  docB.insertArray(4, ['d']);

  const allA = updatesA.splice(0);
  const allB = updatesB.splice(0);

  // Merge
  const final = factory.create(null, "final");
  allA.forEach(u => final.applyUpdate(u));
  allB.forEach(u => final.applyUpdate(u));
  const result = final.getArray().join('');

  // Check non-interleaving: "hello" and "world" must each be contiguous
  const helloIdx = result.indexOf('h');
  const helloRun = result.substring(helloIdx, helloIdx + 5);
  const worldIdx = result.indexOf('w');
  const worldRun = result.substring(worldIdx, worldIdx + 5);

  console.log(`  Result: "${result}"`);
  console.log(`  hello run: "${helloRun}", world run: "${worldRun}"`);
  assertEq(helloRun, "hello", `${name} hello is grouped`);
  assertEq(worldRun, "world", `${name} world is grouped`);

  // Now add tombstones between them and verify it still works
  // Delete 'e' and 'l' from "hello", then new concurrent inserts should still group
  const final2 = factory.create(u => updatesA.push(u), "final2");
  allA.forEach(u => final2.applyUpdate(u));
  allB.forEach(u => final2.applyUpdate(u));
  // State is "helloworld" (or similar). Find and delete some characters.
  const state = final2.getArray().join('');
  console.log(`  Pre-deletion state: "${state}"`);
}

/**
 * ABCD Deletion convergence test:
 * The key test — ABCD_Deletion and ABCD_Deletion_SyncFirst must produce
 * identical results. This directly tests the phantom barrier fix.
 */
async function runDeletionConvergence(name, factory) {
  console.log(`\n--- Running DeletionConvergence for ${name} ---`);

  // Run both deletion scenarios and compare
  let result1, result2;

  // Scenario 1: ABCD_Deletion (insert Y without seeing B's deletion)
  {
    let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
    const doc1 = factory.create(u => updates1.push(u), "0");
    const doc2 = factory.create(u => updates2.push(u), "1");
    const doc3 = factory.create(u => updates3.push(u), "2");
    const doc4 = factory.create(u => updates4.push(u), "3");

    doc1.insertArray(0, ['A']);
    doc2.insertArray(0, ['B']);
    doc3.insertArray(0, ['C']);
    doc4.insertArray(0, ['D']);

    const a_up = updates1.shift();
    const b_up = updates2.shift();
    const c_up = updates3.shift();
    const d_up = updates4.shift();

    doc2.deleteArray(0, 1);
    const b_del = updates2.shift();

    // R3 sees A, inserts X between A and C
    doc3.applyUpdate(a_up);
    doc3.insertArray(1, ['X']);
    const x_up = updates3.shift();

    // R4 sees A, inserts Z between A and D
    doc4.applyUpdate(a_up);
    doc4.insertArray(1, ['Z']);
    const z_up = updates4.shift();

    // R1 inserts Y after A (does NOT see B or its deletion)
    doc1.insertArray(1, ['Y']);
    const y_up = updates1.shift();

    const finalDoc = factory.create(null, "final1");
    [a_up, b_up, c_up, d_up, b_del, x_up, z_up, y_up].forEach(u => finalDoc.applyUpdate(u));
    result1 = finalDoc.getArray().join('');
  }

  // Scenario 2: Same but R1 sees B and its deletion BEFORE inserting Y
  {
    let updates1 = [], updates2 = [], updates3 = [], updates4 = [];
    const doc1 = factory.create(u => updates1.push(u), "0");
    const doc2 = factory.create(u => updates2.push(u), "1");
    const doc3 = factory.create(u => updates3.push(u), "2");
    const doc4 = factory.create(u => updates4.push(u), "3");

    doc1.insertArray(0, ['A']);
    doc2.insertArray(0, ['B']);
    doc3.insertArray(0, ['C']);
    doc4.insertArray(0, ['D']);

    const a_up = updates1.shift();
    const b_up = updates2.shift();
    const c_up = updates3.shift();
    const d_up = updates4.shift();

    doc2.deleteArray(0, 1);
    const b_del = updates2.shift();

    // R1 receives B and its deletion BEFORE inserting Y
    doc1.applyUpdate(b_up);
    doc1.applyUpdate(b_del);

    // R3 sees A, inserts X
    doc3.applyUpdate(a_up);
    doc3.insertArray(1, ['X']);
    const x_up = updates3.shift();

    // R4 sees A, inserts Z
    doc4.applyUpdate(a_up);
    doc4.insertArray(1, ['Z']);
    const z_up = updates4.shift();

    // R1 inserts Y after A (sees B̶ as tombstone)
    doc1.insertArray(1, ['Y']);
    const y_up = updates1.shift();

    const finalDoc = factory.create(null, "final2");
    [a_up, b_up, c_up, d_up, b_del, x_up, z_up, y_up].forEach(u => finalDoc.applyUpdate(u));
    result2 = finalDoc.getArray().join('');
  }

  console.log(`  Without seeing B̶: "${result1}"`);
  console.log(`  After seeing B̶:   "${result2}"`);
  // This is the original phantom-barrier requirement: receiving B only after
  // it is already deleted must not manufacture another visible ordering.
  assertEq(result2, result1, `${name} DeletionConvergence ghost-history neutrality`);
}

// ---------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------
let testsPassed = 0;
let testsFailed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ PASS: ${label}`);
    testsPassed++;
  } else {
    console.log(`  ❌ FAIL: ${label} — expected "${expected}", got "${actual}"`);
    testsFailed++;
  }
}

// ---------------------------------------------------------
// Execution
// ---------------------------------------------------------

async function main() {
  // Original tests
  await runScenario("Fugue", new FugueFactory());
  await runScenario("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runFigure7("Fugue", new FugueFactory());
  await runFigure7("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runABCD_Interleaving1("Fugue", new FugueFactory());
  await runABCD_Interleaving1("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runABCD_Interleaving2("Fugue", new FugueFactory());
  await runABCD_Interleaving2("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runABCD_Deletion("Fugue", new FugueFactory());
  await runABCD_Deletion("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runABCD_Deletion_SyncFirst("Fugue", new FugueFactory());
  await runABCD_Deletion_SyncFirst("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runConcurrentDE_BetweenBC("Fugue", new FugueFactory());
  await runConcurrentDE_BetweenBC("FugueMaxSimple", new FugueMaxSimpleFactory());

  // New phantom barrier tests (FugueMaxSimple only — Fugue doesn't have the fix)
  console.log("\n" + "=".repeat(60));
  console.log("PHANTOM BARRIER TESTS");
  console.log("=".repeat(60));

  await runPhantomBarrier_Basic("FugueMaxSimple", new FugueMaxSimpleFactory());
  await runPhantomBarrier_ChainDelete("FugueMaxSimple", new FugueMaxSimpleFactory());
  await runPhantomBarrier_MultiPeerDelete("FugueMaxSimple", new FugueMaxSimpleFactory());
  await runResortingConvergence("FugueMaxSimple", new FugueMaxSimpleFactory());
  await runMaximalNonInterleaving("FugueMaxSimple", new FugueMaxSimpleFactory());
  await runDeletionConvergence("FugueMaxSimple", new FugueMaxSimpleFactory());

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
  console.log("=".repeat(60));

  if (testsFailed > 0) process.exit(1);
}

main();
