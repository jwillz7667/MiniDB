import { describe, expect, it } from "vitest";

import { AsyncDatabase } from "../src/async.js";

describe("AsyncDatabase", () => {
  it("runs queries and a committing transaction", async () => {
    const db = await AsyncDatabase.open(":memory:");
    await db.exec("CREATE TABLE t (id INT PRIMARY KEY, n INT NOT NULL)");

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", [1, 10]);
      await tx.run("INSERT INTO t (id, n) VALUES (?, ?)", [2, 20]);
    });

    expect(await db.query("SELECT n FROM t ORDER BY id")).toEqual([{ n: 10n }, { n: 20n }]);
    await db.close();
  });

  it("rolls a failing transaction back", async () => {
    const db = await AsyncDatabase.open(":memory:");
    await db.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    await db.run("INSERT INTO t (id) VALUES (1)");

    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t (id) VALUES (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await db.query("SELECT id FROM t")).toEqual([{ id: 1n }]);
    await db.close();
  });

  it("exposes prepared statements", async () => {
    const db = await AsyncDatabase.open(":memory:");
    await db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (id, name) VALUES (?, ?)");
    await insert.run(1, "a");
    await insert.run(2, "b");

    expect(await db.prepare("SELECT name FROM t WHERE id = ?").get(2)).toEqual({ name: "b" });
    expect(await db.prepare("SELECT name FROM t WHERE id = ?").pluck(1)).toBe("a");
    await db.close();
  });
});
