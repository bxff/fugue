import { CPrimitive, InitToken, MessageMeta } from "@collabs/collabs";
import pako from "pako";

const GZIP = true;

interface ID {
  sender: string;
  counter: number;
}

interface Node<T> {
  /** For the root, this is ("", 0). */
  id: ID;
  value: T | null;
  isDeleted: boolean;
  /**
   * null when this is the root.
   * For convenience, we store a pointer to the parent instead of just
   * its ID.
   */
  parent: Node<T> | null;
  side: "L" | "R";
  // For traversals, store the children in sorted order.
  leftChildren: Node<T>[];
  rightChildren: Node<T>[];
  /**
   * The non-deleted size of the subtree rooted at this node.
   *
   * This is technically an optimization, but an easy & impactful one.
   */
  size: number;
  /**
   * Our rightOrigin, if we're a right-side child.
   * null = our rightOrigin is the end of the list;
   * unset = we're not a right-side child.
   */
  rightOrigin?: Node<T> | null;
}

interface InsertMessage<T> {
  type: "insert";
  id: ID;
  value: T;
  parent: ID;
  side: "L" | "R";
  rightOrigin?: ID | null;
}

interface DeleteMessage {
  type: "delete";
  id: ID;
}

interface NodeSave<T> {
  value: T | null;
  isDeleted: boolean;
  parent: ID | null;
  side: "L" | "R";
  size: number;
  rightOrigin?: ID | null;
}

class Tree<T> {
  readonly root: Node<T>;
  /**
   * Used in getByID.
   *
   * Map from ID.sender, to an array that maps ID.counter, to node with that ID.
   */
  private readonly nodesByID = new Map<string, Node<T>[]>();

  constructor() {
    this.root = {
      id: { sender: "", counter: 0 },
      value: null,
      isDeleted: true,
      parent: null,
      side: "R",
      leftChildren: [],
      rightChildren: [],
      size: 0,
    };
    this.nodesByID.set("", [this.root]);
  }

  addNode(
    id: ID,
    value: T,
    parent: Node<T>,
    side: "L" | "R",
    rightOriginID?: ID | null
  ): Node<T> {
    const node: Node<T> = {
      id,
      value,
      isDeleted: false,
      parent,
      side,
      leftChildren: [],
      rightChildren: [],
      size: 0,
    };
    if (rightOriginID !== undefined) {
      // Store the rightOrigin as sent, even if it is (or later becomes) a
      // tombstone. Tombstones never move in the tree, so they remain valid
      // ordering anchors; rewriting them would destroy the structural
      // information that encodes the inserter's intent.
      node.rightOrigin =
        rightOriginID === null ? null : this.getByID(rightOriginID);
    }

    // Add to nodesByID.
    let bySender = this.nodesByID.get(id.sender);
    if (bySender === undefined) {
      bySender = [];
      this.nodesByID.set(id.sender, bySender);
    }
    bySender.push(node);

    // Insert into parent's siblings.
    this.insertIntoSiblings(node);

    this.updateSize(node, 1);
    return node;
  }

  private insertIntoSiblings(node: Node<T>) {
    // Insert node among its same-side siblings.
    const parent = node.parent!;
    if (node.side === "R") {
      const rightSibs = parent.rightChildren;
      // Published FugueMax ordering: reverse right-origin order, followed
      // by the immutable operation ID. Deletion knowledge never overrides
      // this structural ordering.
      let i = 0;
      for (; i < rightSibs.length; i++) {
        if (
          !(
            this.isLess(node.rightOrigin!, rightSibs[i].rightOrigin!) ||
            (node.rightOrigin === rightSibs[i].rightOrigin &&
              node.id.sender > rightSibs[i].id.sender)
          )
        )
          break;
      }
      rightSibs.splice(i, 0, node);
    } else {
      const leftSibs = parent.leftChildren;
      // Published FugueMax ordering for left siblings: immutable ID.
      let i = 0;
      for (; i < leftSibs.length; i++) {
        if (
          !(node.id.sender > leftSibs[i].id.sender)
        )
          break;
      }
      leftSibs.splice(i, 0, node);
    }
  }

  /**
   * Returns whether a < b in the existing list order.
   *
   * null values are treated as the end of the list.
   */
  isLess(a: Node<T> | null, b: Node<T> | null): boolean {
    if (a === b) return false;
    if (a === null) return false;
    if (b === null) return true;

    // Walk one node up the tree until they are both the same depth.
    const aDepth = this.depth(a);
    const bDepth = this.depth(b);
    let aAnc = a;
    let bAnc = b;
    if (aDepth > bDepth) {
      let lastSide: "L" | "R";
      for (let i = aDepth; i > bDepth; i--) {
        lastSide = aAnc.side;
        aAnc = aAnc.parent!;
      }
      if (aAnc === b) {
        // a is a descendant of b on lastSide.
        return lastSide! === "L";
      }
    }
    if (bDepth > aDepth) {
      let lastSide: "L" | "R";
      for (let i = bDepth; i > aDepth; i--) {
        lastSide = bAnc.side;
        bAnc = bAnc.parent!;
      }
      if (bAnc === a) {
        // b is a descendant of a on lastSide.
        return lastSide! === "R";
      }
    }

    // Walk both nodes up the tree until we find a common ancestor.
    while (aAnc.parent !== bAnc.parent) {
      // If we reach the root, the loop will terminate, so both parents
      // are non-null here.
      aAnc = aAnc.parent!;
      bAnc = bAnc.parent!;
    }
    // Now aAnc and bAnc are distinct siblings. See how they are sorted
    // in their parent's child arrays.
    if (aAnc.side !== bAnc.side) return aAnc.side === "L";
    else {
      const siblings =
        aAnc.side === "L"
          ? aAnc.parent!.leftChildren
          : aAnc.parent!.rightChildren;
      return siblings.indexOf(aAnc) < siblings.indexOf(bAnc);
    }
  }

  /**
   * Returns node's depth in the tree. Root = depth 0.
   */
  private depth(node: Node<T>): number {
    let depth = 0;
    for (
      let current = node;
      current.parent !== null;
      current = current.parent
    ) {
      depth++;
    }
    return depth;
  }

  /**
   * Adds delta to the sizes of node and all of its ancestors.
   */
  updateSize(node: Node<T>, delta: number) {
    for (let anc: Node<T> | null = node; anc !== null; anc = anc.parent) {
      anc.size += delta;
    }
  }

  getByID(id: ID): Node<T> {
    const bySender = this.nodesByID.get(id.sender);
    if (bySender !== undefined) {
      const node = bySender[id.counter];
      if (node !== undefined) return node;
    }
    throw new Error("Unknown ID: " + JSON.stringify(id));
  }

  /**
   * Returns the node at the given index within node's subtree.
   */
  getByIndex(node: Node<T>, index: number): Node<T> {
    if (index < 0 || index >= node.size) {
      throw new Error(
        "Index out of range: " + index + " (size: " + node.size + ")"
      );
    }

    // A recursive approach would be simpler, but overflows the stack at modest
    // depths (~4000). So we do an iterative approach instead.
    let remaining = index;
    recurse: while (true) {
      for (const child of node.leftChildren) {
        if (remaining < child.size) {
          node = child;
          continue recurse;
        }
        remaining -= child.size;
      }
      if (!node.isDeleted) {
        if (remaining === 0) return node;
        remaining--;
      }
      for (const child of node.rightChildren) {
        if (remaining < child.size) {
          node = child;
          continue recurse;
        }
        remaining -= child.size;
      }
      throw new Error("Index in range but not found");
    }
  }

  /**
   * Returns the leftmost left-only descendant of node, i.e., the
   * first left child of the first left child ... of node.
   */
  leftmostDescendant(node: Node<T>): Node<T> {
    let desc = node;
    for (; desc.leftChildren.length !== 0; desc = desc.leftChildren[0]) { }
    return desc;
  }

  /**
   * Returns whether node is a (strict or non-strict) descendant of anc.
   */
  isDescendant(node: Node<T>, anc: Node<T>): boolean {
    for (let cur: Node<T> | null = node; cur !== null; cur = cur.parent) {
      if (cur === anc) return true;
    }
    return false;
  }

  /**
   * Returns the next node in the traversal that is *not* a
   * descendant of node, or null if that is the end. Includes tombstones.
   */
  nextNonDescendant(node: Node<T>): Node<T> | null {
    let current = node;
    while (current.parent !== null) {
      const siblings =
        current.side === "L"
          ? current.parent.leftChildren
          : current.parent.rightChildren;
      const index = siblings.indexOf(current);
      if (index < siblings.length - 1) {
        // The next sibling's subtree immediately follows current's subtree.
        // Find its leftmost element.
        const nextSibling = siblings[index + 1];
        return this.leftmostDescendant(nextSibling);
      } else if (current.side === "L") {
        // The parent immediately follows current's subtree.
        return current.parent;
      }
      current = current.parent;
    }
    // We've reached the root without finding any further-right subtrees.
    return null;
  }

  /**
   * Returns the node immediately after node in the traversal, including
   * tombstones, or null if node is the last node.
   */
  nextInTraversal(node: Node<T>): Node<T> | null {
    if (node.rightChildren.length !== 0) {
      return this.leftmostDescendant(node.rightChildren[0]);
    }
    return this.nextNonDescendant(node);
  }

  /**
   * Returns the transitive structural support of all visible nodes.
   *
   * Parent and right-origin edges are immutable FugueMax dependencies. A dead
   * node reached through either edge still participates in the position of
   * surviving content; an unreachable dead node is observational history.
   */
  liveDependencyClosure(): Set<Node<T>> {
    const closure = new Set<Node<T>>();
    const pending: Node<T>[] = [];
    for (const bySender of this.nodesByID.values()) {
      for (const node of bySender) {
        if (!node.isDeleted) pending.push(node);
      }
    }
    while (pending.length !== 0) {
      const node = pending.pop()!;
      if (closure.has(node)) continue;
      closure.add(node);
      if (node.parent !== null) pending.push(node.parent);
      if (node.rightOrigin !== undefined && node.rightOrigin !== null) {
        pending.push(node.rightOrigin);
      }
    }
    return closure;
  }

  *traverse(node: Node<T>): IterableIterator<T> {
    // A recursive approach (like in the paper) would be simpler,
    // but overflows the stack at modest
    // depths (~4000). So we do an iterative approach instead.

    let current = node;
    // Stack records the next child to visit for that node.
    // We don't need to store node because we can infer it from the
    // current node's parent etc.
    const stack: { side: "L" | "R"; childIndex: number }[] = [
      { side: "L", childIndex: 0 },
    ];
    while (true) {
      const top = stack[stack.length - 1];
      const children =
        top.side === "L" ? current.leftChildren : current.rightChildren;
      if (top.childIndex === children.length) {
        // We are done with the children on top.side.
        if (top.side === "L") {
          // Visit us, then move to right children.
          if (!current.isDeleted) yield current.value!;
          top.side = "R";
          top.childIndex = 0;
        } else {
          // Go to the parent.
          if (current.parent === null) return;
          current = current.parent;
          stack.pop();
        }
      } else {
        const child = children[top.childIndex];
        // Save for later that we need to visit the next child.
        top.childIndex++;
        if (child.size > 0) {
          // Traverse child.
          current = child;
          stack.push({ side: "L", childIndex: 0 });
        }
      }
    }
  }

  save(): Uint8Array {
    // Convert nodesByID into JSON format, also converting each Node into a NodeSave.
    const save: { [sender: string]: NodeSave<T>[] } = {};
    for (const [sender, bySender] of this.nodesByID) {
      save[sender] = bySender.map((node) => {
        const nodeSave: NodeSave<T> = {
          value: node.value,
          isDeleted: node.isDeleted,
          parent: node.parent === null ? null : node.parent.id,
          side: node.side,
          size: node.size,
        };
        if (node.rightOrigin !== undefined) {
          nodeSave.rightOrigin =
            node.rightOrigin === null ? null : node.rightOrigin.id;
        }
        return nodeSave;
      });
    }
    return new Uint8Array(Buffer.from(JSON.stringify(save)));
  }

  load(saveData: Uint8Array) {
    const save: { [sender: string]: NodeSave<T>[] } = JSON.parse(
      Buffer.from(saveData).toString()
    );
    // First create all nodes without pointers to other nodes (parent, children,
    // rightOrigin).
    for (const [sender, bySenderSave] of Object.entries(save)) {
      if (sender === "") {
        // Root node. Just set its size.
        this.root.size = bySenderSave[0].size;
        continue;
      }
      this.nodesByID.set(
        sender,
        bySenderSave.map((nodeSave, counter) => ({
          id: { sender, counter },
          parent: null,
          value: nodeSave.value,
          isDeleted: nodeSave.isDeleted,
          side: nodeSave.side,
          size: nodeSave.size,
          leftChildren: [],
          rightChildren: [],
        }))
      );
    }
    // Next, fill in the parent and rightOrigin pointers.
    for (const [sender, bySender] of this.nodesByID) {
      if (sender === "") continue;
      const bySenderSave = save[sender]!;
      for (let i = 0; i < bySender.length; i++) {
        const node = bySender[i];
        const nodeSave = bySenderSave[i];
        if (nodeSave.parent !== null) {
          node.parent = this.getByID(nodeSave.parent);
        }
        if (nodeSave.rightOrigin !== undefined) {
          node.rightOrigin =
            nodeSave.rightOrigin === null
              ? null
              : this.getByID(nodeSave.rightOrigin);
        }
      }
    }

    // Finally, call insertIntoSiblings on each node to fill in the children
    // arrays.
    // We must be careful to wait until after doing so for node.rightOrigin
    // and its ancestors, since insertIntoSiblings references the existing list order
    // on node.rightOrigin.

    // Nodes go from "pending" -> "ready" (rightOrigin valid) ->
    // "valid" (insertIntoSiblings called).
    // readyNodes is a stack; pendingNodes maps from a node to its dependencies.
    const readyNodes: Node<T>[] = [];
    const pendingNodes = new Map<Node<T>, Node<T>[]>();
    for (const [sender, bySender] of this.nodesByID) {
      if (sender === "") continue;
      for (let i = 0; i < bySender.length; i++) {
        const node = bySender[i];
        if (node.rightOrigin === undefined || node.rightOrigin === null) {
          // rightOrigin not used or is the root; node is ready.
          readyNodes.push(node);
        } else {
          let pendingArr = pendingNodes.get(node.rightOrigin);
          if (pendingArr === undefined) {
            pendingArr = [];
            pendingNodes.set(node.rightOrigin, pendingArr);
          }
          pendingArr.push(node);
        }
      }
    }

    while (readyNodes.length !== 0) {
      const node = readyNodes.pop()!;
      this.insertIntoSiblings(node);
      // node's dependencies are now ready.
      const deps = pendingNodes.get(node);
      if (deps !== undefined) readyNodes.push(...deps);
      pendingNodes.delete(node);
    }
    if (pendingNodes.size !== 0) {
      throw new Error("Internal error: failed to validate all nodes");
    }
  }
}

export class FugueMaxSimple<T> extends CPrimitive {
  private counter = 0;
  private tree: Tree<T>;

  constructor(init: InitToken) {
    super(init);

    this.tree = new Tree();
  }

  insert(index: number, ...values: T[]): void {
    for (let i = 0; i < values.length; i++) {
      this.insertOne(index + i, values[i]);
    }
  }

  /**
   * Atomically expresses replacement intent at the list API boundary.
   *
   * Replacement insertions are anchored while the deleted range is still
   * live, then the captured target nodes are tombstoned.  The emitted wire
   * operations are ordinary FugueMax inserts and deletes; their coordinates
   * therefore do not depend on transport handoff timing.
   */
  splice(startIndex: number, deleteCount = this.length - startIndex, ...values: T[]): void {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > this.length) {
      throw new Error("startIndex out of bounds");
    }
    if (!Number.isSafeInteger(deleteCount) || deleteCount < 0) {
      throw new Error("deleteCount must be a nonnegative integer");
    }
    deleteCount = Math.min(deleteCount, this.length - startIndex);

    // Capture identities, not shifted indices: inserting the replacement run
    // first changes visible indices but must not change which nodes are removed.
    const targets: Node<T>[] = [];
    for (let i = 0; i < deleteCount; i++) {
      targets.push(this.tree.getByIndex(this.tree.root, startIndex + i));
    }

    this.insert(startIndex, ...values);
    for (const target of targets) this.deleteNode(target);
  }

  private insertOne(index: number, value: T) {
    // Insert into the author's visible projection. Dead nodes are transparent
    // when choosing new origins, so merely learning an already-dead node cannot
    // change the emitted operation. They remain physically present in the
    // replicated tree for existing and in-flight structural references.
    const id = { sender: this.runtime.replicaID, counter: this.counter };
    this.counter++;
    const leftOrigin =
      index === 0
        ? this.tree.root
        : this.tree.getByIndex(this.tree.root, index - 1);

    const liveDependencyClosure = this.tree.liveDependencyClosure();
    const isProjectedNode = (node: Node<T>) =>
      !node.isDeleted || liveDependencyClosure.has(node);

    // Find the next node after leftOrigin in the projected traversal. Skipped
    // tombstones are not erased from the replicated tree; they are ignored
    // only while generating this new immutable insertion.
    let projectedNext = this.tree.nextInTraversal(leftOrigin);
    while (projectedNext !== null && !isProjectedNode(projectedNext)) {
      projectedNext = this.tree.nextInTraversal(projectedNext);
    }

    let msg: InsertMessage<T>;
    if (
      projectedNext === null ||
      !this.tree.isDescendant(projectedNext, leftOrigin)
    ) {
      // No projected right descendant: use the normal right-child encoding,
      // with the next projected node as the stable right-origin bucket.
      msg = {
        type: "insert",
        id,
        value,
        parent: leftOrigin.id,
        side: "R",
        rightOrigin: projectedNext === null ? null : projectedNext.id,
      };
    } else {
      // The projected successor lies in leftOrigin's first surviving right
      // subtree. Insert immediately before it, as a left child.
      msg = {
        type: "insert",
        id,
        value,
        parent: projectedNext.id,
        side: "L",
      };
    }

    // Message is delivered to receivePrimitive ("on delivering" function).
    super.sendPrimitive(JSON.stringify(msg));
  }

  delete(startIndex: number, count = 1): void {
    for (let i = 0; i < count; i++) this.deleteOne(startIndex);
  }

  private deleteOne(index: number): void {
    // delete generator.
    const node = this.tree.getByIndex(this.tree.root, index);
    this.deleteNode(node);
  }

  private deleteNode(node: Node<T>): void {
    const msg: DeleteMessage = { type: "delete", id: node.id };
    // Message is delivered to receivePrimitive ("on delivering" function).
    super.sendPrimitive(JSON.stringify(msg));
  }

  protected receivePrimitive(
    message: Uint8Array | string,
    meta: MessageMeta
  ): void {
    const msg: InsertMessage<T> | DeleteMessage = JSON.parse(<string>message);
    switch (msg.type) {
      case "insert": {
        this.tree.addNode(
          msg.id,
          msg.value,
          this.tree.getByID(msg.parent),
          msg.side,
          msg.rightOrigin
        );
        // In a production implementation, we would emit an Insert event here.
        break;
      }
      case "delete": {
        // delete effector. Deletion only toggles visibility: the node stays
        // in the tree at the same position and remains a valid ordering
        // anchor for any node whose rightOrigin references it.
        const node = this.tree.getByID(msg.id);
        if (!node.isDeleted) {
          node.value = null;
          node.isDeleted = true;
          this.tree.updateSize(node, -1);
          // In a production implementation, we would emit a Delete event here.
        }
        break;
      }
      default:
        throw new Error("Bad message: " + msg);
    }
  }

  get(index: number): T {
    if (index < 0 || index >= this.length) {
      throw new Error("index out of bounds: " + index);
    }
    const node = this.tree.getByIndex(this.tree.root, index);
    return node.value!;
  }

  values(): IterableIterator<T> {
    return this.tree.traverse(this.tree.root);
  }

  get length(): number {
    return this.tree.root.size;
  }

  savePrimitive(): Uint8Array {
    // No need to save this.counter because we will have a different
    // replicaID next time.
    let bytes = this.tree.save();
    if (GZIP) {
      bytes = pako.gzip(bytes);
    }
    return bytes;
  }

  loadPrimitive(savedState: Uint8Array | null): void {
    if (savedState === null) return;

    if (GZIP) {
      savedState = pako.ungzip(savedState);
    }
    this.tree.load(savedState);
  }
}
