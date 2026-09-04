---
marp: true
theme: default
class: invert
paginate: true
---

> **Historical presentation draft.** The later Fugue-Era/RO-shifting proposals
> discussed in these slides are rejected research paths, not the current
> algorithm or a completed fix. See `SOLUTION.md` and the executable tombstone
> matrix for current status.

## Part 1: The Paper's Core Concepts

### The Interleaving Problem

When two users concurrently insert text at the same position, many CRDTs produce corrupted results:

```
User A: "milk" + "\neggs"  → "milk\n" + "eggs"
User B: "milk" + "\nbread" → "milk\n" + "bread"
Merged: "milk\n" + "ebgrgesad"  (interleaved!)
```

---

### Forward Non-Interleaving (Definition 2)

**Definition**: If element **A** is the left origin of **B**, and **B** appears earlier than any other element with left origin **A**, then **A** and **B** must be consecutive.

**Intuition**: Text typed forward (left-to-right) by one user should never be split apart.

**Example**: If User A types "abc", no other user's insertions should appear between 'a' and 'b' or 'b' and 'c'.

---

### Backward Non-Interleaving

**Definition**: Mirror of forward, using right origins instead.

**Example**: If User A prepends items to a list:
```
Initial: ""
User A: "item1\n" + "item2\n" + "Header:"
User B (concurrent): "bread"
```

Without backward non-interleaving: `"breadHeader:\nitem1\nitem2"`  
With it: `"Header:\nitem1\nitem2\nbread"` (clean separation)

---

### The Impossibility Result

**Figure 6 shows**: Forward and backward non-interleaving cannot both be satisfied in all cases.

```
3 replicas insert A, B, C concurrently
Replica 1: AX (inserts X between A and C)
Final order must be: AXBC
But: X's right origin is C, and X is last with that right origin
Backward non-interleaving would require X and C to be consecutive
```

**Conclusion**: We must prioritize one direction.

---

### Maximal Non-Interleaving (Definition 4)

A satisfiable correctness property that:

1. **Prioritizes forward non-interleaving** (condition 1)
2. **Provides backward non-interleaving when possible, with explicit exceptions** (condition 2 + Lemma 5)
3. **Orders concurrent inserts at exact same position by ID** (condition 3)

**Key innovation**: Explicitly defines when backward interleaving is unavoidable.

---

### Lemma 5: The Exception to Backward Non-Interleaving

**Lemma 5**: If A and B have different left origins, and there exists a C where:
- A.leftOrigin ≺ C ≺ B
- C is not a descendant of A.leftOrigin in the left-origin tree

Then A and B are **not required** to be consecutive.

**This is the formalization of "backward non-interleaving when possible"**

---

### The Fugue Algorithm

**Tree Structure**:
- Each node = one character
- Left/right children (not binary - multiple same-side siblings allowed)
- List order = depth-first in-order traversal

**Insert(i, x)**:
1. Find element at index i-1 (leftOrigin)
2. If leftOrigin has no right children → make x a right child
3. Else → make x a left child of next element (rightOrigin, **not skipping the tombstones**)

**Result**: Concurrent inserts at same position become same-side siblings.

---

### The FugueMax Modification

**Problem with Fugue**: Same-side siblings ordered by ID lexicographically, which may violate maximal non-interleaving in edge cases.

**FugueMax Fix**: Order right-side siblings by **reverse order of their right origins**, breaking ties by ID.

**Example**:
```
Figure 7 scenario: A, B, C inserted → A≺B≺C
X inserted (right origin C), Y inserted (right origin B)
FugueMax orders: Y before X (reverse right-origin order)
Result: AXYBC (satisfies maximal non-interleaving)
```

---

### Critical Detail: Right Origins INCLUDE Tombstones

**Algorithm 1, Line 24**:
```typescript
rightOrigin ← next node after leftOrigin in the tree traversal **that includes tombstones**
```

**Consequence**: A node can have its rightOrigin point to a deleted element at the time of insertion. This is notible different from the use of rightOrigin in other implementations of CRDTs, where rightOrigin is always a live (non-tombstoned) element.

---

## Part 2: The Critical Flaw in the Paper

### The Section 5.5 Claim

**Theorem 10**: "Let L be a replicated list algorithm that is maximally non-interleaving. Then L is semantically equivalent to FugueMax."

**The Flaw**: The *paper's definition* of FugueMax is **underspecified** - it describes the sorting rule but not how to handle tombstone metadata consistently.

**Result**: The described FugueMax is a **subset** of maximal non-interleaving implementations. It doesn't violate maximal non-interleaving, but it also doesn't fully implement all edge cases.

---

### The Implementation Gap: Mechanical vs Semantic

**Original FugueMax Logic**:
```typescript
// Order by reverse right-origin, tie-break on ID
if (node.rightOrigin > sibling.rightOrigin) break;
if (node.rightOrigin === sibling.rightOrigin && node.id > sibling.id) break;
```

**Issue**: This mechanically sorts by right-origin, but doesn't encode the **semantic distinction** needed for Lemma 5:

- **Expected rightOrigin**: Next element in traversal (local continuation)
- **Unexpected rightOrigin**: Different element due to concurrent insertions

**Without distinction**: Cannot correctly apply maximal non-interleaving invariants.

---

## Part 3: The Divergent Invarient Problem

### The Issue: Tombstone-Induced Metadata Variance

**Case 1 (Delete synced first)**:
```
1. Replica A inserts Y after B
2. Replica B deletes B (already synced to A)
3. When A inserts Y: rightOrigin = tombstone B
```

**Case 2 (Delete synced later)**:
```
1. Replica A inserts Y after B
2. Replica B deletes B (not yet synced to A)
3. When A inserts Y: rightOrigin = next live element (e.g., C)
4. Later, delete syncs
```

**Result**: Same insertion gets different metadata → Different ordering → Divergent invarient

---

### Why This Violates Maximal Non-Interleaving

**Lemma 5's exceptions depend on accurate rightOrigin metadata** to determine:
- Whether rightOrigin is "expected" vs "unexpected"
- Whether exception conditions (i, ii) are met

**Metadata inconsistency across replicas** means:
- Same logical insertion evaluated differently
- Different decisions about backward non-interleaving
- **Final orders diverge (but all peers still see the same content, i.g. this is an invarient)**

---

### Commit 1: 38d2486 - The Semantic Fix

#### Added Expected Right Origin Comparison

```typescript
// NEW: Distinguish expected vs unexpected right origins
const expectedRightOrigin = this.nextNonDescendant(parent);
const nodeMatchesExpected = node.rightOrigin === expectedRightOrigin;
const sibMatchesExpected = rightSibs[i].rightOrigin === expectedRightOrigin;

// ORDER: [unexpected...sorted by id] + [expected...sorted by id]
if (nodeMatchesExpected && !sibMatchesExpected) break; // Expected after unexpected
if (!nodeMatchesExpected && sibMatchesExpected) continue; // Unexpected before expected
if (node.id.sender > rightSibs[i].id.sender) break; // Tie-break
```

**This implements the semantic invariant**: Concurrent insertions (unexpected rightOrigin) must precede local continuations (expected rightOrigin).

---

## Part 4: The Convergence Fix

### Commit 2: 97546ab - Making Metadata Consistent

#### Change 1: Skip Tombstones When Computing rightOrigin

```typescript
nextNonDescendantSkipTombstones(node): Node {
  let current = this.nextNonDescendant(node);
  while (current && current.isDeleted) {
    current = this.nextNonDescendant(current);
  }
  return current;
}

// On insert:
const rightOrigin = this.nextNonDescendantSkipTombstones(leftOrigin);
```

**Effect**: rightOrigin always points to a **live** element, regardless of delete sync order.

---

#### Change 2: Shift Right Origins on Delete

```typescript
updateRightOriginsOnDelete(deletedNode): void {
  const newRightOrigin = this.nextNonDescendantSkipTombstones(deletedNode);
  
  // Walk backwards, update nodes that referenced deletedNode
  let current = deletedNode;
  const stopAt = this.previousNonDescendant(deletedNode);
  
  while (current && current !== stopAt) {
    if (current.rightOrigin === deletedNode) {
      current.rightOrigin = newRightOrigin;
    }
    current = this.previousNonDescendant(current);
  }
}

// On delete:
node.isDeleted = true;
this.tree.updateRightOriginsOnDelete(node);
```

**Effect**: All existing rightOrigin references remain consistent when deletes arrive.

---

### The Combined Effect

| Sync Order | Before Fix | After Fix |
|------------|------------|-----------|
| Delete first | rightOrigin = tombstone → wrong ordering | Skips tombstone → correct |
| Delete last | metadata becomes stale → wrong ordering | Updated on delete → correct |

**Result**: Deterministic convergence regardless of operation delivery order.

---

### Impact on Maximal Non-Interleaving

With consistent metadata, **Lemma 5 exceptions can be correctly applied**:
- All replicas agree on whether rightOrigin is expected/unexpected
- Decisions about backward interleaving are uniform
- **Convergence + maximal non-interleaving guarantees**

---

## Part 5: Revised Definition 4

### Definition 4 (Implementation-Corrected)

A replicated list algorithm is maximally non-interleaving if it satisfies:

1. **Forward non-interleaving** (as before)

2. **Backward non-interleaving with Lemma 5 exceptions**, which require:
   - **Tombstone-aware rightOrigins**: Must reference the *next live element*, not tombstones
   - **Sync-order independence**: Metadata must be consistent regardless of operation delivery order
   - **Explicit expected/unexpected distinction**: Must differentiate local continuations from concurrent insertions

3. **ID-based tie-breaking** (as before)

---

## Part 6: Test Case Analysis

```javascript
// Replicas: A(0), B(1), C(2), D(3)
1. Concurrent inserts: A, B, C, D
2. B deletes B
3. R1 receives B + delete BEFORE inserting Y
4. R1 inserts Y after A
5. R3 inserts X between A and C
6. R4 inserts Z between A and D
7. Final merge: "AXYZCD"
```

**What this tests**:
- Case 3: Y inserted when delete of B already synced
- Without fix: Y.rightOrigin = tombstone B (unexpected)
- With fix: Y.rightOrigin = C (expected, next live)
- Ensures X, Z (unexpected) ordered before Y (expected)

---
