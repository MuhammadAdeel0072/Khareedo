import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";

const TABLES = [
  "User",
  "Category",
  "Address",
  "Product",
  "Cart",
  "WishlistItem",
  "Order",
  "ProductImage",
  "Inventory",
  "CartItem",
  "OrderItem",
  "Payment",
  "Promotion",
  "Coupon",
  "Banner",
  "StoreSetting",
  "OAuthAccount",
  "VerificationToken",
];
const SOURCE_TABLES = TABLES.filter(
  (table) => table !== "OAuthAccount" && table !== "VerificationToken"
);
const PRIMARY_KEYS = Object.fromEntries(
  TABLES.map((table) => [table, table === "StoreSetting" ? "key" : "id"])
);
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

function assertTargetMatchesProject(databaseUrl, projectUrl) {
  const database = new URL(databaseUrl);
  const project = new URL(projectUrl);
  const projectRef = project.hostname.split(".")[0];
  if (
    !database.protocol.startsWith("postgres") ||
    !(
      database.hostname === `db.${projectRef}.supabase.co` ||
      database.username.endsWith(`.${projectRef}`) ||
      database.hostname.startsWith(`${projectRef}.`)
    )
  ) {
    throw new Error("The PostgreSQL URL does not match the configured Supabase project.");
  }
}

function getSourcePath(args) {
  const index = args.indexOf("--source");
  return index < 0
    ? resolve("db/custom.db")
    : args[index + 1]
      ? resolve(args[index + 1])
      : (() => {
          throw new Error("--source requires a SQLite file path.");
        })();
}

function stableValue(value, type) {
  if (value === null || value === undefined) return null;
  if (type === "boolean") return value === true || value === 1;
  if (type.includes("timestamp") || type === "date") {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return value;
}

function recordsMatch(source, destination, columns) {
  return columns.every(
    ({ column_name: name, data_type: type }) =>
      stableValue(source[name], type) === stableValue(destination[name], type)
  );
}

function orderCategories(rows) {
  const pending = new Map(rows.map((row) => [row.id, row]));
  const inserted = new Set();
  const ordered = [];
  while (pending.size) {
    let progressed = false;
    for (const [id, row] of pending) {
      if (row.parentId === null || inserted.has(row.parentId)) {
        ordered.push(row);
        inserted.add(id);
        pending.delete(id);
        progressed = true;
      }
    }
    if (!progressed) throw new Error("Category parent references contain a cycle or missing parent.");
  }
  return ordered;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;
  if (apply && args.includes("--dry-run")) {
    throw new Error("Choose either --apply or --dry-run.");
  }

  const databaseUrl = process.env.SUPABASE_POSTGRES_URL;
  if (!databaseUrl || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error("SUPABASE_POSTGRES_URL and NEXT_PUBLIC_SUPABASE_URL are required.");
  }
  assertTargetMatchesProject(databaseUrl, process.env.NEXT_PUBLIC_SUPABASE_URL);

  const caPath = process.env.SUPABASE_DB_CA_CERT;
  const ssl = {
    rejectUnauthorized: true,
    ...(caPath ? { ca: readFileSync(resolve(caPath), "utf8") } : {}),
  };
  const client = new Client({
    connectionString: databaseUrl,
    ssl,
    connectionTimeoutMillis: 15000,
  });
  const source = new DatabaseSync(getSourcePath(args), { readOnly: true });
  let connected = false;

  try {
    source.exec("BEGIN");
    const integrity = source.prepare("PRAGMA quick_check").get();
    if (integrity.quick_check !== "ok") {
      throw new Error("The SQLite source failed its integrity check.");
    }
    if (source.prepare("PRAGMA foreign_key_check").all().length) {
      throw new Error("The SQLite source contains foreign-key violations.");
    }
    const sourceNames = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name)
    );
    const missingSource = SOURCE_TABLES.filter((table) => !sourceNames.has(table));
    const unexpectedSource = [...sourceNames].filter((table) => !SOURCE_TABLES.includes(table));
    if (missingSource.length || unexpectedSource.length) {
      throw new Error(
        `SQLite table inventory mismatch (missing: ${missingSource.join(", ") || "none"}; unexpected: ${unexpectedSource.join(", ") || "none"}).`
      );
    }

    const rowsByTable = new Map();
    const sourceColumnsByTable = new Map();
    for (const table of SOURCE_TABLES) {
      const columns = source
        .prepare(`PRAGMA table_info(${identifier(table)})`)
        .all()
        .map((column) => column.name);
      sourceColumnsByTable.set(table, columns);
      rowsByTable.set(
        table,
        source.prepare(`SELECT * FROM ${identifier(table)}`).all()
      );
    }
    rowsByTable.set("OAuthAccount", []);
    rowsByTable.set("VerificationToken", []);
    rowsByTable.set("Category", orderCategories(rowsByTable.get("Category")));

    await client.connect();
    connected = true;
    const target = await client.query("SELECT current_schema() AS schema");
    if (target.rows[0]?.schema !== "public") {
      throw new Error("The connected PostgreSQL schema is not public; refusing migration.");
    }
    const publicObjects = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const allowedTables = new Set([...TABLES, "_prisma_migrations"]);
    const unexpectedObjects = publicObjects.rows
      .map((row) => row.table_name)
      .filter((name) => !allowedTables.has(name));
    if (unexpectedObjects.length) {
      throw new Error(
        `Unexpected tables exist in PostgreSQL public schema: ${unexpectedObjects.join(", ")}.`
      );
    }

    const tableReports = [];
    const columnsByTable = new Map();
    for (const table of TABLES) {
      const result = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      );
      const columns = result.rows;
      if (!columns.length) throw new Error(`PostgreSQL table ${table} is missing.`);
      const sourceColumns = sourceColumnsByTable.get(table) ?? [];
      if (
        sourceColumns.length !== columns.length ||
        sourceColumns.some((name, index) => name !== columns[index].column_name)
      ) {
        throw new Error(`SQLite/PostgreSQL columns do not match for ${table}.`);
      }
      columnsByTable.set(table, columns);
      const count = await client.query(`SELECT count(*)::text AS count FROM ${identifier(table)}`);
      tableReports.push({
        table,
        source: rowsByTable.get(table).length,
        destination: Number(count.rows[0].count),
      });
    }

    console.log(`Project target verified; mode=${dryRun ? "DRY_RUN" : "APPLY"}`);
    for (const row of tableReports) {
      console.log(`${row.table}: source=${row.source} destination=${row.destination}`);
    }
    if (dryRun) return;

    await client.query("BEGIN");
    try {
      for (const table of TABLES) {
        const rows = rowsByTable.get(table);
        if (!rows.length) continue;

        const columns = columnsByTable.get(table);
        const primaryKey = PRIMARY_KEYS[table];
        const existing = await client.query(`SELECT * FROM ${identifier(table)}`);
        const existingByKey = new Map(
          existing.rows.map((row) => [String(row[primaryKey]), row])
        );
        const sourceByKey = new Map(
          rows.map((row) => [String(row[primaryKey]), row])
        );

        for (const [key, row] of existingByKey) {
          const sourceRow = sourceByKey.get(key);
          if (!sourceRow || !recordsMatch(sourceRow, row, columns)) {
            throw new Error(`Destination conflict in ${table}; no existing row was overwritten.`);
          }
        }

        const missingRows = rows.filter(
          (row) => !existingByKey.has(String(row[primaryKey]))
        );
        for (let offset = 0; offset < missingRows.length; offset += 200) {
          const batch = missingRows.slice(offset, offset + 200);
          const names = columns.map((column) => identifier(column.column_name));
          const values = [];
          const placeholders = batch.map((row) => {
            const rowPlaceholders = columns.map((column) => {
              const value = row[column.column_name];
              const converted =
                column.data_type === "boolean" && value !== null
                  ? Boolean(value)
                  : value;
              values.push(converted);
              return `$${values.length}`;
            });
            return `(${rowPlaceholders.join(", ")})`;
          });
          await client.query(
            `INSERT INTO ${identifier(table)} (${names.join(", ")})
             VALUES ${placeholders.join(", ")}
             ON CONFLICT DO NOTHING`,
            values
          );
        }

        const verified = await client.query(`SELECT * FROM ${identifier(table)}`);
        const verifiedByKey = new Map(
          verified.rows.map((row) => [String(row[primaryKey]), row])
        );
        if (verifiedByKey.size !== rows.length) {
          throw new Error(`Destination row count mismatch in ${table}; transaction will roll back.`);
        }
        for (const sourceRow of rows) {
          const destinationRow = verifiedByKey.get(String(sourceRow[primaryKey]));
          if (!destinationRow || !recordsMatch(sourceRow, destinationRow, columns)) {
            throw new Error(`Data verification failed for ${table}; transaction will roll back.`);
          }
        }
      }

      await client.query("COMMIT");
      console.log("IMPORT_COMMITTED=true");
      for (const table of TABLES) {
        const count = await client.query(`SELECT count(*)::text AS count FROM ${identifier(table)}`);
        console.log(`${table}: source=${rowsByTable.get(table).length} destination=${count.rows[0].count}`);
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    source.exec("ROLLBACK");
    source.close();
    if (connected) await client.end();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error && !("code" in error)
      ? error.message
      : `Database operation failed (${error?.code ?? error?.name ?? "unknown error"}).`;
  console.error(`SQLite-to-PostgreSQL migration stopped: ${message}`);
  process.exitCode = 1;
});
