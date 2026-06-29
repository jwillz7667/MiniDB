import { LockError } from "../errors.js";
import type { Vfs, VfsFile, VfsLock } from "./vfs.js";

/** A growable in-memory byte buffer standing in for one file. */
class MemoryStore {
  private buf = Buffer.alloc(0);
  length = 0;

  private ensure(capacity: number): void {
    if (capacity <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(capacity, this.buf.length * 2, 4096));
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  readAt(out: Buffer, offset: number): number {
    const n = Math.max(0, Math.min(out.length, this.length - offset));
    if (n > 0) this.buf.copy(out, 0, offset, offset + n);
    return n;
  }

  writeAt(data: Buffer, offset: number): number {
    this.ensure(offset + data.length);
    data.copy(this.buf, offset);
    if (offset + data.length > this.length) this.length = offset + data.length;
    return data.length;
  }

  truncate(length: number): void {
    if (length > this.length) {
      this.ensure(length);
      this.buf.fill(0, this.length, length);
    }
    this.length = length;
  }
}

class MemoryFile implements VfsFile {
  constructor(private readonly store: MemoryStore) {}

  readAt(buffer: Buffer, offset: number): number {
    return this.store.readAt(buffer, offset);
  }
  writeAt(buffer: Buffer, offset: number): number {
    return this.store.writeAt(buffer, offset);
  }
  truncate(length: number): void {
    this.store.truncate(length);
  }
  size(): number {
    return this.store.length;
  }
  sync(): void {
    /* nothing to flush in memory */
  }
  close(): void {
    /* the store persists in the Vfs so the file can be reopened */
  }
}

/**
 * An entirely in-memory backend: no filesystem, no native dependency, no temp
 * files. The same engine (B+Tree, WAL, recovery) runs over it — useful for
 * tests, ephemeral data, and runtimes without a writable disk. Durability is a
 * no-op (sync does nothing), so a process exit loses the data, as expected for
 * an in-memory store. Files live as long as this Vfs instance does.
 */
export class MemoryVfs implements Vfs {
  private readonly files = new Map<string, MemoryStore>();
  private readonly locks = new Set<string>();

  open(path: string): VfsFile {
    let store = this.files.get(path);
    if (!store) {
      store = new MemoryStore();
      this.files.set(path, store);
    }
    return new MemoryFile(store);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  delete(path: string): void {
    this.files.delete(path);
  }

  rename(from: string, to: string): void {
    const store = this.files.get(from);
    if (!store) return;
    this.files.set(to, store);
    this.files.delete(from);
  }

  syncDir(): void {
    /* no directories in memory */
  }

  acquireLock(path: string): VfsLock {
    if (this.locks.has(path)) {
      throw new LockError(`in-memory database "${path}" is already open`);
    }
    this.locks.add(path);
    return { release: () => this.locks.delete(path) };
  }
}
