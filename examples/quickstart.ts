/**
 * minidb quickstart — run with: pnpm tsx examples/quickstart.ts
 *
 * Uses an in-memory database so it leaves nothing on disk. Swap ":memory:" for a
 * file path (e.g. "app.minidb") to get a durable, crash-safe database instead.
 */
import { Database } from "../src/index.js";

const db = Database.open(":memory:");

// Schema with constraints: an auto-incrementing primary key, NOT NULL, a UNIQUE
// INT column, a DEFAULT, and the supported types (INT, TEXT, REAL, BOOL, DATETIME).
// (PRIMARY KEY / UNIQUE are INT-only for now — B+Tree keys are 64-bit integers.)
db.exec(`
  CREATE TABLE users (
    id    INT PRIMARY KEY AUTOINCREMENT,
    code  INT UNIQUE,
    email TEXT NOT NULL,
    name  TEXT NOT NULL,
    score REAL DEFAULT 0,
    admin BOOL DEFAULT FALSE,
    joined DATETIME NOT NULL
  )
`);

// Prepared statements bind values safely — no SQL string building, no injection.
const insert = db.prepare(
  "INSERT INTO users (code, email, name, score, joined) VALUES (?, ?, ?, ?, ?)",
);
insert.run(100, "ann@example.com", "Ann", 9.5, new Date("2024-01-01T00:00:00Z"));
insert.run(200, "bob@example.com", "Bob", 7.0, new Date("2024-02-01T00:00:00Z"));
insert.run(300, "cleo@example.com", "Cleo", 9.5, new Date("2024-03-01T00:00:00Z"));

// UNIQUE is enforced.
try {
  insert.run(100, "dup@example.com", "Dup", 1, new Date());
} catch (err) {
  console.log("rejected duplicate code:", (err as Error).message);
}

// Query as typed row objects. INT comes back as bigint (no precision loss).
console.log("\ntop scorers:");
for (const row of db.prepare("SELECT name, score FROM users WHERE score >= ? ORDER BY name").all(9)) {
  console.log(` ${row.name}: ${row.score}`);
}

// A second table + a JOIN + GROUP BY aggregate.
db.exec("CREATE TABLE logins (id INT PRIMARY KEY AUTOINCREMENT, user_id INT NOT NULL)");
const login = db.prepare("INSERT INTO logins (user_id) VALUES (?)");
for (const uid of [1, 1, 1, 2]) login.run(uid);

console.log("\nlogin counts:");
const counts = db
  .prepare(
    "SELECT u.name AS name, COUNT(*) AS n FROM users u JOIN logins l ON u.id = l.user_id GROUP BY u.name ORDER BY n DESC",
  )
  .all();
console.log(counts);

// A transaction either fully applies or fully rolls back.
db.exec("BEGIN");
db.exec("UPDATE users SET admin = TRUE WHERE email = 'ann@example.com'");
db.exec("COMMIT");

// Export the whole database as SQL.
console.log("\n--- dump ---");
console.log(db.dump());

db.close();
