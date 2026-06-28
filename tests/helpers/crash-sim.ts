import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { setSyncFault } from "../../src/storage/durability.js";

/**
 * A faithful power-loss simulator for durability tests.
 *
 * The engine's same-process reopen shares the OS page cache, so a plain
 * "abandon and reopen" can never lose un-fsync'd bytes — it tests WAL redo/undo,
 * not durability. This shim closes that gap: it hooks the durability layer's
 * fault seam (which fires immediately before every real fsync) and snapshots the
 * file being synced. `crash()` then rewrites each tracked file with its last
 * fsync'd image, discarding everything written since — exactly what a power loss
 * would drop. Removing an fsync now becomes observable.
 */
export class CrashSim {
  private readonly durable = new Map<string, Buffer>();

  constructor(private readonly paths: string[]) {
    for (const p of paths) this.durable.set(p, snapshot(p));
  }

  /** Start tracking fsyncs. Each fsync of a tracked path updates its durable image. */
  arm(): void {
    setSyncFault((path) => {
      if (this.durable.has(path)) this.durable.set(path, snapshot(path));
    });
  }

  disarm(): void {
    setSyncFault(null);
  }

  /** Simulate power loss: revert every tracked file to its last fsync'd image. */
  crash(): void {
    for (const p of this.paths) {
      writeFileSync(p, this.durable.get(p) ?? Buffer.alloc(0)); // truncates off un-fsync'd bytes
    }
  }
}

function snapshot(path: string): Buffer {
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
}
