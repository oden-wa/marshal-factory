import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) throw new Error("AgentsView label state path is required");

const db = new Database(path, { create: false });
try {
  db.exec("PRAGMA busy_timeout = 0");
  const integrity = db.query<{ quick_check: string }>("PRAGMA quick_check(1)").get();
  if (integrity?.quick_check !== "ok") throw new Error("AgentsView label state failed SQLite quick_check");
} finally {
  db.close();
}
