import { CRuntime } from "@collabs/collabs";

// Default: current implementation. For an audit of the published algorithm:
//   node test_solution.js --module fugue-max-canonical --report-only
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const moduleArg = option("--module", "fugue-max-simple");
const exportName = option("--export", "FugueMaxSimple");
const reportOnly = args.includes("--report-only");
const implementationModule = await import(moduleArg);
const ListClass = implementationModule[exportName];
if (ListClass === undefined) throw new Error(`Module ${moduleArg} has no export named ${exportName}`);

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
    this.arr = this.doc.registerCollab("array", (init) => new ListClass(init));
  }
  insert(idx, val) { this.doc.transact(() => this.arr.insert(idx, val)); }
  del(idx) { this.doc.transact(() => this.arr.delete(idx, 1)); }
  apply(u) { this.doc.receive(u.subarray(0, u.length - 1)); }
  pop() { return this.ups.shift(); }
  get val() { return [...this.arr.values()].join(''); }
}

let pass = 0, fail = 0;
let finalCounter = 0;
function merge(updates) {
  const f = new Doc("zz-final-" + (finalCounter++));
  updates.forEach(u => f.apply(u));
  return f.val;
}
// Assert that every given merge order yields `expected`.
function expectAll(orders, expected, label) {
  for (let i = 0; i < orders.length; i++) {
    const v = merge(orders[i]);
    if (v !== expected) {
      console.log(`  ❌ ${label} [order ${i}]: expected "${expected}", got "${v}"`);
      fail++;
      return;
    }
  }
  console.log(`  ✅ ${label}: "${expected}" (${orders.length} merge orders)`);
  pass++;
}
// Assert all merge orders agree (value unconstrained), return the value.
function expectConverge(orders, label) {
  const first = merge(orders[0]);
  for (let i = 1; i < orders.length; i++) {
    const v = merge(orders[i]);
    if (v !== first) {
      console.log(`  ❌ ${label}: order 0 gave "${first}", order ${i} gave "${v}"`);
      fail++;
      return null;
    }
  }
  console.log(`  ✅ ${label}: converges to "${first}" (${orders.length} merge orders)`);
  pass++;
  return first;
}

// =====================================================================
// POINT 1 — "a,b → ayb…; delete b,d; converges to ay…"
// y is inserted between a and b (RO=b), d is typed after b.
// Then b and d are deleted. y's anchor must remain the tombstone chain:
//   - y stays exactly where b's position dictates,
//   - an insert made *knowing* the deletions lands after the whole dead
//     chain — hence after y — deterministically,
//   - an insert anchored inside the chain while it was alive (between y
//     and b, or between b and d) stays inside the pre-deletion era,
//     before any post-deletion content.
// =====================================================================
console.log("POINT 1: tombstone chain remains y's right anchor");
{
  // senders chosen so post-era peer has the LOWEST id: if any ID tie-break
  // were involved, it would win and the test would fail.
  const base = new Doc("4");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 'b'); const b_up = base.pop();

  const p9 = new Doc("9");          // y between a and b
  p9.apply(a_up); p9.apply(b_up);
  p9.insert(1, 'y'); const y_up = p9.pop();

  const p8 = new Doc("8");          // d after b
  p8.apply(a_up); p8.apply(b_up);
  p8.insert(2, 'd'); const d_up = p8.pop();

  // peer "0" sees everything, deletes b and d, then types n at the end.
  const p0 = new Doc("0");
  [a_up, b_up, y_up, d_up].forEach(u => p0.apply(u));
  p0.del(2); const bdel = p0.pop();   // "aybd" -> delete b -> "ayd"
  p0.del(2); const ddel = p0.pop();   // "ayd" -> delete d -> "ay"
  p0.insert(2, 'n'); const n_up = p0.pop();

  // peer "1" saw "aybd" alive and typed m between y and b — pre-era.
  const p1 = new Doc("1");
  [a_up, b_up, y_up, d_up].forEach(u => p1.apply(u));
  p1.insert(2, 'm'); const m_up = p1.pop();

  // peer "2" saw "aybd" alive and typed w between b and d — pre-era.
  const p2 = new Doc("2");
  [a_up, b_up, y_up, d_up].forEach(u => p2.apply(u));
  p2.insert(3, 'w'); const w_up = p2.pop();

  // Expected: a y m b† w† d† n  → visible "aymwn".
  // Every pre-era insert (y, m, w) precedes the post-era n, in tombstone-
  // chain order, regardless of sender ids and merge order.
  expectAll([
    [a_up, b_up, y_up, d_up, bdel, ddel, n_up, m_up, w_up],
    [a_up, b_up, m_up, y_up, d_up, w_up, bdel, ddel, n_up],
    [a_up, b_up, y_up, d_up, bdel, m_up, ddel, w_up, n_up],
    [a_up, b_up, d_up, w_up, y_up, m_up, bdel, ddel, n_up],
  ], "aymwn", "pre-era y,m,w before post-era n");
}

// =====================================================================
// POINT 2 — the AYC requirement.
// Shared "ab". One peer deletes b then types c ("Order 2" / Path B).
// Another peer concurrently types y between a and b (RO=b).
// y belongs to b's era and stays before b†; c knew b was dead and anchors
// after b†. Result MUST be "ayc" — deterministically, for every sender
// assignment and merge order. (Previously this was an ID tie against the
// uninvolved tombstone b, giving "acy" for some sender ids.)
// =====================================================================
console.log("POINT 2 (Order 2: delete b, then insert c) — AYC determinism");
for (const [cSender, ySender] of [["1", "9"], ["9", "1"], ["5", "0"]]) {
  const base = new Doc("4");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 'b'); const b_up = base.pop();

  const pc = new Doc(cSender);
  pc.apply(a_up); pc.apply(b_up);
  pc.del(1); const bdel = pc.pop();
  pc.insert(1, 'c'); const c_up = pc.pop();

  const py = new Doc(ySender);
  py.apply(a_up); py.apply(b_up);
  py.insert(1, 'y'); const y_up = py.pop();

  expectAll([
    [a_up, b_up, bdel, c_up, y_up],
    [a_up, b_up, y_up, bdel, c_up],
    [a_up, b_up, y_up, c_up, bdel],
  ], "ayc", `senders c=${cSender}, y=${ySender}`);
}

// =====================================================================
// POINT 2 — Order 1 (insert c while b alive, then delete b).
// Here c:(a,b) and y:(a,b) are the SAME op shape — both typed into the
// same visible slot with the same knowledge. ID tie-break is the only
// information available; what matters is convergence across merge orders.
// =====================================================================
console.log("POINT 2 (Order 1: insert c, then delete b) — convergence");
{
  const base = new Doc("4");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 'b'); const b_up = base.pop();

  const pc = new Doc("1");
  pc.apply(a_up); pc.apply(b_up);
  pc.insert(1, 'c'); const c_up = pc.pop();
  pc.del(2); const bdel = pc.pop();

  const py = new Doc("9");
  py.apply(a_up); py.apply(b_up);
  py.insert(1, 'y'); const y_up = py.pop();

  expectConverge([
    [a_up, b_up, c_up, bdel, y_up],
    [a_up, b_up, y_up, c_up, bdel],
    [a_up, b_up, c_up, y_up, bdel],
  ], "same-slot concurrent c,y");
}

// =====================================================================
// POINT 2 — divergence over time (the test_lo2 construction).
// Both orders, with concurrent runs "xyz" (peer saw only a) and "w"
// (peer saw only a). Each order's op set must converge across merge
// orders, and the post-era c must never split a concurrent run.
// =====================================================================
console.log("POINT 2 — concurrent runs from peers who never saw b");
{
  const base = new Doc("0");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 'b'); const b_up = base.pop();

  // Order 2 ops by sender "1"
  const d2 = new Doc("1");
  d2.apply(a_up); d2.apply(b_up);
  d2.del(1); const bdel2 = d2.pop();
  d2.insert(1, 'c'); const c2 = d2.pop();

  // Run "xyz" by peer "3" who only saw a
  const p3 = new Doc("3");
  p3.apply(a_up);
  p3.insert(1, 'x'); const x_up = p3.pop();
  p3.insert(2, 'y'); const y_up = p3.pop();
  p3.insert(3, 'z'); const z_up = p3.pop();

  // "w" by peer "4" who only saw a
  const p4 = new Doc("4");
  p4.apply(a_up);
  p4.insert(1, 'w'); const w_up = p4.pop();

  const v = expectConverge([
    [a_up, b_up, c2, bdel2, x_up, y_up, z_up, w_up],
    [a_up, x_up, y_up, z_up, w_up, b_up, c2, bdel2],
    [a_up, b_up, bdel2, x_up, c2, y_up, z_up, w_up],
    [a_up, w_up, b_up, bdel2, c2, x_up, y_up, z_up],
  ], "order-2 + runs xyz, w");
  if (v !== null) {
    if (v.includes("xyz")) { console.log(`  ✅ run "xyz" contiguous in "${v}"`); pass++; }
    else { console.log(`  ❌ run "xyz" broken in "${v}"`); fail++; }
  }
}

// =====================================================================
// RIGHT-SIDE ERA — mirror of AYC on the other side of a tombstone.
// Doc "au". Peer types z AFTER u (saw u alive: z's anchor is alive-u).
// Another peer deletes u then types x after a. Both z and x end up in
// the same visible slot, but z belongs to u's era: "azx" — never "axz" —
// for every sender assignment.
// =====================================================================
console.log("RIGHT-SIDE ERA: continuation of u before post-deletion text");
for (const [xSender, zSender] of [["1", "9"], ["9", "1"]]) {
  const base = new Doc("4");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 'u'); const u_up = base.pop();

  const pz = new Doc(zSender);
  pz.apply(a_up); pz.apply(u_up);
  pz.insert(2, 'z'); const z_up = pz.pop();   // after u, while alive

  const px = new Doc(xSender);
  px.apply(a_up); px.apply(u_up);
  px.del(1); const udel = px.pop();
  px.insert(1, 'x'); const x_up = px.pop();   // knows u is dead

  expectAll([
    [a_up, u_up, z_up, udel, x_up],
    [a_up, u_up, udel, x_up, z_up],
  ], "azx", `senders x=${xSender}, z=${zSender}`);
}

// =====================================================================
// LEFT-CHILD ERA — the case that needs the afterTombstone bit.
// Doc "a t u m" (a chain). Concurrently:
//   peer 9: y between t and u (saw all alive)   → y < u†
//   peer 8: z between u and m (saw all alive)   → u† < z < m
//   peer 1: deletes t,u then types x in (a, m)  → after both tombstones
//             AND after z (z was anchored while u was alive).
// Both z and x become left children of m; only the era bit separates
// them. Expected "ayzxm".
// =====================================================================
console.log("LEFT-CHILD ERA: pre-deletion z before post-deletion x");
{
  const base = new Doc("0");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 't'); const t_up = base.pop();
  base.insert(2, 'u'); const u_up = base.pop();
  base.insert(3, 'm'); const m_up = base.pop();

  const p9 = new Doc("9");
  [a_up, t_up, u_up, m_up].forEach(u => p9.apply(u));
  p9.insert(2, 'y'); const y_up = p9.pop();

  const p8 = new Doc("8");
  [a_up, t_up, u_up, m_up].forEach(u => p8.apply(u));
  p8.insert(3, 'z'); const z_up = p8.pop();

  const p1 = new Doc("1");
  [a_up, t_up, u_up, m_up].forEach(u => p1.apply(u));
  p1.del(1); const tdel = p1.pop();
  p1.del(1); const udel = p1.pop();
  p1.insert(1, 'x'); const x_up = p1.pop();

  expectAll([
    [a_up, t_up, u_up, m_up, y_up, z_up, tdel, udel, x_up],
    [a_up, t_up, u_up, m_up, tdel, udel, x_up, y_up, z_up],
    [a_up, t_up, u_up, m_up, z_up, tdel, y_up, udel, x_up],
  ], "ayzxm", "era layering across the dead gap");
}

// =====================================================================
// ORIGINAL PHANTOM BARRIER — runs, both eras.
// Shared "AB". Peer deletes B then types "XYZ" (a post-era run).
// Concurrent peer types "UV" between A and B (pre-era run, RO=B).
// Expected "AUVXYZ": both runs contiguous, pre-era run first,
// regardless of senders.
// =====================================================================
console.log("PHANTOM BARRIER with runs on both sides of the deletion");
for (const [postSender, preSender] of [["1", "9"], ["9", "1"]]) {
  const base = new Doc("4");
  base.insert(0, 'A'); const a_up = base.pop();
  base.insert(1, 'B'); const b_up = base.pop();

  const post = new Doc(postSender);
  post.apply(a_up); post.apply(b_up);
  post.del(1); const bdel = post.pop();
  post.insert(1, 'X'); const x1 = post.pop();
  post.insert(2, 'Y'); const x2 = post.pop();
  post.insert(3, 'Z'); const x3 = post.pop();

  const pre = new Doc(preSender);
  pre.apply(a_up); pre.apply(b_up);
  pre.insert(1, 'U'); const v1 = pre.pop();
  pre.insert(2, 'V'); const v2 = pre.pop();

  expectAll([
    [a_up, b_up, bdel, x1, x2, x3, v1, v2],
    [a_up, b_up, v1, v2, bdel, x1, x2, x3],
    [a_up, b_up, v1, bdel, x1, v2, x2, x3],
  ], "AUVXYZ", `senders post=${postSender}, pre=${preSender}`);
}

// =====================================================================
// STACKED ERAS — delete, type, delete that, type again.
// "ab"; delete b; type p (after b†); delete p; type q.
// Each later era nests after the previous: a b† p† q → "aq", and a
// concurrent y:(a,b) still lands first: "ayq".
// =====================================================================
console.log("STACKED ERAS");
{
  const base = new Doc("4");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 'b'); const b_up = base.pop();

  const p0 = new Doc("0");
  p0.apply(a_up); p0.apply(b_up);
  p0.del(1); const bdel = p0.pop();
  p0.insert(1, 'p'); const p_up = p0.pop();
  p0.del(1); const pdel = p0.pop();
  p0.insert(1, 'q'); const q_up = p0.pop();

  const py = new Doc("9");
  py.apply(a_up); py.apply(b_up);
  py.insert(1, 'y'); const y_up = py.pop();

  expectAll([
    [a_up, b_up, bdel, p_up, pdel, q_up, y_up],
    [a_up, b_up, y_up, bdel, p_up, pdel, q_up],
  ], "ayq", "three stacked eras");
}

// =====================================================================
// FIGURE 7 — Matthew's reverse-RO case must be byte-identical to
// FugueMax: no tombstones involved, so nothing may change.
// =====================================================================
console.log("FIGURE 7 (regression: no-deletion behavior unchanged)");
{
  const dA = new Doc("0"); dA.insert(0, 'A'); const A_up = dA.pop();
  const dB = new Doc("1"); dB.insert(0, 'B'); const B_up = dB.pop();
  const dC = new Doc("2"); dC.insert(0, 'C'); const C_up = dC.pop();

  const r1 = new Doc("3");
  r1.apply(A_up); r1.apply(C_up);
  r1.insert(1, 'X'); const X_up = r1.pop();

  const r2 = new Doc("4");
  r2.apply(A_up); r2.apply(B_up);
  r2.insert(1, 'Y'); const Y_up = r2.pop();

  expectAll([
    [A_up, B_up, C_up, X_up, Y_up],
    [A_up, C_up, X_up, B_up, Y_up],
  ], "AXYBC", "reverse right-origin sibling order");
}

// =====================================================================
// TYPING PATTERNS ACROSS A DEAD GAP — forward, backward, and two peers.
// =====================================================================
console.log("TYPING PATTERNS across a dead gap");
{
  const base = new Doc("0");
  base.insert(0, 'a'); const a_up = base.pop();
  base.insert(1, 't'); const t_up = base.pop();
  base.insert(2, 'm'); const m_up = base.pop();
  base.del(1); const tdel = base.pop();

  // forward run by peer 1, backward run by peer 7, both post-era
  const p1 = new Doc("1");
  [a_up, t_up, m_up, tdel].forEach(u => p1.apply(u));
  p1.insert(1, '1'); const f1 = p1.pop();
  p1.insert(2, '2'); const f2 = p1.pop();
  p1.insert(3, '3'); const f3 = p1.pop();

  const p7 = new Doc("7");
  [a_up, t_up, m_up, tdel].forEach(u => p7.apply(u));
  p7.insert(1, '9'); const b3 = p7.pop();
  p7.insert(1, '8'); const b2 = p7.pop();
  p7.insert(1, '7'); const b1 = p7.pop();

  const v = expectConverge([
    [a_up, t_up, m_up, tdel, f1, f2, f3, b3, b2, b1],
    [a_up, t_up, m_up, tdel, b3, f1, b2, f2, b1, f3],
  ], "two post-era runs");
  if (v !== null) {
    const ok = v.includes("123") && v.includes("789") && v.startsWith("a") && v.endsWith("m");
    if (ok) { console.log(`  ✅ both runs contiguous: "${v}"`); pass++; }
    else { console.log(`  ❌ runs broken: "${v}"`); fail++; }
  }
}

// =====================================================================
// UWZX (adversarial, from the Fable review) — mixed-era right siblings
// with different rightOrigins. This is the case that breaks a
// reverse-RO-first comparator: post-era x has RO=e, pre-era z has RO=w,
// and w ≺ e, so reverse-RO alone would put x first ("xzwe"). Era-first
// sibling ordering must give "zxwe" — including when x's replica had
// synced the unrelated concurrent w before typing (S7: the merged order
// must not flip with the typer's sync state).
// =====================================================================
console.log("UWZX — era-first over reverse-RO, sync-robust");
for (const xSawW of [false, true]) {
  const e0 = new Doc("0"); e0.insert(0, "e"); const e_up = e0.pop();
  const u1 = new Doc("1"); u1.apply(e_up); u1.insert(0, "u"); const u_up = u1.pop();
  const w7 = new Doc("7"); w7.apply(e_up); w7.insert(0, "w"); const w_up = w7.pop();
  const z8 = new Doc("8"); [e_up, u_up, w_up].forEach(u => z8.apply(u)); z8.insert(1, "z"); const z_up = z8.pop();
  const x9 = new Doc("9");
  x9.apply(e_up); x9.apply(u_up);
  if (xSawW) x9.apply(w_up);
  x9.del(0); const udel = x9.pop();
  x9.insert(0, "x"); const x_up = x9.pop();
  // All delivery permutations of the concurrent updates.
  const baseOps = [e_up];
  const concurrentOps = [u_up, w_up, z_up, udel, x_up];
  const orders = [];
  const perm = (rest, acc) => {
    if (rest.length === 0) { orders.push([...baseOps, ...acc]); return; }
    for (let i = 0; i < rest.length; i++)
      perm(rest.slice(0, i).concat(rest.slice(i + 1)), [...acc, rest[i]]);
  };
  perm(concurrentOps, []);
  expectAll(orders, "zxwe", `UWZX xSawW=${xSawW}`);
}

// =====================================================================
// POINT1-minus-m — n typed at the end after deleting b and d; concurrent
// w typed between b and d while they were alive. The era principle puts
// w before n ("aywn"); this intentionally overrides forward
// non-interleaving (y and n need not be consecutive), which is the
// accepted trade for full era separation.
// =====================================================================
console.log("POINT1-minus-m — post-era content after the whole dead chain");
{
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const p9 = new Doc("9"); p9.apply(a_up); p9.apply(b_up); p9.insert(1, "y"); const y_up = p9.pop();
  const p8 = new Doc("8"); p8.apply(a_up); p8.apply(b_up); p8.insert(2, "d"); const d_up = p8.pop();
  const p0 = new Doc("0"); [a_up, b_up, y_up, d_up].forEach(u => p0.apply(u));
  p0.del(2); const bdel = p0.pop(); p0.del(2); const ddel = p0.pop();
  p0.insert(2, "n"); const n_up = p0.pop();
  const p2 = new Doc("2"); [a_up, b_up, y_up, d_up].forEach(u => p2.apply(u)); p2.insert(3, "w"); const w_up = p2.pop();
  const orders = [];
  const rest = [bdel, ddel, n_up, w_up];
  const perm = (r, acc) => {
    if (r.length === 0) { orders.push([a_up, b_up, y_up, d_up, ...acc]); return; }
    for (let i = 0; i < r.length; i++)
      perm(r.slice(0, i).concat(r.slice(i + 1)), [...acc, r[i]]);
  };
  perm(rest, []);
  expectAll(orders, "aywn", "post-era n after chain, w before n");
}

// =====================================================================
// PAYLOAD SYNCHRONY — the op bytes must not depend on which deletes the
// generator had synced (this is what distinguishes the receiver-side
// derivation from the previous generation-time fix). Two replicas at the
// same visible state, one having synced del(b) and one not, generate
// byte-identical insert ops (ignoring the fresh id). Same for
// insert-then-delete vs delete-then-insert orderings by the same user.
// =====================================================================
console.log("PAYLOAD SYNCHRONY — ops independent of delete-sync state");
{
  class Doc2 {
    constructor(id) {
      this.doc = new CRuntime({ debugReplicaID: id });
      this.ups = [];
      this.sent = [];
      this.doc.on("Send", (e) => {
        const u = new Uint8Array(e.message.length + 1);
        u.set(e.message);
        u[e.message.length] = 0;
        this.ups.push(u);
        const text = new TextDecoder().decode(e.message);
        const idx = text.indexOf('{"type":"insert"');
        if (idx >= 0) {
          let depth = 0, end = idx;
          for (let i = idx; i < text.length; i++) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          this.sent.push(JSON.parse(text.slice(idx, end)));
        }
      });
      this.arr = this.doc.registerCollab("array", (init) => new ListClass(init));
    }
    insert(idx, val) { this.doc.transact(() => this.arr.insert(idx, val)); }
    del(idx) { this.doc.transact(() => this.arr.delete(idx, 1)); }
    apply(u) { this.doc.receive(u.subarray(0, u.length - 1)); }
    pop() { return this.ups.shift(); }
  }
  const strip = (m) => JSON.stringify({ value: m.value, parent: m.parent, side: m.side, rightOrigin: m.rightOrigin ?? null });

  const base = new Doc2("0");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const delPeer = new Doc2("1");
  delPeer.apply(a_up); delPeer.apply(b_up);
  delPeer.del(1); const bdel = delPeer.pop();
  const pA = new Doc2("2");
  pA.apply(a_up); pA.apply(b_up); pA.apply(bdel);
  pA.insert(1, "c"); const cA = pA.sent[pA.sent.length - 1];
  const pB = new Doc2("3");
  pB.apply(a_up); pB.apply(b_up);
  pB.insert(1, "c"); const cB = pB.sent[pB.sent.length - 1];
  const d1 = new Doc2("8");
  d1.apply(a_up); d1.apply(b_up);
  d1.insert(1, "c"); const c1 = d1.sent[d1.sent.length - 1];
  d1.del(2);
  const d2 = new Doc2("9");
  d2.apply(a_up); d2.apply(b_up); d2.del(1);
  d2.insert(1, "c"); const c2 = d2.sent[d2.sent.length - 1];
  const allSame =
    strip(cA) === strip(cB) && strip(cA) === strip(c1) && strip(cA) === strip(c2);
  if (allSame) { console.log(`  ✅ all four payloads identical: ${strip(cA)}`); pass++; }
  else {
    console.log(`  ❌ payloads differ: sync=${strip(cA)}/${strip(cB)} order=${strip(c1)}/${strip(c2)}`);
    fail++;
  }
}

// =====================================================================
// T1 — concurrent slot content lands in the deleted slot (intended
// semantics, not interleaving). Author types p between a,b, backspaces b,
// types q; concurrent y typed between a,b. With b visible the intent
// order is p y b q, so the final order must be "apyq" (y in b's slot,
// between p and q) or "aypq" — p vs y is a genuine same-knowledge tie
// decided by ID; the y-before-q part is deterministic era separation.
// =====================================================================
console.log("T1 — slot content occupies the deleted slot");
for (const [ySender, expected] of [["9", "apyq"], ["0", "aypq"]]) {
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const p1 = new Doc("1");
  p1.apply(a_up); p1.apply(b_up);
  p1.insert(1, "p"); const p_up = p1.pop();
  p1.del(2); const bdel = p1.pop();
  p1.insert(2, "q"); const q_up = p1.pop();
  const py = new Doc(ySender);
  py.apply(a_up); py.apply(b_up);
  py.insert(1, "y"); const y_up = py.pop();
  expectAll([
    [a_up, b_up, p_up, bdel, q_up, y_up],
    [a_up, b_up, y_up, p_up, bdel, q_up],
    [a_up, b_up, p_up, y_up, bdel, q_up],
  ], expected, `T1 y=${ySender}`);
}

// =====================================================================
// T1′ — the same keystrokes, but the author received y BEFORE the
// backspace (screen "apyb" → "apy" → "apyq"). Era gives "apyq" again —
// the sync-invariant fixed point equal to the informed author's own
// screen. (Canonical flips to "apqy" when y is unseen, i.e., its outcome
// depends on delivery timing; era's does not.)
// =====================================================================
console.log("T1′ — era outcome is the sync-invariant fixed point");
{
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const py = new Doc("9");
  py.apply(a_up); py.apply(b_up);
  py.insert(1, "y"); const y_up = py.pop();
  const p1 = new Doc("1");
  p1.apply(a_up); p1.apply(b_up);
  p1.insert(1, "p"); const p_up = p1.pop();
  p1.apply(y_up);            // y arrives before the backspace
  p1.del(3); const bdel = p1.pop();
  p1.insert(3, "q"); const q_up = p1.pop();
  expectAll([
    [a_up, b_up, p_up, y_up, bdel, q_up],
    [a_up, b_up, y_up, p_up, bdel, q_up],
  ], "apyq", "T1′ informed author's screen");
}

// =====================================================================
// T3/T4 — same-transaction batches. A batch must produce the same tree
// as the equivalent unbatched sequence, on every replica: the runtime's
// sender VC entry covers same-transaction predecessors, so the era walk
// treats them as causally prior.
// =====================================================================
console.log("SAME-TRANSACTION batches");
{
  class DocBatch {
    constructor(id) {
      this.doc = new CRuntime({ debugReplicaID: id });
      this.ups = [];
      this.doc.on("Send", (e) => {
        const u = new Uint8Array(e.message.length + 1);
        u.set(e.message);
        u[e.message.length] = 0;
        this.ups.push(u);
      });
      this.arr = this.doc.registerCollab("array", (init) => new ListClass(init));
    }
    batch(fn) { this.doc.transact(fn); }
    apply(u) { this.doc.receive(u.subarray(0, u.length - 1)); }
    pop() { return this.ups.shift(); }
    get val() { return [...this.arr.values()].join(""); }
  }
  // T3: delete b and insert c in ONE transaction; concurrent y between a,b.
  // (One Send event per transaction: the batch's two ops share an envelope.)
  {
    const base = new DocBatch("4");
    base.batch(() => { base.arr.insert(0, "a"); });
    const a_up = base.pop();
    base.batch(() => { base.arr.insert(1, "b"); });
    const b_up = base.pop();
    const pc = new DocBatch("1");
    pc.apply(a_up); pc.apply(b_up);
    pc.batch(() => { pc.arr.delete(1, 1); pc.arr.insert(1, "c"); });
    const bdelc = pc.pop();
    const py = new DocBatch("9");
    py.apply(a_up); py.apply(b_up);
    py.batch(() => { py.arr.insert(1, "y"); });
    const y_up = py.pop();
    expectAll([
      [a_up, b_up, bdelc, y_up],
      [a_up, b_up, y_up, bdelc],
    ], "ayc", "T3 batched delete+insert");
  }
  // T4: batched x,y into the dead gap; y typed between a and x must stay
  // before x ("ayx") via the descendant branch, not the ID tie ("axy").
  {
    const base = new DocBatch("4");
    base.batch(() => { base.arr.insert(0, "a"); });
    const a_up = base.pop();
    base.batch(() => { base.arr.insert(1, "b"); });
    const b_up = base.pop();
    const pd = new DocBatch("1");
    pd.apply(a_up); pd.apply(b_up);
    pd.batch(() => { pd.arr.delete(1, 1); });
    const bdel = pd.pop();
    const pb = new DocBatch("9");
    pb.apply(a_up); pb.apply(b_up); pb.apply(bdel);
    pb.batch(() => { pb.arr.insert(1, "x"); pb.arr.insert(1, "y"); });
    const xy_up = pb.pop();
    expectAll([
      [a_up, b_up, bdel, xy_up],
      [a_up, b_up, xy_up, bdel],
    ], "ayx", "T4 batched inserts into dead gap");
  }
}

// =====================================================================
// GHOST COROLLARY (iv) — pre-era end-continuation concurrent with the
// post-era op (found by the independent review). Author who saw only "a"
// types x at the end (never saw the chain); another author deletes b and
// types B without having seen x. x may sit strictly between vLO(B)=a and
// B even though it matches none of the corollary's clauses (i)-(iii);
// clause (iv) sanctions it (eraRO(x) = end = eraRO(B)). The x-vs-chain
// order is ID-decided (x and b† are same-era siblings with RO=null):
// both outcomes are intent-correct — x's author put x at the end, B's
// author put B after a.
// =====================================================================
console.log("GHOST COROLLARY (iv) — end-continuation concurrent with the post-era op");
for (const [xSender, expected] of [["1", "axB"], ["9", "aBx"]]) {
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const px = new Doc(xSender);
  px.apply(a_up);
  px.insert(1, "x"); const x_up = px.pop();   // author never saw b
  const pB = new Doc("5");
  pB.apply(a_up); pB.apply(b_up);
  pB.del(1); const bdel = pB.pop();
  pB.insert(1, "B"); const B_up = pB.pop();   // author never saw x
  expectAll([
    [a_up, b_up, x_up, bdel, B_up],
    [a_up, b_up, bdel, B_up, x_up],
    [a_up, b_up, bdel, x_up, B_up],
  ], expected, `corollary(iv) x=${xSender}`);
}

// =====================================================================
// COROLLARY (iii)+(iv) — descendant of an (iv)-element (found by the
// final Fable review). Author who saw only "a" types x at the end
// (an (iv)-element); another author types v between a and x (descendant
// of the (iv)-element); a third deletes b and types B. v sits strictly
// between vLO(B)=a and B and is sanctioned only by the widened clause
// (iii): descendant of an (i)-, (ii)-, or (iv)-element. The x-vs-chain
// order is ID-decided; both outcomes keep the v-before-x pin intact.
// =====================================================================
console.log("COROLLARY (iii)+(iv) — descendant of an (iv)-element");
for (const [xSender, expected] of [["1", "avxB"], ["9", "aBvx"]]) {
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const px = new Doc(xSender);
  px.apply(a_up);
  px.insert(1, "x"); const x_up = px.pop();       // author never saw b
  const pv = new Doc("2");
  pv.apply(a_up); pv.apply(x_up);
  pv.insert(1, "v"); const v_up = pv.pop();       // between a and x
  const pB = new Doc("5");
  pB.apply(a_up); pB.apply(b_up);
  pB.del(1); const bdel = pB.pop();
  pB.insert(1, "B"); const B_up = pB.pop();       // author never saw x
  expectAll([
    [a_up, b_up, x_up, v_up, bdel, B_up],
    [a_up, b_up, bdel, B_up, x_up, v_up],
    [a_up, b_up, x_up, bdel, v_up, B_up],
    [a_up, b_up, bdel, x_up, v_up, B_up],
  ], expected, `corollary(iii+iv) x=${xSender}`);
}

// =====================================================================
// T8 — same-anchor post-era ops with different stop nodes. Pre-era m
// (sender 3) and n (sender 9) typed after b while alive; b deleted; x1
// knows {del b, m} and types between a and m; x2 knows {del b, n} and
// types between a and n; x3 knows {del b} only and types after a. The
// emergent rule: each post-era op sits immediately before the leftmost
// node it knew alive after its chain; pins dominate era.
// =====================================================================
console.log("T8 — same-anchor multi-stop, pins dominate era");
{
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const pm1 = new Doc("3");
  pm1.apply(a_up); pm1.apply(b_up);
  pm1.insert(2, "m"); const m1_up = pm1.pop();
  const pm2 = new Doc("9");
  pm2.apply(a_up); pm2.apply(b_up);
  pm2.insert(2, "n"); const m2_up = pm2.pop();
  const pdel = new Doc("5");
  pdel.apply(a_up); pdel.apply(b_up);
  pdel.del(1); const bdel = pdel.pop();
  const px1 = new Doc("6");
  [a_up, b_up, bdel, m1_up].forEach(u => px1.apply(u));
  px1.insert(1, "1"); const x1_up = px1.pop();
  const px2 = new Doc("7");
  [a_up, b_up, bdel, m2_up].forEach(u => px2.apply(u));
  px2.insert(1, "2"); const x2_up = px2.pop();
  const px3 = new Doc("8");
  [a_up, b_up, bdel].forEach(u => px3.apply(u));
  px3.insert(1, "3"); const x3_up = px3.pop();
  expectAll([
    [a_up, b_up, m1_up, m2_up, bdel, x1_up, x2_up, x3_up],
    [a_up, b_up, bdel, x3_up, m2_up, x2_up, m1_up, x1_up],
    [a_up, b_up, m2_up, bdel, x2_up, x1_up, m1_up, x3_up],
    [a_up, b_up, m1_up, x1_up, bdel, m2_up, x2_up, x3_up],
  ], "a1m2n3", "T8 same-anchor multi-stop");
}

// =====================================================================
// T9 — position pin overrides era: the typist knew del(b) but
// deliberately typed BEFORE pre-era y. x must land before y with era
// bit false (no chain crossed) — explicit pins dominate era layering.
// =====================================================================
console.log("T9 — pin override beats era knowledge");
{
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  const py = new Doc("9");
  py.apply(a_up); py.apply(b_up);
  py.insert(1, "y"); const y_up = py.pop();
  const pdel = new Doc("5");
  pdel.apply(a_up); pdel.apply(b_up);
  pdel.del(1); const bdel = pdel.pop();
  const px = new Doc("1");
  [a_up, b_up, y_up, bdel].forEach(u => px.apply(u));
  px.insert(1, "x"); const x_up = px.pop();
  expectAll([
    [a_up, b_up, y_up, bdel, x_up],
    [a_up, b_up, bdel, y_up, x_up],
    [a_up, b_up, bdel, x_up, y_up],
  ], "axy", "T9 pin override");
}

// =====================================================================
// T10 — post-era run typed BACKWARD (delete b, then type 9,8,7 always
// at the gap index) with concurrent pre-era y: the run stays contiguous
// and after y: "ay789m".
// =====================================================================
console.log("T10 — backward post-era run stays contiguous");
{
  const base = new Doc("4");
  base.insert(0, "a"); const a_up = base.pop();
  base.insert(1, "b"); const b_up = base.pop();
  base.insert(2, "m"); const m_up = base.pop();
  const p1 = new Doc("1");
  [a_up, b_up, m_up].forEach(u => p1.apply(u));
  p1.del(1); const bdel = p1.pop();
  p1.insert(1, "9"); const u9 = p1.pop();
  p1.insert(1, "8"); const u8 = p1.pop();
  p1.insert(1, "7"); const u7 = p1.pop();
  const py = new Doc("9");
  py.apply(a_up); py.apply(b_up); py.apply(m_up);
  py.insert(1, "y"); const y_up = py.pop();
  expectAll([
    [a_up, b_up, m_up, bdel, u9, u8, u7, y_up],
    [a_up, b_up, m_up, y_up, bdel, u9, u8, u7],
    [a_up, b_up, m_up, bdel, u9, y_up, u8, u7],
  ], "ay789m", "T10 backward post-era run");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 && !reportOnly ? 1 : 0);
