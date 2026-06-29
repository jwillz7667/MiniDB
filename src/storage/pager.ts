import {
  DB_FORMAT_VERSION,
  HEADER_CATALOG_ROOT_OFFSET,
  HEADER_MAGIC_OFFSET,
  HEADER_NEXT_TXID_OFFSET,
  HEADER_PAGE_COUNT_OFFSET,
  HEADER_PAGE_SIZE_OFFSET,
  HEADER_VERSION_OFFSET,
  INVALID_PAGE,
  MAGIC,
  MAGIC_BYTES,
  PAGE_CHECKSUM_OFFSET,
  PAGE_SIZE,
  USABLE_PAGE_SIZE,
} from "../constants.js";
import { CorruptDatabaseError, PageError } from "../errors.js";
import { crc32 } from "./crc32.js";
import { Durability } from "./durability.js";
import type { VfsFile } from "./vfs.js";

/**
 * The lowest layer: turns one file into a sequence of fixed-size pages. Page 0
 * is the database header and is owned exclusively by the pager — no higher layer
 * ever reads or writes it, which is why page number 0 is free to mean "no page".
 *
 * Durability note: `writePage` does NOT fsync by default. Fsyncing every page
 * write would defeat the WAL's no-force policy and cripple throughput. Callers
 * batch writes and then call `sync()` once (the buffer pool flush path and
 * checkpoints do exactly this). Header mutations, which are rare and must be
 * crash-safe on their own, fsync immediately.
 */
export class Pager {
  private constructor(
    private readonly file: VfsFile,
    readonly path: string,
    private readonly header: Buffer,
    private count: number,
    private readonly durability: Durability,
  ) {}

  /** Open an existing database file or create a fresh one. */
  static open(path: string, durability: Durability = new Durability()): Pager {
    const vfs = durability.vfs;
    const existed = vfs.exists(path);
    const file = vfs.open(path);

    const size = file.size();
    if (!existed || size === 0) {
      const header = Buffer.alloc(PAGE_SIZE);
      header.write(MAGIC, HEADER_MAGIC_OFFSET, MAGIC_BYTES, "ascii");
      header.writeUInt16LE(DB_FORMAT_VERSION, HEADER_VERSION_OFFSET);
      header.writeUInt16LE(PAGE_SIZE, HEADER_PAGE_SIZE_OFFSET);
      header.writeUInt32LE(1, HEADER_PAGE_COUNT_OFFSET); // page 0 only
      header.writeUInt32LE(INVALID_PAGE, HEADER_CATALOG_ROOT_OFFSET);
      header.writeBigUInt64LE(1n, HEADER_NEXT_TXID_OFFSET); // txids start at 1
      stampChecksum(header);
      file.writeAt(header, 0);
      durability.barrier(file, path);
      durability.syncDir(path); // make the new file's directory entry durable
      return new Pager(file, path, header, 1, durability);
    }

    const header = Buffer.alloc(PAGE_SIZE);
    file.readAt(header, 0);
    const fail = (message: string): never => {
      file.close();
      throw new CorruptDatabaseError(message);
    };
    const magic = header.toString("ascii", HEADER_MAGIC_OFFSET, MAGIC_BYTES);
    if (magic !== MAGIC) fail(`not a minidb file: expected magic "${MAGIC}", found "${magic}"`);
    const storedVersion = header.readUInt16LE(HEADER_VERSION_OFFSET);
    if (storedVersion !== DB_FORMAT_VERSION) {
      fail(`format version mismatch: file is v${storedVersion}, engine is v${DB_FORMAT_VERSION}`);
    }
    const storedPageSize = header.readUInt16LE(HEADER_PAGE_SIZE_OFFSET);
    if (storedPageSize !== PAGE_SIZE) {
      fail(`page size mismatch: file uses ${storedPageSize}, engine uses ${PAGE_SIZE}`);
    }
    if (!verifyChecksum(header)) fail("database header failed its checksum (file corrupt)");

    // Drop any torn trailing page left by a crash mid-allocation; recovery will
    // rebuild whatever it needs from the WAL.
    let count = Math.floor(size / PAGE_SIZE);
    if (count < 1) count = 1;
    if (size !== count * PAGE_SIZE) file.truncate(count * PAGE_SIZE);
    header.writeUInt32LE(count, HEADER_PAGE_COUNT_OFFSET);
    return new Pager(file, path, header, count, durability);
  }

  /** Number of pages currently in the file (including the header page 0). */
  pageCount(): number {
    return this.count;
  }

  private assertPage(pageNo: number): void {
    if (!Number.isInteger(pageNo) || pageNo < 0 || pageNo >= this.count) {
      throw new PageError(
        `page ${pageNo} out of range [0, ${this.count})`,
      );
    }
  }

  /** Read a page into a fresh Buffer. Page 0 returns the live header image. */
  readPage(pageNo: number): Buffer {
    this.assertPage(pageNo);
    if (pageNo === 0) return Buffer.from(this.header);
    const page = Buffer.alloc(PAGE_SIZE);
    this.readVerified(pageNo, page);
    return page;
  }

  /** Read a page directly into a caller-owned buffer (lets the pool reuse frames). */
  readPageInto(pageNo: number, into: Buffer): void {
    this.assertPage(pageNo);
    if (into.length !== PAGE_SIZE) {
      throw new PageError(`destination must be ${PAGE_SIZE} bytes, got ${into.length}`);
    }
    if (pageNo === 0) {
      this.header.copy(into);
      return;
    }
    this.readVerified(pageNo, into);
  }

  private readVerified(pageNo: number, into: Buffer): void {
    const read = this.file.readAt(into, pageNo * PAGE_SIZE);
    if (read !== PAGE_SIZE) {
      throw new PageError(`short read on page ${pageNo}: ${read}/${PAGE_SIZE} bytes`);
    }
    if (!verifyChecksum(into)) {
      throw new CorruptDatabaseError(`page ${pageNo} failed its checksum (torn write or bit-rot)`);
    }
  }

  /**
   * Write a page (stamping its checksum first). By default does not fsync (see
   * class note). Page 0 writes go through `writeHeader`/header setters instead
   * and are not expected here.
   */
  writePage(pageNo: number, page: Buffer, sync = false): void {
    this.assertPage(pageNo);
    if (page.length !== PAGE_SIZE) {
      throw new PageError(`page buffer must be ${PAGE_SIZE} bytes, got ${page.length}`);
    }
    stampChecksum(page);
    if (pageNo === 0) {
      page.copy(this.header);
    }
    const written = this.file.writeAt(page, pageNo * PAGE_SIZE);
    if (written !== PAGE_SIZE) {
      throw new PageError(`short write on page ${pageNo}: ${written}/${PAGE_SIZE} bytes`);
    }
    if (sync) this.durability.barrier(this.file, this.path);
  }

  /** Grow the file by one zero-filled page and return its page number. */
  allocatePage(): number {
    const pageNo = this.count;
    this.file.truncate((this.count + 1) * PAGE_SIZE);
    this.count += 1;
    this.header.writeUInt32LE(this.count, HEADER_PAGE_COUNT_OFFSET);
    return pageNo;
  }

  /**
   * Grow the file so it holds at least `pages` pages, zero-filling new space.
   * Used by recovery when a logged change references a page past EOF (which is
   * how page allocation becomes durable: the WAL implies the file must be big
   * enough, even if the crash happened before the file actually grew).
   */
  ensurePageCount(pages: number): void {
    if (pages <= this.count) return;
    this.file.truncate(pages * PAGE_SIZE);
    this.count = pages;
    this.header.writeUInt32LE(this.count, HEADER_PAGE_COUNT_OFFSET);
  }

  /** Persist the in-memory header page to disk and fsync. */
  private writeHeader(): void {
    stampChecksum(this.header);
    this.file.writeAt(this.header, 0);
    this.durability.barrier(this.file, this.path);
  }

  /** Heap root page of the catalog (minidb_tables), or INVALID_PAGE if unset. */
  getCatalogRoot(): number {
    return this.header.readUInt32LE(HEADER_CATALOG_ROOT_OFFSET);
  }

  setCatalogRoot(pageNo: number): void {
    this.header.writeUInt32LE(pageNo, HEADER_CATALOG_ROOT_OFFSET);
    this.writeHeader();
  }

  /** Next transaction id to hand out. Authoritative value is rebuilt from the WAL on recovery. */
  getNextTxid(): bigint {
    return this.header.readBigUInt64LE(HEADER_NEXT_TXID_OFFSET);
  }

  setNextTxid(txid: bigint): void {
    this.header.writeBigUInt64LE(txid, HEADER_NEXT_TXID_OFFSET);
    this.writeHeader();
  }

  /** fsync the data file. Called once after a batch of page writes. */
  sync(): void {
    // Keep the persisted page count current before forcing the file down.
    stampChecksum(this.header);
    this.file.writeAt(this.header, 0);
    this.durability.barrier(this.file, this.path);
  }

  close(): void {
    this.sync();
    this.file.close();
  }
}

/** Write a page's CRC32 (over its content area) into its reserved trailer. */
function stampChecksum(page: Buffer): void {
  page.writeUInt32LE(crc32(page, 0, USABLE_PAGE_SIZE), PAGE_CHECKSUM_OFFSET);
}

/**
 * Verify a page's checksum. A brand-new, never-written page is all zeros (from
 * ftruncate) — treated as a valid uninitialized page so a freshly allocated
 * page can be read before its first write.
 */
function verifyChecksum(page: Buffer): boolean {
  const stored = page.readUInt32LE(PAGE_CHECKSUM_OFFSET);
  if (stored === crc32(page, 0, USABLE_PAGE_SIZE)) return true;
  return isAllZero(page);
}

function isAllZero(page: Buffer): boolean {
  for (let i = 0; i < page.length; i++) if (page[i] !== 0) return false;
  return true;
}
