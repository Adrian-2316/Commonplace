import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Db = pg.Pool;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Applies the numbered .sql files in migrations/ that haven't run yet, each in its own transaction. */
export async function migrate(db: Db): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(await readFile(path.join(dir, file), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
}
