import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

/** A deterministic blob of `n` bytes (cycling 0..255). */
function blob(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

describe("overflow pages for large values", () => {
  let tmp: TempDb;
  let db: Database;

  const reopen = (): Database => {
    rmSync(`${tmp.path}-lock`, { force: true });
    return Database.open(tmp.path);
  };

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("stores and reads a TEXT value larger than a page", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    const big = "minidb ".repeat(10_000); // ~70 KB, many overflow pages
    db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)").run(1, big);

    expect(db.prepare("SELECT body FROM docs WHERE id = ?").pluck(1)).toBe(big);
  });

  it("stores and reads a multi-megabyte BLOB exactly", () => {
    db.exec("CREATE TABLE files (id INT NOT NULL, data BLOB NOT NULL)");
    const data = blob(1_500_000); // ~1.5 MB
    db.prepare("INSERT INTO files (id, data) VALUES (?, ?)").run(1, data);

    const back = db.prepare("SELECT data FROM files WHERE id = ?").pluck(1) as Buffer;
    expect(back.length).toBe(data.length);
    expect(back.equals(data)).toBe(true);
  });

  it("mixes inline and overflow rows in one heap and scans them all", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    const small = "tiny";
    const big = "x".repeat(20_000);
    const insert = db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)");
    insert.run(1, small);
    insert.run(2, big);
    insert.run(3, small);

    const rows = db.prepare("SELECT id, body FROM docs ORDER BY id").values();
    expect(rows.map((r) => r[0])).toEqual([1n, 2n, 3n]);
    expect(rows[0]![1]).toBe(small);
    expect(rows[1]![1]).toBe(big);
    expect(rows[2]![1]).toBe(small);
  });

  it("transitions a row inline -> overflow -> inline via UPDATE", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    db.exec("INSERT INTO docs (id, body) VALUES (1, 'short')");

    const big = "y".repeat(30_000);
    db.prepare("UPDATE docs SET body = ? WHERE id = ?").run(big, 1); // inline -> overflow
    expect(db.prepare("SELECT body FROM docs WHERE id = ?").pluck(1)).toBe(big);

    db.prepare("UPDATE docs SET body = ? WHERE id = ?").run("small again", 1); // overflow -> inline
    expect(db.prepare("SELECT body FROM docs WHERE id = ?").pluck(1)).toBe("small again");
  });

  it("re-spills on an overflow -> overflow UPDATE", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)").run(1, "a".repeat(10_000));
    const bigger = "b".repeat(40_000);
    db.prepare("UPDATE docs SET body = ? WHERE id = ?").run(bigger, 1);
    expect(db.prepare("SELECT body FROM docs WHERE id = ?").pluck(1)).toBe(bigger);
  });

  it("deletes an overflow row without disturbing its neighbors", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)");
    insert.run(1, "keep-me");
    insert.run(2, "z".repeat(25_000));
    insert.run(3, "also-keep");

    db.exec("DELETE FROM docs WHERE id = 2");
    expect(db.prepare("SELECT id, body FROM docs ORDER BY id").values()).toEqual([
      [1n, "keep-me"],
      [3n, "also-keep"],
    ]);
  });

  it("serves a large value through an index lookup", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    db.exec("CREATE INDEX ON docs (id)");
    const big = "indexed-".repeat(5_000);
    db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)").run(7, big);

    expect(db.prepare("SELECT body FROM docs WHERE id = ?").pluck(7)).toBe(big);
    const plan = db.exec("EXPLAIN SELECT body FROM docs WHERE id = 7");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });

  it("persists a large value across a clean reopen", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body TEXT NOT NULL)");
    const big = "persist-".repeat(8_000);
    db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)").run(1, big);
    db.close();

    db = reopen();
    expect(db.prepare("SELECT body FROM docs WHERE id = ?").pluck(1)).toBe(big);
  });

  it("recovers a committed large value after a crash", () => {
    db.exec("CREATE TABLE docs (id INT NOT NULL, body BLOB NOT NULL)");
    const data = blob(500_000);
    db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)").run(1, data);
    // Abandon without closing — the overflow chain is in the WAL and must replay.

    db = reopen();
    const back = db.prepare("SELECT body FROM docs WHERE id = ?").pluck(1) as Buffer;
    expect(back.equals(data)).toBe(true);
  });
});
