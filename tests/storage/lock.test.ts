import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { LockError } from "../../src/errors.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

/** A PID that is guaranteed dead: spawn a short-lived process and let it exit. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

describe("file locking", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = makeTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("refuses a second open while the first is live", () => {
    const db = Database.open(tmp.path);
    expect(() => Database.open(tmp.path)).toThrow(LockError);
    db.close();
  });

  it("releases the lock on close so the database can be reopened", () => {
    Database.open(tmp.path).close();
    const db = Database.open(tmp.path); // succeeds: lock was released
    db.close();
  });

  it("reclaims a stale lock owned by a confirmed-dead PID", () => {
    writeFileSync(`${tmp.path}-lock`, String(deadPid()));
    const db = Database.open(tmp.path); // the dead owner's lock is reclaimed
    db.exec("CREATE TABLE t (id INT NOT NULL)");
    db.close();
  });

  it("refuses an indeterminate (empty/unreadable) lock rather than stealing it", () => {
    // A concurrent opener could be mid-write; an empty lock must NOT be reclaimed.
    writeFileSync(`${tmp.path}-lock`, "");
    expect(() => Database.open(tmp.path)).toThrow(LockError);
    writeFileSync(`${tmp.path}-lock`, "not-a-pid");
    expect(() => Database.open(tmp.path)).toThrow(LockError);
  });
});
