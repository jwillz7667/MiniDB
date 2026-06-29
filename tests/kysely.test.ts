import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { MinidbDialect } from "../src/kysely/index.js";

interface DB {
  users: { id: bigint; name: string; active: boolean };
  orders: { id: bigint; user_id: bigint; amount: bigint };
}

describe("Kysely dialect", () => {
  let minidb: Database;
  let db: Kysely<DB>;

  beforeEach(() => {
    minidb = Database.open(":memory:");
    minidb.exec("CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL, active BOOL NOT NULL)");
    minidb.exec("CREATE TABLE orders (id INT PRIMARY KEY, user_id INT NOT NULL, amount INT NOT NULL)");
    db = new Kysely<DB>({ dialect: new MinidbDialect({ database: minidb }) });
  });

  afterEach(async () => {
    await db.destroy();
    minidb.close();
  });

  it("inserts and selects through the query builder", async () => {
    await db.insertInto("users").values({ id: 1n, name: "ann", active: true }).execute();
    await db.insertInto("users").values({ id: 2n, name: "bob", active: false }).execute();

    const rows = await db.selectFrom("users").select(["id", "name"]).orderBy("id").execute();
    expect(rows).toEqual([
      { id: 1n, name: "ann" },
      { id: 2n, name: "bob" },
    ]);
  });

  it("filters with a parameterized WHERE and LIMIT", async () => {
    for (let i = 1n; i <= 5n; i++) {
      await db.insertInto("users").values({ id: i, name: `u${i}`, active: true }).execute();
    }
    const rows = await db
      .selectFrom("users")
      .select(["name"])
      .where("id", ">", 2n)
      .orderBy("id")
      .limit(2)
      .execute();
    expect(rows).toEqual([{ name: "u3" }, { name: "u4" }]);
  });

  it("joins two tables", async () => {
    await db.insertInto("users").values({ id: 1n, name: "ann", active: true }).execute();
    await db.insertInto("orders").values({ id: 10n, user_id: 1n, amount: 100n }).execute();
    await db.insertInto("orders").values({ id: 11n, user_id: 1n, amount: 50n }).execute();

    const rows = await db
      .selectFrom("users")
      .innerJoin("orders", "orders.user_id", "users.id")
      .select(["users.name as name", "orders.amount as amount"])
      .orderBy("orders.amount")
      .execute();
    expect(rows).toEqual([
      { name: "ann", amount: 50n },
      { name: "ann", amount: 100n },
    ]);
  });

  it("updates and deletes", async () => {
    await db.insertInto("users").values({ id: 1n, name: "ann", active: true }).execute();
    await db.insertInto("users").values({ id: 2n, name: "bob", active: true }).execute();

    await db.updateTable("users").set({ active: false }).where("id", "=", 1n).execute();
    expect(await db.selectFrom("users").select(["active"]).where("id", "=", 1n).executeTakeFirst()).toEqual({
      active: false,
    });

    await db.deleteFrom("users").where("id", "=", 2n).execute();
    expect(await db.selectFrom("users").select(["id"]).execute()).toEqual([{ id: 1n }]);
  });

  it("commits and rolls back via Kysely transactions", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("users").values({ id: 1n, name: "ann", active: true }).execute();
      await trx.insertInto("users").values({ id: 2n, name: "bob", active: true }).execute();
    });
    expect((await db.selectFrom("users").select(["id"]).execute()).length).toBe(2);

    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("users").values({ id: 3n, name: "cleo", active: true }).execute();
        throw new Error("rollback please");
      }),
    ).rejects.toThrow("rollback please");
    expect((await db.selectFrom("users").select(["id"]).execute()).length).toBe(2);
  });
});
