// One-off/pre-deploy command. Never imported into an HTTP request handler.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@openrift/shared/logger";
import postgres from "postgres";
import { createDb } from "../../db/connect.js";
import { migrate } from "../../db/migrate.js";
import { syncCatalog } from "./sync-catalog.js";

export async function initializeHosted() {
  if (process.env.RIFTER_DATABASE_PURPOSE !== "rifter")
    throw Error("Set RIFTER_DATABASE_PURPOSE=rifter only for a dedicated Rifter database");
  const url = process.env.DATABASE_URL;
  if (!url) throw Error("DATABASE_URL is required");
  const connection = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname)
      && connection.searchParams.get("sslmode") !== "verify-full")
    throw Error("Hosted DATABASE_URL must use sslmode=verify-full for verified PostgreSQL TLS");
  const root = process.env.RIFTER_ROOT ?? new URL("../../../../../../../", import.meta.url).pathname;
  const sql = postgres(url, { max: 1, prepare: false });
  const { db } = createDb(url);
  try {
    const [state] = await sql`SELECT to_regclass('public.kysely_migration') AS migrations,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')) AS tables`;
    if (!state?.migrations && state?.tables > 0)
      throw Error("Refusing to initialize an unrelated database with existing public tables");
    const file = (name: string) => readFile(path.join(root, "integrations/openrift", name), "utf8");
    // Defaults are restricted before migration so new tables are never briefly
    // exposed to Supabase's anon/authenticated Data API roles.
    await sql.unsafe(await file("hosted-access.sql"));
    await sql.unsafe(await file("hosted-compat.sql"));
    await migrate(db, createLogger("hosted-migrate"));
    await sql.unsafe(await file("schema.sql"));
    await sql.unsafe(await file("hosted-access.sql"));
    const [catalog] = await sql`SELECT count(*)::int AS cards FROM cards`;
    if (process.argv.includes("--catalog-if-empty") && catalog?.cards === 0) {
      const input = process.argv.indexOf("--catalog-file");
      const snapshot = input >= 0 ? JSON.parse(await readFile(process.argv[input + 1]!, "utf8")) : undefined;
      await syncCatalog({ allowHosted: true, snapshot });
    }
    console.log("Hosted schema initialized; private API access retained. No account or deployment created.");
  } finally {
    await db.destroy();
    await sql.end();
  }
}
if (import.meta.main) await initializeHosted();
