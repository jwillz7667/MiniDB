import { dirname } from "node:path";

import { nodeVfs, type Vfs, type VfsFile } from "./vfs.js";

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

export class Durability {
  constructor(
    readonly mode: SyncMode = "full",
    /** The storage backend; exposed so the pager and WAL open files through it. */
    readonly vfs: Vfs = nodeVfs,
  ) {}

  /** Hard durability barrier: write-ahead ordering and checkpoints depend on it. */
  barrier(file: VfsFile, path: string): void {
    if (this.mode === "off") return;
    faultHook?.(path);
    file.sync();
  }

  /** Commit durability. Relaxed under `normal`, where it is deferred to the next barrier. */
  commitBarrier(file: VfsFile, path: string): void {
    if (this.mode !== "full") return;
    faultHook?.(path);
    file.sync();
  }

  /** Make a freshly created file's directory entry durable. */
  syncDir(filePath: string): void {
    if (this.mode === "off") return;
    faultHook?.(dirname(filePath)); // crash injection also covers the directory fsync
    this.vfs.syncDir(filePath);
  }
}
