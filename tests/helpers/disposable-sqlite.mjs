import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MARKER_NAME = ".khareedo-disposable-sqlite";

export function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function sqlitePathFromUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must use a file: SQLite URL.");
  }

  let filePath = databaseUrl.slice("file:".length);
  if (!filePath || filePath.includes("?") || filePath.includes("#")) {
    throw new Error("DATABASE_URL must identify one absolute SQLite file without query parameters.");
  }

  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    throw new Error("DATABASE_URL contains invalid path encoding.");
  }

  if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  if (!path.isAbsolute(filePath)) {
    throw new Error("DATABASE_URL must identify an absolute SQLite file.");
  }

  return path.normalize(filePath);
}

export function assertDisposableTestDatabase(env = process.env) {
  if (env.KHAREEDO_DISPOSABLE_SQLITE_TEST !== "1") {
    throw new Error("Database integration tests must run through the disposable SQLite harness.");
  }

  const root = env.KHAREEDO_DISPOSABLE_SQLITE_ROOT;
  const token = env.KHAREEDO_DISPOSABLE_SQLITE_TOKEN;
  if (!root || !token || !env.DATABASE_URL) {
    throw new Error("Disposable SQLite test marker, root, token, and DATABASE_URL are required.");
  }

  const canonicalRoot = canonicalPath(root);
  const canonicalTemp = canonicalPath(os.tmpdir());
  const relativeToTemp = path.relative(canonicalTemp, canonicalRoot);
  if (!relativeToTemp || relativeToTemp.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTemp)) {
    throw new Error("Disposable SQLite test directory must be a unique child of the OS temporary directory.");
  }

  const markerPath = path.join(canonicalRoot, MARKER_NAME);
  if (!fs.statSync(canonicalRoot).isDirectory() || fs.readFileSync(markerPath, "utf8") !== token) {
    throw new Error("Disposable SQLite marker does not match the test directory.");
  }

  const databasePath = sqlitePathFromUrl(env.DATABASE_URL);
  const canonicalDatabase = canonicalPath(databasePath);
  if (path.dirname(canonicalDatabase) !== canonicalRoot || path.basename(canonicalDatabase) !== "khareedo-test.sqlite") {
    throw new Error("SQLite database must be the designated file inside the marked temporary directory.");
  }

  if (env.KHAREEDO_DISPOSABLE_SQLITE_DATABASE !== canonicalDatabase) {
    throw new Error("Disposable SQLite database path does not match the verified runner path.");
  }

  const configuredApplicationUrl = env.KHAREEDO_APPLICATION_DATABASE_URL;
  if (configuredApplicationUrl) {
    const applicationPath = canonicalPath(sqlitePathFromUrl(configuredApplicationUrl));
    if (canonicalDatabase === applicationPath) {
      throw new Error("Disposable test database must differ from the configured application database.");
    }
  }

  if (!fs.existsSync(databasePath)) {
    throw new Error("Disposable SQLite database has not been initialized by the test harness.");
  }

  return canonicalDatabase;
}
