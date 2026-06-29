/**
 * Using minidb with the Kysely type-safe query builder.
 * Run with: pnpm tsx examples/with-kysely.ts  (requires `kysely` installed)
 *
 *   import { Database } from "minidb";
 *   import { MinidbDialect } from "minidb/kysely";
 */
import { Kysely } from "kysely";

import { Database } from "../src/index.js";
import { MinidbDialect } from "../src/kysely/index.js";

// Your schema types. INT columns surface as bigint.
interface DB {
  users: { id: bigint; name: string; age: bigint };
}

const minidb = Database.open(":memory:");
// Define the schema with minidb (Kysely is for queries; migrations are your call).
minidb.exec("CREATE TABLE users (id INT PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INT NOT NULL)");

const db = new Kysely<DB>({ dialect: new MinidbDialect({ database: minidb }) });

async function main(): Promise<void> {
  await db.insertInto("users").values({ id: 1n, name: "Ann", age: 30n }).execute();
  await db.insertInto("users").values({ id: 2n, name: "Bob", age: 25n }).execute();

  const adults = await db
    .selectFrom("users")
    .select(["name", "age"])
    .where("age", ">=", 18n)
    .orderBy("age", "desc")
    .execute();

  console.log(adults); // [{ name: 'Ann', age: 30n }, { name: 'Bob', age: 25n }]

  await db.transaction().execute(async (trx) => {
    await trx.updateTable("users").set({ age: 31n }).where("id", "=", 1n).execute();
  });

  await db.destroy();
  minidb.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
