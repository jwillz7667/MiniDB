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

// Test-only seam: a fault hook invoked immediately before each real fsync, so a
// crash-injection harness can simulate power loss at a precise durability point.
let faultHook: (() => void) | null = null;

/** Install (or clear) the fsync fault hook. Intended for tests only. */
export function setSyncFault(hook: (() => void) | null): void {
  faultHook = hook;
}

export class Durability {
  constructor(readonly mode: SyncMode = "full") {}

  /** Hard durability barrier: write-ahead ordering and checkpoints depend on it. */
  barrier(fd: number): void {
    if (this.mode === "off") return;
    faultHook?.();
    fsyncSync(fd);
  }

  /** Commit durability. Relaxed under `normal`, where it is deferred to the next barrier. */
  commitBarrier(fd: number): void {
    if (this.mode !== "full") return;
    faultHook?.();
    fsyncSync(fd);
  }

  /** Make a freshly created file's directory entry durable (best-effort per platform). */
  syncDir(filePath: string): void {
    if (this.mode === "off") return;
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(filePath), "r");
      fsyncSync(dirFd);
    } catch {
      // Some platforms (notably Windows) reject fsync on a directory handle.
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  }
}
