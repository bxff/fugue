
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


async function runABCDWaitZ(name, factory) {
  console.log(`\n--- Running ABCD with Z (and X, Y) scenario for ${name} ---`);
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

  // Check Base Order
  const tempDoc = factory.create(null, "temp");
  updates1.forEach(u => tempDoc.applyUpdate(u));
  updates2.forEach(u => tempDoc.applyUpdate(u));
  updates3.forEach(u => tempDoc.applyUpdate(u));
  updates4.forEach(u => tempDoc.applyUpdate(u));
  console.log(`Base order (A,B,C,D): ${tempDoc.getArray().join('')}`);

  // 2. R1 (A) receives C. Inserts X. (State AC)
  // Needs C form doc3.
  const c_update = updates3.shift();
  if (c_update) doc1.applyUpdate(c_update);

  let r1State = doc1.getArray().join('');
  console.log(`R1 state after receiving C: ${r1State}`); // Expect "AC"

  if (r1State === "AC") {
    doc1.insertArray(1, ['X']);
    console.log(`R1 inserted X. State: ${doc1.getArray().join('')}`);
  }

  // 3. R2 (B) receives A. Inserts Y. (State AB)
  // Needs A from doc1.
  const a_update = updates1.shift(); // A
  if (a_update) doc2.applyUpdate(a_update);

  let r2State = doc2.getArray().join('');
  console.log(`R2 state after receiving A: ${r2State}`); // Expect "AB"

  if (r2State === "AB") {
    doc2.insertArray(1, ['Y']);
    console.log(`R2 inserted Y. State: ${doc2.getArray().join('')}`);
  }

  // 4. R4 (D) receives A. Inserts Z. (State AD)
  // Needs A. We can reuse a_update or fetch from updates1 if we didn't shift it out permanently?
  // I shifted it out. But R4 can apply the same binary update.
  if (a_update) doc4.applyUpdate(a_update);

  let r4State = doc4.getArray().join('');
  console.log(`R4 state after receiving A: ${r4State}`); // Expect "AD" -> A(0) < D(3)

  if (r4State === "AD") {
    doc4.insertArray(1, ['Z']);
    console.log(`R4 inserted Z. State: ${doc4.getArray().join('')}`);
  }

  // 5. Merge all
  const finalDoc = factory.create(null, "final");
  // Apply all updates from everyone.
  // Note: a_update (A) was shifted.
  finalDoc.applyUpdate(a_update); // A
  if (updates1.length > 0) updates1.forEach(u => finalDoc.applyUpdate(u)); // X

  // B and Y
  updates2.forEach(u => finalDoc.applyUpdate(u));

  // C
  if (c_update) finalDoc.applyUpdate(c_update);
  updates3.forEach(u => finalDoc.applyUpdate(u));

  // D and Z
  updates4.forEach(u => finalDoc.applyUpdate(u));

  const result = finalDoc.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

async function main() {
  await runScenario("Fugue", new FugueFactory());
  await runScenario("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runFigure7("Fugue", new FugueFactory());
  await runFigure7("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runABCDWaitZ("Fugue", new FugueFactory());
  await runABCDWaitZ("FugueMaxSimple", new FugueMaxSimpleFactory());
}

main();
