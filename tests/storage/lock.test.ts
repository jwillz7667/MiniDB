import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { LockError } from "../../src/errors.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

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

  it("reclaims a stale lock left by a crashed process", () => {
    // A lock file whose contents are not a live PID is treated as stale.
    writeFileSync(`${tmp.path}-lock`, "not-a-pid");
    const db = Database.open(tmp.path); // reclaims the stale lock
    db.exec("CREATE TABLE t (id INT NOT NULL)");
    db.close();
  });
});
