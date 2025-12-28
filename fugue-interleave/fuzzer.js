/**
 * Commutativity Fuzzer for Fugue Interleave CRDT
 * 
 * Inspired by json-joy's StrNodeFuzzer implementation.
 * Tests that operations applied in different orders still converge to the same state.
 * 
 * @see https://jsonjoy.com/blog/fuzz-testing-rga-crdt
 */

import { CRuntime, ReplicaIDs } from "@collabs/collabs";
import { FugueArray } from "fugue";
import { FugueMaxSimple } from "fugue-max-simple";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------
// Xoshiro128ss PRNG (deterministic, seedable)
// ---------------------------------------------------------

function xoshiro128ss(a, b, c, d) {
  return () => {
    const t = b << 9;
    let r = b * 5;
    r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return (r >>> 0) / 4294967296;
  };
}

function randomSeed() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function seedToInts(seed) {
  let i = 0;
  const a = (seed[i++] << 24) | (seed[i++] << 16) | (seed[i++] << 8) | seed[i++];
  const b = (seed[i++] << 24) | (seed[i++] << 16) | (seed[i++] << 8) | seed[i++];
  const c = (seed[i++] << 24) | (seed[i++] << 16) | (seed[i++] << 8) | seed[i++];
  const d = (seed[i++] << 24) | (seed[i++] << 16) | (seed[i++] << 8) | seed[i++];
  return [a, b, c, d];
}

// ---------------------------------------------------------
// Tree-Dump Style Printing (like json-joy's tree-dump)
// ---------------------------------------------------------

/**
 * Print a tree structure with box-drawing characters.
 * @param {string} tab - Current indentation
 * @param {Array<(tab: string) => string | null>} children - Child render functions
 * @returns {string}
 */
function printTree(tab = '', children) {
  let str = '';
  let last = children.length - 1;
  for (; last >= 0; last--) if (children[last]) break;
  for (let i = 0; i <= last; i++) {
    const fn = children[i];
    if (!fn) continue;
    const isLast = i === last;
    const child = fn(tab + (isLast ? ' ' : '│') + '  ');
    const branch = child ? (isLast ? '└─' : '├─') : '│';
    str += '\n' + tab + branch + (child ? ' ' + child : '');
  }
  return str;
}

/**
 * Print an operation in a readable format
 */
function printOp(op) {
  if (op.type === 'insert') {
    return `ins idx:${op.index} ${JSON.stringify(op.content.join(''))}`;
  } else {
    return `del idx:${op.index} count:${op.count}`;
  }
}

/**
 * Print a patch (array of operations)
 */
function printPatch(tab, ops) {
  if (ops.length === 0) {
    return 'patch (empty)';
  }
  return 'patch' + printTree(tab, ops.map(op => (tab) => printOp(op)));
}

// ---------------------------------------------------------
// Base Fuzzer Class
// ---------------------------------------------------------

export class Fuzzer {
  constructor(seed) {
    this.seed = seed || randomSeed();
    const [a, b, c, d] = seedToInts(this.seed);
    this._random = xoshiro128ss(a, b, c, d);
  }

  random() {
    return this._random();
  }

  randomInt(min, max) {
    return Math.floor(this._random() * (max - min + 1)) + min;
  }

  pick(elements) {
    return elements[Math.floor(this._random() * elements.length)];
  }

  repeat(times, callback) {
    const result = [];
    for (let i = 0; i < times; i++) result.push(callback());
    return result;
  }

  shuffle(arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.randomInt(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  seedToHex() {
    return Array.from(this.seed).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

// ---------------------------------------------------------
// CRDT Factories (from index.js)
// ---------------------------------------------------------

class FugueCRDT {
  constructor(updateHandler, replicaID) {
    this.doc = new CRuntime({
      debugReplicaID: replicaID,
    });
    this.updates = [];
    if (updateHandler) {
      this.doc.on("Send", (e) => {
        const update = this._encodeUpdate(e.message, false);
        this.updates.push(update);
        updateHandler(update);
      });
    } else {
      this.doc.on("Send", (e) => {
        this.updates.push(this._encodeUpdate(e.message, false));
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

  view() {
    return this.getArray().join('');
  }
}

class FugueMaxSimpleCRDT {
  constructor(updateHandler, replicaID) {
    this.doc = new CRuntime({
      debugReplicaID: replicaID,
    });
    this.updates = [];
    if (updateHandler) {
      this.doc.on("Send", (e) => {
        const update = this._encodeUpdate(e.message, false);
        this.updates.push(update);
        updateHandler(update);
      });
    } else {
      this.doc.on("Send", (e) => {
        this.updates.push(this._encodeUpdate(e.message, false));
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

  view() {
    return this.getArray().join('');
  }
}

// ---------------------------------------------------------
// Operation Types
// ---------------------------------------------------------

class InsertOp {
  constructor(siteId, index, content) {
    this.type = 'insert';
    this.siteId = siteId;
    this.index = index;
    this.content = content;
  }

  toString() {
    return `InsertOp(site=${this.siteId}, idx=${this.index}, content=${JSON.stringify(this.content)})`;
  }

  toCode(varName) {
    return `${varName}.insertArray(${this.index}, ${JSON.stringify(this.content)});`;
  }

  toJSON() {
    return { type: 'insert', siteId: this.siteId, index: this.index, content: this.content };
  }
}

class DeleteOp {
  constructor(siteId, index, count) {
    this.type = 'delete';
    this.siteId = siteId;
    this.index = index;
    this.count = count;
  }

  toString() {
    return `DeleteOp(site=${this.siteId}, idx=${this.index}, count=${this.count})`;
  }

  toCode(varName) {
    return `${varName}.deleteArray(${this.index}, ${this.count});`;
  }

  toJSON() {
    return { type: 'delete', siteId: this.siteId, index: this.index, count: this.count };
  }
}

// ---------------------------------------------------------
// Site (simulates one user/replica)
// ---------------------------------------------------------

class FugueInterleaveSite {
  constructor(fuzzer, siteId, CRDTClass) {
    this.fuzzer = fuzzer;
    this.siteId = siteId;
    this.CRDTClass = CRDTClass;
    this.replicaID = String(siteId);
    this.doc = new CRDTClass(null, this.replicaID);
    this.patches = []; // Array of Op[]
    this.allUpdates = []; // All updates ever generated by this site
  }

  apply(ops) {
    for (const op of ops) {
      if (op.type === 'insert') {
        this.doc.insertArray(op.index, op.content);
      } else if (op.type === 'delete') {
        this.doc.deleteArray(op.index, op.count);
      }
    }
  }

  applyUpdates(updates) {
    for (const update of updates) {
      this.doc.applyUpdate(update);
    }
  }

  getUpdatesAfter(count) {
    return this.doc.updates.slice(count);
  }

  randomOperation() {
    const length = this.doc.getArray().length;
    const doInsert = length === 0 || this.fuzzer.random() > this.fuzzer.options.deleteProbability;

    if (doInsert) {
      // Insert position is 0..length (inclusive, can insert at end)
      const pos = this.fuzzer.randomInt(0, length);
      const insertLen = this.fuzzer.randomInt(this.fuzzer.options.minInsertLength, this.fuzzer.options.maxInsertLength);
      const char = this.fuzzer.pick(['a', 'b', 'c', 'd']);
      const content = Array(insertLen).fill(char);
      return new InsertOp(this.siteId, pos, content);
    } else {
      // Delete position is 0..length-1 (must be valid index)
      const pos = this.fuzzer.randomInt(0, length - 1);
      // Remaining elements from pos to end
      const remaining = length - pos;
      const maxDel = Math.min(remaining, this.fuzzer.options.maxDeleteLength);
      const delLen = this.fuzzer.randomInt(1, Math.max(1, maxDel));
      return new DeleteOp(this.siteId, pos, delLen);
    }
  }

  randomPatch(min, max) {
    const ops = [];
    const opCount = this.fuzzer.randomInt(min, max);
    for (let i = 0; i < opCount; i++) {
      const op = this.randomOperation();
      ops.push(op);
      // Apply immediately so subsequent operations see updated state
      if (op.type === 'insert') {
        this.doc.insertArray(op.index, op.content);
      } else if (op.type === 'delete') {
        this.doc.deleteArray(op.index, op.count);
      }
    }
    return ops;
  }

  view() {
    return this.doc.view();
  }

  /**
   * Tree-dump style string representation
   */
  toString(tab = '') {
    return `Site ${this.siteId} { "${this.view()}" }` + printTree(tab, [
      (tab) => `replicaID: "${this.replicaID}"`,
      (tab) => `updates: ${this.doc.updates.length}`,
      (tab) => 'patches' + printTree(tab, 
        this.patches.map((patch, idx) => (tab) => `[${idx}] ` + printPatch(tab, patch))
      ),
    ]);
  }
}

// ---------------------------------------------------------
// Fuzzer Options
// ---------------------------------------------------------

/**
 * @typedef {Object} FugueInterleaveFuzzerOptions
 * @property {number} minPreludeLength - Min ops before parallel editing
 * @property {number} maxPreludeLength - Max ops before parallel editing
 * @property {number} minSiteCount - Min number of sites (>= 2)
 * @property {number} maxSiteCount - Max number of sites
 * @property {number} minPatchLength - Min ops per site per session
 * @property {number} maxPatchLength - Max ops per site per session
 * @property {number} minEditingSessionCount - Min editing sessions
 * @property {number} maxEditingSessionCount - Max editing sessions
 * @property {number} maxDeleteLength - Max chars to delete at once
 * @property {number} deleteProbability - Probability of delete (0-1)
 * @property {number} minInsertLength - Min chars to insert
 * @property {number} maxInsertLength - Max chars to insert
 */

const DEFAULT_OPTIONS = {
  minPreludeLength: 0,
  maxPreludeLength: 10,
  minSiteCount: 2,
  maxSiteCount: 10,
  minPatchLength: 0,
  maxPatchLength: 10,
  minEditingSessionCount: 1,
  maxEditingSessionCount: 10,
  maxDeleteLength: 1000,
  deleteProbability: 0.5,
  minInsertLength: 1,
  maxInsertLength: 10,
};

// ---------------------------------------------------------
// Main Fuzzer
// ---------------------------------------------------------

export class FugueInterleaveFuzzer extends Fuzzer {
  constructor(CRDTClass, options = {}, seed) {
    super(seed);
    this.CRDTClass = CRDTClass;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.sites = [];
    this.prelude = [];
    this.preludeUpdates = [];
    this.sessionUpdates = []; // Array of { siteId, updates }[]
    this.failedTestCases = [];
  }

  generatePrelude() {
    // Create initial site for prelude
    const site0 = new FugueInterleaveSite(this, 0, this.CRDTClass);
    this.sites.push(site0);

    // Generate prelude operations (randomPatch applies them internally)
    const updatesBefore = site0.doc.updates.length;
    this.prelude = site0.randomPatch(this.options.minPreludeLength, this.options.maxPreludeLength);
    site0.patches.push(this.prelude);
    this.preludeUpdates = site0.getUpdatesAfter(updatesBefore);

    // Create additional sites
    const siteCount = this.randomInt(this.options.minSiteCount, this.options.maxSiteCount);
    for (let i = 1; i < siteCount; i++) {
      const site = new FugueInterleaveSite(this, i, this.CRDTClass);
      // Apply prelude to new site
      site.applyUpdates(this.preludeUpdates);
      this.sites.push(site);
    }
  }

  executeParallelEditingSession() {
    const sites = this.sites;
    const sessionIndex = this.sessionUpdates.length;
    const sessionData = [];

    // Each site generates and applies its own patch (randomPatch applies internally)
    for (const site of sites) {
      const updatesBefore = site.doc.updates.length;
      const patch = site.randomPatch(this.options.minPatchLength, this.options.maxPatchLength);
      site.patches.push(patch);
      const updates = site.getUpdatesAfter(updatesBefore);
      sessionData.push({ siteId: site.siteId, updates, patch });
    }

    this.sessionUpdates.push(sessionData);

    // Exchange updates: each site receives all other sites' updates
    for (const site of sites) {
      for (const { siteId, updates } of sessionData) {
        if (siteId !== site.siteId) {
          site.applyUpdates(updates);
        }
      }
    }
  }

  assertSiteViewsEqual() {
    const view0 = this.sites[0].view();
    for (let i = 1; i < this.sites.length; i++) {
      const viewI = this.sites[i].view();
      if (view0 !== viewI) {
        throw new Error(`Site 0 view "${view0}" !== Site ${i} view "${viewI}"`);
      }
    }
  }

  /**
   * THE KEY TEST: Apply updates in different orders and verify convergence.
   * This is what catches the bug in runABCD_Deletion vs runABCD_Deletion_SyncFirst.
   */
  assertOrderIndependence() {
    // Collect all updates from all sessions
    const allUpdates = [];
    for (const sessionData of this.sessionUpdates) {
      for (const { siteId, updates } of sessionData) {
        for (const update of updates) {
          allUpdates.push({ siteId, update });
        }
      }
    }

    if (allUpdates.length === 0) return;

    // Create fresh docs and apply updates in different orders
    const order1 = [...allUpdates];
    const order2 = this.shuffle([...allUpdates]);

    // Doc with order 1
    const doc1 = new this.CRDTClass(null, "order1");
    for (const pu of this.preludeUpdates) {
      doc1.applyUpdate(pu);
    }
    for (const { update } of order1) {
      doc1.applyUpdate(update);
    }

    // Doc with order 2 (shuffled)
    const doc2 = new this.CRDTClass(null, "order2");
    for (const pu of this.preludeUpdates) {
      doc2.applyUpdate(pu);
    }
    for (const { update } of order2) {
      doc2.applyUpdate(update);
    }

    const view1 = doc1.view();
    const view2 = doc2.view();

    if (view1 !== view2) {
      throw new Error(`Order independence failed!\nOrder 1 view: "${view1}"\nOrder 2 view: "${view2}"`);
    }
  }

  executeEditingSessionsAndAssert() {
    const sessionCount = this.randomInt(
      this.options.minEditingSessionCount,
      this.options.maxEditingSessionCount
    );

    for (let i = 0; i < sessionCount; i++) {
      this.executeParallelEditingSession();
      this.assertSiteViewsEqual();
      this.assertOrderIndependence();
    }
  }

  /**
   * Generate a reproducible test case file on failure.
   */
  generateTestCaseFile(error) {
    const lines = [];
    lines.push(`/**`);
    lines.push(` * Auto-generated test case from fuzzer`);
    lines.push(` * Seed: ${this.seedToHex()}`);
    lines.push(` * Error: ${error.message}`);
    lines.push(` */`);
    lines.push(``);
    lines.push(`import { CRuntime } from "@collabs/collabs";`);
    lines.push(`import { FugueArray } from "fugue";`);
    lines.push(`import { FugueMaxSimple } from "fugue-max-simple";`);
    lines.push(``);
    lines.push(`// CRDT class used: ${this.CRDTClass.name || 'Unknown'}`);
    lines.push(``);
    lines.push(`test('fuzzer reproduction - ${this.seedToHex().slice(0, 8)}', () => {`);
    lines.push(`  // Seed: ${this.seedToHex()}`);
    lines.push(``);
    lines.push(`  // Sites: ${this.sites.length}`);
    for (let i = 0; i < this.sites.length; i++) {
      lines.push(`  // Site ${i} replica ID: "${this.sites[i].replicaID}"`);
    }
    lines.push(``);
    lines.push(`  // Prelude operations:`);
    for (const op of this.prelude) {
      lines.push(`  // ${op.toString()}`);
    }
    lines.push(``);
    lines.push(`  // Session operations:`);
    for (let sessIdx = 0; sessIdx < this.sessionUpdates.length; sessIdx++) {
      lines.push(`  // Session ${sessIdx}:`);
      for (const { siteId, patch } of this.sessionUpdates[sessIdx]) {
        if (patch) {
          for (const op of patch) {
            lines.push(`  //   ${op.toString()}`);
          }
        }
      }
    }
    lines.push(``);
    lines.push(`  // Final views:`);
    for (let i = 0; i < this.sites.length; i++) {
      lines.push(`  // Site ${i}: "${this.sites[i].view()}"`);
    }
    lines.push(``);
    lines.push(`  // TODO: Reproduce this test case using the operations above`);
    lines.push(`  expect(true).toBe(true); // Placeholder`);
    lines.push(`});`);

    const testCase = lines.join('\n');
    const fileName = path.join(__dirname, `fuzzer-bug-${Date.now()}.spec.js`);
    fs.writeFileSync(fileName, testCase);
    console.log(`Test case written to ${fileName}`);
    return fileName;
  }

  /**
   * Tree-dump style string representation (like json-joy's StrNodeFuzzer)
   */
  toString(tab = '') {
    const crdtName = this.CRDTClass === FugueCRDT ? 'Fugue' : 'FugueMaxSimple';
    const finalView = this.sites.length > 0 ? this.sites[0].view() : '';
    
    return `FugueInterleaveFuzzer { "${finalView.slice(0, 30)}${finalView.length > 30 ? '...' : ''}" }` + printTree(tab, [
      (tab) => `seed: ${this.seedToHex()}`,
      (tab) => `crdt: ${crdtName}`,
      (tab) => `sites: ${this.sites.length}`,
      (tab) => 'prelude' + printTree(tab, [
        (tab) => printPatch(tab, this.prelude),
      ]),
      (tab) => 'sites' + printTree(tab, 
        this.sites.map(site => (tab) => site.toString(tab))
      ),
      (tab) => 'sessions' + printTree(tab,
        this.sessionUpdates.map((sessionData, idx) => (tab) => {
          const totalUpdates = sessionData.reduce((sum, s) => sum + s.updates.length, 0);
          return `session ${idx} (${totalUpdates} updates)` + printTree(tab,
            sessionData.map(({ siteId, updates, patch }) => (tab) => 
              `site ${siteId}: ${updates.length} updates` + (patch ? printTree(tab, [
                (tab) => printPatch(tab, patch)
              ]) : '')
            )
          );
        })
      ),
    ]);
  }

  /**
   * Export a trace of all operations for replay/debugging.
   * Similar to json-joy's QuillDeltaFuzzer.trace()
   * 
   * @returns {FugueTrace} The trace object
   */
  trace() {
    return {
      seed: this.seedToHex(),
      crdt: this.CRDTClass === FugueCRDT ? 'Fugue' : 'FugueMaxSimple',
      siteCount: this.sites.length,
      finalView: this.sites.length > 0 ? this.sites[0].view() : '',
      prelude: this.prelude.map(op => op.toJSON()),
      sessions: this.sessionUpdates.map((sessionData, idx) => ({
        index: idx,
        sites: sessionData.map(({ siteId, patch }) => ({
          siteId,
          patch: patch ? patch.map(op => op.toJSON()) : [],
        })),
      })),
    };
  }

  /**
   * Save trace to a file for later replay/regression testing.
   * @param {string} [filename] - Optional filename, defaults to trace-{timestamp}.json
   * @returns {string} The filename where trace was saved
   */
  saveTrace(filename) {
    const trace = this.trace();
    const name = filename || `trace-${Date.now()}.json`;
    const filepath = path.join(__dirname, 'traces', name);
    
    // Create traces directory if it doesn't exist
    const tracesDir = path.join(__dirname, 'traces');
    if (!fs.existsSync(tracesDir)) {
      fs.mkdirSync(tracesDir, { recursive: true });
    }
    
    fs.writeFileSync(filepath, JSON.stringify(trace, null, 2));
    console.log(`Trace saved to ${filepath}`);
    return filepath;
  }

  /**
   * Generate a replayable test file from the trace.
   * Similar to json-joy's fuzz-*.ts trace files.
   */
  generateTraceTestFile(error) {
    const trace = this.trace();
    const lines = [];
    
    lines.push(`/**`);
    lines.push(` * Auto-generated fuzzer trace`);
    lines.push(` * Seed: ${trace.seed}`);
    lines.push(` * CRDT: ${trace.crdt}`);
    if (error) {
      lines.push(` * Error: ${error.message}`);
    }
    lines.push(` */`);
    lines.push(``);
    lines.push(`export const trace = ${JSON.stringify(trace, null, 2)};`);
    lines.push(``);
    lines.push(`// To replay this trace:`);
    lines.push(`// import { replayTrace } from './fuzzer.js';`);
    lines.push(`// replayTrace(trace);`);
    
    const testCase = lines.join('\n');
    const fileName = path.join(__dirname, 'traces', `fuzz-${Date.now()}.js`);
    
    // Create traces directory if it doesn't exist
    const tracesDir = path.join(__dirname, 'traces');
    if (!fs.existsSync(tracesDir)) {
      fs.mkdirSync(tracesDir, { recursive: true });
    }
    
    fs.writeFileSync(fileName, testCase);
    console.log(`Trace test file written to ${fileName}`);
    return fileName;
  }
}

// ---------------------------------------------------------
// Test Runner
// ---------------------------------------------------------

export function runFuzzer(CRDTClass, times, options = {}, verbose = false) {
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < times; i++) {
    const fuzzer = new FugueInterleaveFuzzer(CRDTClass, options);
    try {
      fuzzer.generatePrelude();
      fuzzer.assertSiteViewsEqual();
      fuzzer.executeEditingSessionsAndAssert();
      passed++;
      if (verbose && i % 100 === 0) {
        console.log(`Iteration ${i}: PASS - ${fuzzer.sites[0]?.view().slice(0, 20)}...`);
      }
    } catch (error) {
      failed++;
      console.error(`\n${'='.repeat(60)}`);
      console.error(`FAILURE at iteration ${i}`);
      console.error(`${'='.repeat(60)}`);
      console.error(fuzzer.toString());
      console.error(`\nError: ${error.message}`);
      fuzzer.generateTestCaseFile(error);
      if (!options.continueOnFailure) {
        throw error;
      }
    }
  }

  return { passed, failed };
}

/**
 * Replay a saved trace to verify it still produces the same result.
 * Useful for debugging and regression testing.
 * 
 * @param {object} trace - The trace object from fuzzer.trace() or loaded from file
 * @returns {boolean} true if replay succeeded and views match
 */
export function replayTrace(trace) {
  const CRDTClass = trace.crdt === 'Fugue' ? FugueCRDT : FugueMaxSimpleCRDT;
  
  console.log(`Replaying trace with seed: ${trace.seed}`);
  console.log(`CRDT: ${trace.crdt}, Sites: ${trace.siteCount}`);
  
  // Create sites
  const sites = [];
  for (let i = 0; i < trace.siteCount; i++) {
    sites.push(new CRDTClass(null, String(i)));
  }
  
  // Apply prelude to all sites (through site 0)
  console.log(`\nApplying prelude (${trace.prelude.length} ops)...`);
  for (const op of trace.prelude) {
    if (op.type === 'insert') {
      sites[0].insertArray(op.index, op.content);
    } else if (op.type === 'delete') {
      sites[0].deleteArray(op.index, op.count);
    }
  }
  
  // Get prelude updates and apply to other sites
  const preludeUpdates = sites[0].updates.slice();
  for (let i = 1; i < sites.length; i++) {
    for (const update of preludeUpdates) {
      sites[i].applyUpdate(update);
    }
  }
  
  // Apply sessions
  for (const session of trace.sessions) {
    console.log(`\nSession ${session.index}:`);
    const sessionUpdates = [];
    
    for (const siteData of session.sites) {
      const site = sites[siteData.siteId];
      const updatesBefore = site.updates.length;
      
      for (const op of siteData.patch) {
        if (op.type === 'insert') {
          site.insertArray(op.index, op.content);
        } else if (op.type === 'delete') {
          site.deleteArray(op.index, op.count);
        }
      }
      
      const updates = site.updates.slice(updatesBefore);
      sessionUpdates.push({ siteId: siteData.siteId, updates });
      console.log(`  Site ${siteData.siteId}: ${siteData.patch.length} ops, ${updates.length} updates`);
    }
    
    // Exchange updates
    for (const site of sites) {
      for (const { siteId, updates } of sessionUpdates) {
        if (String(siteId) !== site.doc.replicaID) {
          for (const update of updates) {
            site.applyUpdate(update);
          }
        }
      }
    }
  }
  
  // Verify all sites converge
  console.log(`\nFinal views:`);
  const views = sites.map(s => s.view());
  for (let i = 0; i < views.length; i++) {
    console.log(`  Site ${i}: "${views[i].slice(0, 50)}${views[i].length > 50 ? '...' : ''}"`);
  }
  
  const allEqual = views.every(v => v === views[0]);
  if (allEqual) {
    console.log(`\n✅ All sites converged to: "${views[0]}"`);
    if (trace.finalView && views[0] !== trace.finalView) {
      console.log(`⚠️  Warning: Final view differs from original trace`);
      console.log(`   Expected: "${trace.finalView}"`);
      console.log(`   Got:      "${views[0]}"`);
    }
  } else {
    console.log(`\n❌ Sites did NOT converge!`);
    return false;
  }
  
  return true;
}

// ---------------------------------------------------------
// Two-User Fuzzer (simpler, like json-joy's StrNode.fuzzing-2.spec.ts)
// ---------------------------------------------------------

export class TwoUserFuzzer extends Fuzzer {
  constructor(CRDTClass, seed) {
    super(seed);
    this.CRDTClass = CRDTClass;
    this.doc1 = new CRDTClass(null, "100");
    this.doc2 = new CRDTClass(null, "200");
    this.operations = [];
  }

  randomOperation(doc, siteId) {
    const length = doc.getArray().length;
    const doInsert = length === 0 || this.random() > 0.5;

    if (doInsert) {
      // Insert position is 0..length (inclusive)
      const pos = this.randomInt(0, length);
      const insertLen = this.randomInt(1, 4);
      const char = this.pick(['a', 'b', 'c', 'd']);
      const content = Array(insertLen).fill(char);

      const op = {
        type: 'insert',
        siteId,
        pos,
        content,
        apply: (d) => d.insertArray(pos, content),
        toString: (varName) => `${varName}.insertArray(${pos}, ${JSON.stringify(content)});`,
      };
      return op;
    } else {
      // Delete position is 0..length-1
      const pos = this.randomInt(0, length - 1);
      // Remaining elements from pos to end
      const remaining = length - pos;
      const delLen = Math.min(this.randomInt(1, 4), remaining);

      const op = {
        type: 'delete',
        siteId,
        pos,
        count: delLen,
        apply: (d) => d.deleteArray(pos, delLen),
        toString: (varName) => `${varName}.deleteArray(${pos}, ${delLen});`,
      };
      return op;
    }
  }

  runIteration(operationCount = 10) {
    const lines = [];
    lines.push(`// Seed: ${this.seedToHex()}`);
    lines.push(`const doc1 = new ${this.CRDTClass.name}(null, "100");`);
    lines.push(`const doc2 = new ${this.CRDTClass.name}(null, "200");`);
    lines.push(``);

    for (let i = 0; i < operationCount; i++) {
      const op1 = this.randomOperation(this.doc1, 1);
      const op2 = this.randomOperation(this.doc2, 2);

      lines.push(op1.toString('doc1'));
      lines.push(op2.toString('doc1'));
      lines.push(op2.toString('doc2'));
      lines.push(op1.toString('doc2'));
      lines.push(``);

      // Apply op1 to both docs
      const updates1Before = this.doc1.updates.length;
      op1.apply(this.doc1);
      const updates1 = this.doc1.updates.slice(updates1Before);

      // Apply op2 to both docs
      const updates2Before = this.doc2.updates.length;
      op2.apply(this.doc2);
      const updates2 = this.doc2.updates.slice(updates2Before);

      // Cross-apply updates
      for (const u of updates1) {
        this.doc2.applyUpdate(u);
      }
      for (const u of updates2) {
        this.doc1.applyUpdate(u);
      }

      // Check convergence
      const view1 = this.doc1.view();
      const view2 = this.doc2.view();

      if (view1 !== view2) {
        lines.push(`// FAILURE: doc1="${view1}" !== doc2="${view2}"`);
        lines.push(`expect(doc1.view()).toBe(doc2.view());`);
        const fileName = path.join(__dirname, `fuzzer-two-user-bug-${Date.now()}.spec.js`);
        fs.writeFileSync(fileName, lines.join('\n'));
        console.log(`Two-user test case written to ${fileName}`);
        throw new Error(`Two-user convergence failure: "${view1}" !== "${view2}"`);
      }
    }

    return this.doc1.view();
  }
}

export function runTwoUserFuzzer(CRDTClass, times, operationCount = 10, verbose = false) {
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < times; i++) {
    const fuzzer = new TwoUserFuzzer(CRDTClass);
    try {
      const view = fuzzer.runIteration(operationCount);
      passed++;
      if (verbose && i % 100 === 0) {
        console.log(`Two-user iteration ${i}: PASS - "${view.slice(0, 20)}..."`);
      }
    } catch (error) {
      failed++;
      console.error(`Two-user FAILURE at iteration ${i}: ${error.message}`);
      if (failed >= 5) {
        console.log("Too many failures, stopping.");
        break;
      }
    }
  }

  return { passed, failed };
}

// ---------------------------------------------------------
// Exports for different CRDT types
// ---------------------------------------------------------

export { FugueCRDT, FugueMaxSimpleCRDT };

// ---------------------------------------------------------
// Main (run when executed directly)
// ---------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("=== Fugue Interleave Commutativity Fuzzer ===\n");

  const iterations = parseInt(process.argv[2]) || 100;
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

  console.log("--- Testing Fugue (original) ---");
  try {
    const fugueResult = runFuzzer(FugueCRDT, iterations, {}, verbose);
    console.log(`Fugue: ${fugueResult.passed} passed, ${fugueResult.failed} failed\n`);
  } catch (e) {
    console.error(`Fugue fuzzer stopped: ${e.message}\n`);
  }

  console.log("--- Testing FugueMaxSimple ---");
  try {
    const maxSimpleResult = runFuzzer(FugueMaxSimpleCRDT, iterations, {}, verbose);
    console.log(`FugueMaxSimple: ${maxSimpleResult.passed} passed, ${maxSimpleResult.failed} failed\n`);
  } catch (e) {
    console.error(`FugueMaxSimple fuzzer stopped: ${e.message}\n`);
  }

  console.log("--- Two-User Fuzzer (Fugue) ---");
  try {
    const twoUserFugue = runTwoUserFuzzer(FugueCRDT, iterations * 10, 5, verbose);
    console.log(`Two-user Fugue: ${twoUserFugue.passed} passed, ${twoUserFugue.failed} failed\n`);
  } catch (e) {
    console.error(`Two-user Fugue stopped: ${e.message}\n`);
  }

  console.log("--- Two-User Fuzzer (FugueMaxSimple) ---");
  try {
    const twoUserMaxSimple = runTwoUserFuzzer(FugueMaxSimpleCRDT, iterations * 10, 5, verbose);
    console.log(`Two-user FugueMaxSimple: ${twoUserMaxSimple.passed} passed, ${twoUserMaxSimple.failed} failed\n`);
  } catch (e) {
    console.error(`Two-user FugueMaxSimple stopped: ${e.message}\n`);
  }

  console.log("=== Fuzzing complete ===");
}
