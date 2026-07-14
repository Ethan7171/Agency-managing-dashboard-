import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(): Promise<void> {
  await pool.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    const { rowCount } = await pool.query("select 1 from schema_migrations where name=$1", [f]);
    if (rowCount) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values ($1)", [f]);
      await client.query("commit");
      console.log(`migrated ${f}`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => { console.log("migrations complete"); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
