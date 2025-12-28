/**
 * Generate fuzzer traces for benchmarks and regression testing.
 * Similar to json-joy's generate-trace.ts
 * 
 * Run: node generate-trace.js [numSessions] [outputFile]
 * Example: node generate-trace.js 10 my-trace.json
 */

import { FugueInterleaveFuzzer, FugueCRDT, FugueMaxSimpleCRDT } from './fuzzer.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const numSessions = parseInt(args[0]) || 10;
const outputFile = args[1] || `trace-${Date.now()}.json`;
const crdtType = args[2] || 'Fugue';

const CRDTClass = crdtType === 'FugueMaxSimple' ? FugueMaxSimpleCRDT : FugueCRDT;

console.log(`Generating trace with ${numSessions} sessions using ${crdtType}...`);

const fuzzer = new FugueInterleaveFuzzer(CRDTClass, {
  minSiteCount: 3,
  maxSiteCount: 5,
  minPreludeLength: 5,
  maxPreludeLength: 10,
  minPatchLength: 3,
  maxPatchLength: 8,
  minEditingSessionCount: numSessions,
  maxEditingSessionCount: numSessions,
});

fuzzer.generatePrelude();
fuzzer.executeEditingSessionsAndAssert();

const trace = fuzzer.trace();

// Ensure traces directory exists
const tracesDir = path.join(__dirname, 'traces');
if (!fs.existsSync(tracesDir)) {
  fs.mkdirSync(tracesDir, { recursive: true });
}

const outputPath = path.join(tracesDir, outputFile);
fs.writeFileSync(outputPath, JSON.stringify(trace, null, 2));

console.log(`\nTrace generated successfully!`);
console.log(`  Seed: ${trace.seed}`);
console.log(`  CRDT: ${trace.crdt}`);
console.log(`  Sites: ${trace.siteCount}`);
console.log(`  Sessions: ${trace.sessions.length}`);
console.log(`  Final view: "${trace.finalView.slice(0, 50)}${trace.finalView.length > 50 ? '...' : ''}"`);
console.log(`  Output: ${outputPath}`);
console.log(``);
console.log(`To replay: node -e "import { replayTrace } from './fuzzer.js'; import trace from './traces/${outputFile}' assert { type: 'json' }; replayTrace(trace);"`);
