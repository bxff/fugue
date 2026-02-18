
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

async function main() {
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
}

main();
