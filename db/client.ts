import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { databaseConnectionString } from "./connection";
import * as schema from "./schema";

const globalForPool = globalThis as unknown as { __pgPool?: Pool };

function createPool() {
  const pool = new Pool({
    connectionString: databaseConnectionString(process.env.DATABASE_URL!),
    max: 5,
  });
  pool.on("error", (error) => console.error(error));
  // pg listens for errors only on idle clients: a socket that dies under a checked-out one, such as a
  // transaction's after the machine slept, would emit an unhandled error and end the process.
  pool.on("connect", (client) => client.on("error", (error) => console.error(error)));
  return pool;
}

// Reused across dev hot reloads so each reload doesn't leak a pool.
const pool = (globalForPool.__pgPool ??= createPool());

export const db = drizzle(pool, { schema });
