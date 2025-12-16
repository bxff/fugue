
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
  while(doc3_updates.length > 0) {
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
  while(doc2_updates.length > 0) {
      let u = doc2_updates.shift();
      doc1.applyUpdate(u);
  }
  
  const result = doc1.getArray().join('');
  console.log(`Final Result for ${name}: "${result}"`);
}

// ---------------------------------------------------------
// Execution
// ---------------------------------------------------------

async function main() {
    await runScenario("Fugue", new FugueFactory());
    await runScenario("FugueMaxSimple", new FugueMaxSimpleFactory());
}

main();
