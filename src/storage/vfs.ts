import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { FileLock } from "./lock.js";

/**
 * The storage backend seam. Everything the engine needs from "a file" goes
 * through `Vfs`/`VfsFile`, so the same B+Tree, WAL, and recovery code runs over
 * real files (NodeVfs, the default) or entirely in memory (MemoryVfs) — no
 * native dependency, no temp files. Durability decisions (when to `sync`) stay
 * in the Durability layer; the VFS only provides the raw bytes.
 */
export interface VfsFile {
  /** Read into `buffer` at `offset`; returns the number of bytes read. */
  readAt(buffer: Buffer, offset: number): number;
  /** Write `buffer` at `offset`; returns the number of bytes written. */
  writeAt(buffer: Buffer, offset: number): number;
  truncate(length: number): void;
  size(): number;
  /** Flush to stable storage (NodeVfs fsyncs; MemoryVfs is a no-op). */
  sync(): void;
  close(): void;
}

export interface VfsLock {
  release(): void;
}

export interface Vfs {
  /** Open an existing file or create a new, empty one. */
  open(path: string): VfsFile;
  exists(path: string): boolean;
  delete(path: string): void;
  rename(from: string, to: string): void;
  /** Make a file's directory entry durable (no-op where unsupported / in memory). */
  syncDir(path: string): void;
  /** Acquire an exclusive single-writer lock for `path`. */
  acquireLock(path: string): VfsLock;
}

/** errno codes for platforms/filesystems that reject fsync on a directory handle. */
const DIR_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "EBADF"]);

class NodeFile implements VfsFile {
  constructor(private readonly fd: number) {}

  readAt(buffer: Buffer, offset: number): number {
    return readSync(this.fd, buffer, 0, buffer.length, offset);
  }

  writeAt(buffer: Buffer, offset: number): number {
    return writeSync(this.fd, buffer, 0, buffer.length, offset);
  }

  truncate(length: number): void {
    ftruncateSync(this.fd, length);
  }

  size(): number {
    return fstatSync(this.fd).size;
  }

  sync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** The default backend: real files via Node's synchronous fs API. */
export const nodeVfs: Vfs = {
  open(path: string): VfsFile {
    return new NodeFile(openSync(path, existsSync(path) ? "r+" : "w+"));
  },
  exists(path: string): boolean {
    return existsSync(path);
  },
  delete(path: string): void {
    rmSync(path, { force: true });
  },
  rename(from: string, to: string): void {
    renameSync(from, to);
  },
  syncDir(path: string): void {
    const dir = dirname(path);
    let dirFd: number;
    try {
      dirFd = openSync(dir, "r");
    } catch (err) {
      if (DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) return;
      throw err;
    }
    try {
      fsyncSync(dirFd);
    } catch (err) {
      // Only swallow platform rejections; a real EIO/ENOSPC must surface.
      if (!DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    } finally {
      closeSync(dirFd);
    }
  },
  acquireLock(path: string): VfsLock {
    return FileLock.acquire(path);
  },
};
