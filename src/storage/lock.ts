import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

import { LockError } from "../errors.js";

/**
 * A cooperative single-writer lock backed by a PID lock file. minidb is
 * single-writer (one open instance per database file); two instances sharing a
 * file — in one process or across processes — would corrupt it.
 *
 * On open we atomically create `<path>-lock` (O_EXCL) and write our PID. If it
 * already exists, we treat it as stale and reclaim it only when its owner PID is
 * no longer alive (the normal aftermath of a crash); otherwise we refuse. This
 * is advisory: it protects cooperating minidb processes, not arbitrary writers.
 */
export class FileLock {
  private released = false;

  private constructor(private readonly lockPath: string) {}

  static acquire(dbPath: string): FileLock {
    const lockPath = `${dbPath}-lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return new FileLock(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const owner = readOwner(lockPath);
        if (owner !== null && isAlive(owner)) {
          throw new LockError(
            `database is already open (locked by process ${owner}); ` +
              `close the other instance or remove ${lockPath} if it is stale`,
          );
        }
        rmSync(lockPath, { force: true }); // stale lock from a dead process — reclaim
      }
    }
    throw new LockError(`could not acquire the database lock at ${lockPath}`);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    rmSync(this.lockPath, { force: true });
  }
}

function readOwner(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true; // ourselves: a same-process double-open
  try {
    process.kill(pid, 0); // signal 0 only probes existence
    return true;
  } catch (err) {
    // EPERM => the process exists but is owned by another user; ESRCH => gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
