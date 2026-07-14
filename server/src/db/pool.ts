import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl(),
  max: 10,
  ssl: config.databaseUrl().includes("localhost") || config.databaseUrl().includes("127.0.0.1")
    ? undefined
    : { rejectUnauthorized: false }
});

export const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  pool.query<T>(text, params);
