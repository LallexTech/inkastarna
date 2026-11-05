import { Pool } from "pg";

const globalDb = globalThis as unknown as { inkastarnaPool?: Pool };
export const db =
  globalDb.inkastarnaPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
if (process.env.NODE_ENV !== "production") globalDb.inkastarnaPool = db;
