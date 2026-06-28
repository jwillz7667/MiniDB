import { NODE_INTERNAL, NODE_LEAF, USABLE_PAGE_SIZE } from "../constants.js";
import { BTreeError } from "../errors.js";
import type { Rid } from "./rid.js";
import type { Tx } from "./tx.js";

/**
 * An on-disk B+Tree keyed by a signed 64-bit integer. To support non-unique
 * secondary indexes without the pain of equal keys straddling a leaf split,
 * entries are ordered by the COMPOSITE (key, rid). Because every row has a
 * unique rid, composite keys are globally unique, so leaf splits never separate
 * "equal" keys and the classic duplicate-key edge cases disappear. A point
 * lookup for `key = X` is simply a range scan over the composite span
 * [(X, minRid) .. (X, maxRid)] — every row carrying value X, in rid order.
 *
 * Deletion is tombstone-only (the entry's deleted bit is set); nodes are never
 * merged or rebalanced and slots are never reclaimed. This is a deliberate,
 * documented limitation — real systems defer the same work to vacuum.
 */

// ---- Node byte layout (offsets within a page) -----------------------------
//
// Common header: u8 nodeType, u16 keyCount.
// Leaf:     [next:u32] then keyCount × [key:i64, deleted:u8, ridPage:u32, ridSlot:u16]
// Internal: [child0:u32] then keyCount × [key:i64, ridPage:u32, ridSlot:u16, child:u32]
const TYPE_OFFSET = 0;
const COUNT_OFFSET = 1;
const LEAF_NEXT_OFFSET = 3;
const LEAF_ENTRIES_OFFSET = 7; // 1 + 2 + 4
const LEAF_ENTRY_SIZE = 15; // i64 + u8 + u32 + u16
const INTERNAL_CHILD0_OFFSET = 3;
const INTERNAL_ENTRIES_OFFSET = 7; // 1 + 2 + 4
const INTERNAL_ENTRY_SIZE = 18; // i64 + u32 + u16 + u32

/** Max entries that fit in a leaf / max separators that fit in an internal node. */
export const LEAF_CAPACITY = Math.floor((USABLE_PAGE_SIZE - LEAF_ENTRIES_OFFSET) / LEAF_ENTRY_SIZE);
export const INTERNAL_CAPACITY = Math.floor(
  (USABLE_PAGE_SIZE - INTERNAL_ENTRIES_OFFSET) / INTERNAL_ENTRY_SIZE,
);

/** Smallest / largest possible rid, used to turn a key span into a composite span. */
export const MIN_RID: Rid = { pageNo: 0, slot: 0 };
export const MAX_RID: Rid = { pageNo: 0xffffffff, slot: 0xffff };

interface LeafNode {
  readonly kind: "leaf";
  keys: bigint[];
  rids: Rid[];
  deleted: boolean[];
  next: number;
}

interface InternalNode {
  readonly kind: "internal";
  keys: bigint[];
  rids: Rid[];
  children: number[]; // length === keys.length + 1
}

type Node = LeafNode | InternalNode;

/** Order two composite keys (key first, then rid). Returns <0, 0, or >0. */
function compareComposite(aKey: bigint, aRid: Rid, bKey: bigint, bRid: Rid): number {
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  if (aRid.pageNo !== bRid.pageNo) return aRid.pageNo - bRid.pageNo;
  return aRid.slot - bRid.slot;
}

function decodeNode(page: Buffer): Node {
  const type = page.readUInt8(TYPE_OFFSET);
  const count = page.readUInt16LE(COUNT_OFFSET);
  if (type === NODE_LEAF) {
    const keys: bigint[] = new Array(count);
    const rids: Rid[] = new Array(count);
    const deleted: boolean[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const off = LEAF_ENTRIES_OFFSET + i * LEAF_ENTRY_SIZE;
      keys[i] = page.readBigInt64LE(off);
      deleted[i] = page.readUInt8(off + 8) !== 0;
      rids[i] = { pageNo: page.readUInt32LE(off + 9), slot: page.readUInt16LE(off + 13) };
    }
    return { kind: "leaf", keys, rids, deleted, next: page.readUInt32LE(LEAF_NEXT_OFFSET) };
  }
  if (type === NODE_INTERNAL) {
    const keys: bigint[] = new Array(count);
    const rids: Rid[] = new Array(count);
    const children: number[] = new Array(count + 1);
    children[0] = page.readUInt32LE(INTERNAL_CHILD0_OFFSET);
    for (let i = 0; i < count; i++) {
      const off = INTERNAL_ENTRIES_OFFSET + i * INTERNAL_ENTRY_SIZE;
      keys[i] = page.readBigInt64LE(off);
      rids[i] = { pageNo: page.readUInt32LE(off + 8), slot: page.readUInt16LE(off + 12) };
      children[i + 1] = page.readUInt32LE(off + 14);
    }
    return { kind: "internal", keys, rids, children };
  }
  throw new BTreeError(`unknown B+Tree node type tag ${type}`);
}

function encodeLeaf(node: LeafNode, page: Buffer): void {
  const n = node.keys.length;
  if (n > LEAF_CAPACITY) throw new BTreeError(`leaf overflow: ${n} > ${LEAF_CAPACITY}`);
  page.writeUInt8(NODE_LEAF, TYPE_OFFSET);
  page.writeUInt16LE(n, COUNT_OFFSET);
  page.writeUInt32LE(node.next, LEAF_NEXT_OFFSET);
  for (let i = 0; i < n; i++) {
    const off = LEAF_ENTRIES_OFFSET + i * LEAF_ENTRY_SIZE;
    page.writeBigInt64LE(node.keys[i]!, off);
    page.writeUInt8(node.deleted[i] ? 1 : 0, off + 8);
    page.writeUInt32LE(node.rids[i]!.pageNo, off + 9);
    page.writeUInt16LE(node.rids[i]!.slot, off + 13);
  }
}

function encodeNode(node: Node, page: Buffer): void {
  if (node.kind === "leaf") encodeLeaf(node, page);
  else encodeInternal(node, page);
}

function encodeInternal(node: InternalNode, page: Buffer): void {
  const n = node.keys.length;
  if (n > INTERNAL_CAPACITY) throw new BTreeError(`internal overflow: ${n} > ${INTERNAL_CAPACITY}`);
  if (node.children.length !== n + 1) {
    throw new BTreeError(`internal node has ${node.children.length} children, expected ${n + 1}`);
  }
  page.writeUInt8(NODE_INTERNAL, TYPE_OFFSET);
  page.writeUInt16LE(n, COUNT_OFFSET);
  page.writeUInt32LE(node.children[0]!, INTERNAL_CHILD0_OFFSET);
  for (let i = 0; i < n; i++) {
    const off = INTERNAL_ENTRIES_OFFSET + i * INTERNAL_ENTRY_SIZE;
    page.writeBigInt64LE(node.keys[i]!, off);
    page.writeUInt32LE(node.rids[i]!.pageNo, off + 8);
    page.writeUInt16LE(node.rids[i]!.slot, off + 12);
    page.writeUInt32LE(node.children[i + 1]!, off + 14);
  }
}

/** Read and decode a node, releasing the page pin immediately. */
function loadNode(tx: Tx, pageNo: number): Node {
  const page = tx.read(pageNo);
  try {
    return decodeNode(page);
  } finally {
    tx.release(pageNo);
  }
}

/** First index in a leaf whose composite is >= the target composite. */
function leafLowerBound(node: LeafNode, key: bigint, rid: Rid): number {
  let lo = 0;
  let hi = node.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareComposite(node.keys[mid]!, node.rids[mid]!, key, rid) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Child index to descend into for a target composite (copy-up convention). */
function childIndexFor(node: InternalNode, key: bigint, rid: Rid): number {
  // Number of separators <= target; a composite equal to a separator lives in
  // the right subtree, since the separator is the min composite of that subtree.
  let lo = 0;
  let hi = node.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareComposite(node.keys[mid]!, node.rids[mid]!, key, rid) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Result of a recursive insert: either no split, or a separator to push up. */
type InsertResult =
  | { split: false }
  | { split: true; sepKey: bigint; sepRid: Rid; rightPage: number };

export const BTree = {
  LEAF_CAPACITY,
  INTERNAL_CAPACITY,

  /** Create an empty tree (a single empty leaf) and return its root page number. */
  create(tx: Tx): number {
    const root = tx.allocate();
    tx.modify(root, (page) => encodeLeaf({ kind: "leaf", keys: [], rids: [], deleted: [], next: 0 }, page));
    return root;
  },

  /**
   * Insert (key -> rid). The root page number is STABLE for the life of the
   * tree: when the root splits, its left half is relocated to a fresh page and
   * the root page is rewritten as the new internal node. This keeps index roots
   * in the catalog fixed, so a split never requires a catalog update.
   */
  insert(tx: Tx, rootPageNo: number, key: bigint, rid: Rid): void {
    const result = insertInto(tx, rootPageNo, key, rid);
    if (!result.split) return;

    // The split left the LEFT half at rootPageNo and the right half at
    // result.rightPage. Move the left half aside, then turn rootPageNo into the
    // new internal root pointing at both halves.
    const leftHalf = loadNode(tx, rootPageNo);
    const leftPage = tx.allocate();
    tx.modify(leftPage, (page) => encodeNode(leftHalf, page));
    tx.modify(rootPageNo, (page) =>
      encodeInternal(
        {
          kind: "internal",
          keys: [result.sepKey],
          rids: [result.sepRid],
          children: [leftPage, result.rightPage],
        },
        page,
      ),
    );
  },

  /** All live rids whose key equals `key`, in rid order. */
  search(tx: Tx, rootPageNo: number, key: bigint): Rid[] {
    const out: Rid[] = [];
    for (const [, rid] of rangeScanComposite(tx, rootPageNo, key, MIN_RID, key, MAX_RID)) {
      out.push(rid);
    }
    return out;
  },

  /** First live rid for `key`, or null. Convenient for unique (primary-key) lookups. */
  searchOne(tx: Tx, rootPageNo: number, key: bigint): Rid | null {
    for (const [, rid] of rangeScanComposite(tx, rootPageNo, key, MIN_RID, key, MAX_RID)) {
      return rid;
    }
    return null;
  },

  /** Live entries with lo <= key <= hi, ascending by (key, rid). */
  rangeScan(tx: Tx, rootPageNo: number, lo: bigint, hi: bigint): Generator<[bigint, Rid]> {
    return rangeScanComposite(tx, rootPageNo, lo, MIN_RID, hi, MAX_RID);
  },

  /** Every live entry, ascending. */
  scanAll(tx: Tx, rootPageNo: number): Generator<[bigint, Rid]> {
    return scanFromLeftmost(tx, rootPageNo);
  },

  /** Tombstone the entry matching (key, rid). Returns true if one was found. */
  delete(tx: Tx, rootPageNo: number, key: bigint, rid: Rid): boolean {
    const leafPageNo = descendToLeaf(tx, rootPageNo, key, rid);
    const node = loadNode(tx, leafPageNo) as LeafNode;
    const pos = leafLowerBound(node, key, rid);
    if (
      pos < node.keys.length &&
      compareComposite(node.keys[pos]!, node.rids[pos]!, key, rid) === 0 &&
      !node.deleted[pos]
    ) {
      tx.modify(leafPageNo, (page) => {
        const off = LEAF_ENTRIES_OFFSET + pos * LEAF_ENTRY_SIZE;
        page.writeUInt8(1, off + 8); // set deleted bit in place
      });
      return true;
    }
    return false;
  },

  /** Largest live key in the tree, or null if empty. Cheap: rightmost descent. */
  maxKey(tx: Tx, rootPageNo: number): bigint | null {
    let pageNo = rootPageNo;
    for (;;) {
      const node = loadNode(tx, pageNo);
      if (node.kind === "internal") {
        pageNo = node.children[node.children.length - 1]!;
        continue;
      }
      // Rightmost leaf: scan backward past any tombstones for the last live key.
      for (let i = node.keys.length - 1; i >= 0; i--) {
        if (!node.deleted[i]) return node.keys[i]!;
      }
      // Whole rightmost leaf is tombstoned; fall back to a full scan.
      let max: bigint | null = null;
      for (const [k] of scanFromLeftmost(tx, rootPageNo)) max = k;
      return max;
    }
  },

  /** Height of the tree: 1 for a lone leaf, +1 per internal level. */
  height(tx: Tx, rootPageNo: number): number {
    let h = 1;
    let node = loadNode(tx, rootPageNo);
    while (node.kind === "internal") {
      h += 1;
      node = loadNode(tx, node.children[0]!);
    }
    return h;
  },
};

/** Descend to the leaf page where (key, rid) belongs. */
function descendToLeaf(tx: Tx, rootPageNo: number, key: bigint, rid: Rid): number {
  let pageNo = rootPageNo;
  for (;;) {
    const node = loadNode(tx, pageNo);
    if (node.kind === "leaf") return pageNo;
    pageNo = node.children[childIndexFor(node, key, rid)]!;
  }
}

function insertInto(tx: Tx, pageNo: number, key: bigint, rid: Rid): InsertResult {
  const node = loadNode(tx, pageNo);

  if (node.kind === "leaf") {
    const pos = leafLowerBound(node, key, rid);
    if (
      pos < node.keys.length &&
      compareComposite(node.keys[pos]!, node.rids[pos]!, key, rid) === 0
    ) {
      if (node.deleted[pos]) {
        tx.modify(pageNo, (page) => {
          page.writeUInt8(0, LEAF_ENTRIES_OFFSET + pos * LEAF_ENTRY_SIZE + 8);
        });
        return { split: false };
      }
      throw new BTreeError(`duplicate index entry for key ${key} at rid ${rid.pageNo}:${rid.slot}`);
    }

    node.keys.splice(pos, 0, key);
    node.rids.splice(pos, 0, rid);
    node.deleted.splice(pos, 0, false);

    if (node.keys.length <= LEAF_CAPACITY) {
      tx.modify(pageNo, (page) => encodeLeaf(node, page));
      return { split: false };
    }
    return splitLeaf(tx, pageNo, node);
  }

  const childIdx = childIndexFor(node, key, rid);
  const res = insertInto(tx, node.children[childIdx]!, key, rid);
  if (!res.split) return { split: false };

  node.keys.splice(childIdx, 0, res.sepKey);
  node.rids.splice(childIdx, 0, res.sepRid);
  node.children.splice(childIdx + 1, 0, res.rightPage);

  if (node.keys.length <= INTERNAL_CAPACITY) {
    tx.modify(pageNo, (page) => encodeInternal(node, page));
    return { split: false };
  }
  return splitInternal(tx, pageNo, node);
}

function splitLeaf(tx: Tx, pageNo: number, node: LeafNode): InsertResult {
  const total = node.keys.length;
  const leftCount = total >> 1; // right gets the (slightly larger) upper half
  const rightPage = tx.allocate();

  const left: LeafNode = {
    kind: "leaf",
    keys: node.keys.slice(0, leftCount),
    rids: node.rids.slice(0, leftCount),
    deleted: node.deleted.slice(0, leftCount),
    next: rightPage,
  };
  const right: LeafNode = {
    kind: "leaf",
    keys: node.keys.slice(leftCount),
    rids: node.rids.slice(leftCount),
    deleted: node.deleted.slice(leftCount),
    next: node.next,
  };

  tx.modify(rightPage, (page) => encodeLeaf(right, page));
  tx.modify(pageNo, (page) => encodeLeaf(left, page));

  // Copy-up: the right leaf's first composite becomes the separator.
  return { split: true, sepKey: right.keys[0]!, sepRid: right.rids[0]!, rightPage };
}

function splitInternal(tx: Tx, pageNo: number, node: InternalNode): InsertResult {
  const total = node.keys.length; // === INTERNAL_CAPACITY + 1 here
  const mid = total >> 1; // this separator moves UP (not copied)
  const rightPage = tx.allocate();

  const left: InternalNode = {
    kind: "internal",
    keys: node.keys.slice(0, mid),
    rids: node.rids.slice(0, mid),
    children: node.children.slice(0, mid + 1),
  };
  const right: InternalNode = {
    kind: "internal",
    keys: node.keys.slice(mid + 1),
    rids: node.rids.slice(mid + 1),
    children: node.children.slice(mid + 1),
  };
  const sepKey = node.keys[mid]!;
  const sepRid = node.rids[mid]!;

  tx.modify(rightPage, (page) => encodeInternal(right, page));
  tx.modify(pageNo, (page) => encodeInternal(left, page));

  return { split: true, sepKey, sepRid, rightPage };
}

/** Generator over a composite range [(loKey,loRid) .. (hiKey,hiRid)] inclusive. */
function* rangeScanComposite(
  tx: Tx,
  rootPageNo: number,
  loKey: bigint,
  loRid: Rid,
  hiKey: bigint,
  hiRid: Rid,
): Generator<[bigint, Rid]> {
  let pageNo = descendToLeaf(tx, rootPageNo, loKey, loRid);
  let startPos = -1;
  for (;;) {
    const node = loadNode(tx, pageNo) as LeafNode;
    const from = startPos >= 0 ? startPos : leafLowerBound(node, loKey, loRid);
    startPos = 0; // subsequent leaves start at the beginning
    for (let i = from; i < node.keys.length; i++) {
      const k = node.keys[i]!;
      const r = node.rids[i]!;
      if (compareComposite(k, r, hiKey, hiRid) > 0) return;
      if (!node.deleted[i]) yield [k, r];
    }
    if (node.next === 0) return;
    pageNo = node.next;
  }
}

/** Generator over every live entry, starting at the leftmost leaf. */
function* scanFromLeftmost(tx: Tx, rootPageNo: number): Generator<[bigint, Rid]> {
  let pageNo = rootPageNo;
  for (;;) {
    const node = loadNode(tx, pageNo);
    if (node.kind === "leaf") break;
    pageNo = node.children[0]!;
  }
  for (;;) {
    const node = loadNode(tx, pageNo) as LeafNode;
    for (let i = 0; i < node.keys.length; i++) {
      if (!node.deleted[i]) yield [node.keys[i]!, node.rids[i]!];
    }
    if (node.next === 0) return;
    pageNo = node.next;
  }
}
