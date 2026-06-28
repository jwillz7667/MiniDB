import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durability policy, centralized so every fsync flows through one seam.
 *
 *  - `full`   (default) — every barrier and every commit are fsync'd. Safest.
 *  - `normal`           — barriers (write-ahead ordering, checkpoints) fsync, but
 *                         individual commits are not. A power loss may lose the
 *                         most recent commits, but never corrupts the database.
 *  - `off`              — no fsync at all. Fastest; for bulk loads / throwaway
 *                         data where durability does not matter.
 *
 * Honest caveat: on macOS, fsync(2) does not flush the drive's own write cache —
 * true power-loss durability needs fcntl(F_FULLFSYNC), which Node cannot issue
 * without a native addon. `barrier`/`commitBarrier` are the single seam where a
 * platform-correct full-sync would be plugged in.
 */
export type SyncMode = "full" | "normal" | "off";

// Test-only seam: a fault hook invoked immediately before each real fsync (with
// the path being synced), so a crash-injection harness can both snapshot the
// last durable image of a file and simulate power loss at a precise point.
let faultHook: ((path: string) => void) | null = null;

/** Install (or clear) the fsync fault hook. Intended for tests only. */
export function setSyncFault(hook: ((path: string) => void) | null): void {
  faultHook = hook;
}

/** errno codes for platforms/filesystems that reject fsync on a directory handle. */
const DIR_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "EBADF"]);

export class Durability {
  constructor(readonly mode: SyncMode = "full") {}

  /** Hard durability barrier: write-ahead ordering and checkpoints depend on it. */
  barrier(fd: number, path: string): void {
    if (this.mode === "off") return;
    faultHook?.(path);
    fsyncSync(fd);
  }

  /** Commit durability. Relaxed under `normal`, where it is deferred to the next barrier. */
  commitBarrier(fd: number, path: string): void {
    if (this.mode !== "full") return;
    faultHook?.(path);
    fsyncSync(fd);
  }

  /** Make a freshly created file's directory entry durable. */
  syncDir(filePath: string): void {
    if (this.mode === "off") return;
    const dir = dirname(filePath);
    let dirFd: number;
    try {
      dirFd = openSync(dir, "r");
    } catch (err) {
      if (DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) return;
      throw err;
    }
    try {
      faultHook?.(dir); // crash injection also covers the directory fsync
      fsyncSync(dirFd);
    } catch (err) {
      // Only swallow platform rejections; a real EIO/ENOSPC must surface.
      if (!DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    } finally {
      closeSync(dirFd);
    }
  }
}
