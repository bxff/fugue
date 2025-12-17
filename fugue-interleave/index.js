
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
  create(updateHandler) {
    return new FugueCRDT(this.rng, updateHandler);
  }
}

class FugueCRDT {
  constructor(rng, updateHandler) {
    this.doc = new CRuntime({
      debugReplicaID: ReplicaIDs.pseudoRandom(rng),
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
  create(updateHandler) {
    return new FugueMaxSimpleCRDT(this.rng, updateHandler);
  }
}

class FugueMaxSimpleCRDT {
  constructor(rng, updateHandler) {
    this.doc = new CRuntime({
      debugReplicaID: ReplicaIDs.pseudoRandom(rng),
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
  // Replicas
  let updates1 = [], updates2 = [], updates3 = [];
  const doc1 = factory.create(u => updates1.push(u)); // Replica 1
  const doc2 = factory.create(u => updates2.push(u)); // Replica 2
  const doc3 = factory.create(u => updates3.push(u)); // Replica 3

  // 1. Concurrent inserts A, B, C into empty list.
  // Previous run showed order R1 < R3 < R2 (A, C, B).
  // To get A < B < C, we map:
  // Scenario Replica 1 -> doc1 (inserts A)
  // Scenario Replica 2 -> doc3 (inserts B) (Middle ID)
  // Scenario Replica 3 -> doc2 (inserts C) (Last ID)

  doc1.insertArray(0, ['A']);
  doc3.insertArray(0, ['B']); // doc3 is "Scenario Replica 2"
  doc2.insertArray(0, ['C']); // doc2 is "Scenario Replica 3"

  // Check the base order of A, B, C
  const tempDoc = factory.create();
  updates1.forEach(u => tempDoc.applyUpdate(u)); // A
  updates3.forEach(u => tempDoc.applyUpdate(u)); // B
  updates2.forEach(u => tempDoc.applyUpdate(u)); // C

  const baseOrder = tempDoc.getArray().join(''); // Expect "ABC"
  console.log(`Base order (A,B,C) using remapped replicas: ${baseOrder}`);

  // 2. Scenario R1 receives {A, C}.
  // Scenario R1 is doc1.
  // C comes from doc2 (Scenario R3).
  // doc1 needs update from doc2.
  let c_update = updates2.shift(); // insert(C)
  if (c_update) doc1.applyUpdate(c_update);

  let r1State = doc1.getArray().join('');
  console.log(`Scenario R1 state after receiving C: ${r1State}`); // Expect "AC"

  // 3. Scenario R1 inserts X between A and C.
  if (r1State === "AC") {
    doc1.insertArray(1, ['X']);
    console.log(`Scenario R1 inserted X. State: ${doc1.getArray().join('')}`);
  }

  // 4. Scenario R2 receives {A, B}.
  // Scenario R2 is doc3.
  // B comes from doc3 (itself).
  // A comes from doc1.
  let a_update = updates1.shift(); // insert(A)
  if (a_update) doc3.applyUpdate(a_update);

  let r2State = doc3.getArray().join('');
  console.log(`Scenario R2 state after receiving A: ${r2State}`); // Expect "AB"

  // 5. Scenario R2 inserts Y between A and B.
  if (r2State === "AB") {
    doc3.insertArray(1, ['Y']);
    console.log(`Scenario R2 inserted Y. State: ${doc3.getArray().join('')}`);
  }

  // 6. Merge all.
  // Collect all updates into doc1.
  // Updates from doc1: already applied.
  // Updates from doc3 (Scenario R2): B, Y.
  while (updates3.length > 0) doc1.applyUpdate(updates3.shift());
  // Updates from doc2 (Scenario R3): C. (Already specific C update was applied, apply rest if any? C was just one update)
  while (updates2.length > 0) doc1.applyUpdate(updates2.shift());

  const result = doc1.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

async function main() {
  await runScenario("Fugue", new FugueFactory());
  await runScenario("FugueMaxSimple", new FugueMaxSimpleFactory());

  await runFigure7("Fugue", new FugueFactory());
  await runFigure7("FugueMaxSimple", new FugueMaxSimpleFactory());
}

main();
