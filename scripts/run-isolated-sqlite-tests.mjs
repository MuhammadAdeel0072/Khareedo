import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  MARKER_NAME,
  assertDisposableTestDatabase,
  canonicalPath,
  sqlitePathFromUrl,
} from "../tests/helpers/disposable-sqlite.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const backupRoots = [
  path.resolve(projectRoot, "..", "Khareedo-backup-before-prisma-install"),
  path.resolve(projectRoot, "..", "Khareedo-backup-before-supabase"),
];

function readDotEnvValue(name) {
  const envFile = path.join(projectRoot, ".env");
  if (!fs.existsSync(envFile)) return undefined;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function applicationDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL || readDotEnvValue("DATABASE_URL");
  if (!databaseUrl?.startsWith("file:")) return databaseUrl;

  const filePath = databaseUrl.slice("file:".length);
  if (path.isAbsolute(filePath) || /^[\\/][a-zA-Z]:[\\/]/.test(filePath)) {
    return databaseUrl;
  }
  if (filePath.includes("?") || filePath.includes("#")) return databaseUrl;

  try {
    return `file:${path.resolve(projectRoot, "prisma", decodeURIComponent(filePath))}`;
  } catch {
    return databaseUrl;
  }
}

function assertOutsideProtectedRoots(root) {
  const candidate = canonicalPath(root);
  const protectedRoots = [projectRoot, ...backupRoots].map(canonicalPath);
  for (const protectedRoot of protectedRoots) {
    const relative = path.relative(protectedRoot, candidate);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error("Temporary database directory overlaps the project or a protected backup directory.");
    }
  }

  const relativeToTemp = path.relative(canonicalPath(os.tmpdir()), candidate);
  if (!relativeToTemp || relativeToTemp.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTemp)) {
    throw new Error("Temporary database directory is not a child of the OS temporary directory.");
  }
}

function makeMarkedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "khareedo-sqlite-test-"));
  const token = crypto.randomUUID();
  const canonicalRoot = canonicalPath(root);
  assertOutsideProtectedRoots(canonicalRoot);
  fs.writeFileSync(path.join(canonicalRoot, MARKER_NAME), token, { flag: "wx" });
  return { root: canonicalRoot, token };
}

function createTestEnvironment(root, token, appUrl) {
  const databasePath = path.join(root, "khareedo-test.sqlite");
  if (fs.existsSync(databasePath)) {
    throw new Error("New disposable SQLite database path unexpectedly already exists.");
  }

  const databaseUrl = `file:${databasePath}`;
  if (appUrl?.startsWith("file:")) {
    const appPath = canonicalPath(sqlitePathFromUrl(appUrl));
    if (canonicalPath(databasePath) === appPath) {
      throw new Error("Disposable SQLite path matches the configured application database.");
    }
  }

  return {
    databasePath,
    databaseUrl,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      KHAREEDO_APPLICATION_DATABASE_URL: appUrl || "",
      KHAREEDO_DISPOSABLE_SQLITE_TEST: "1",
      KHAREEDO_DISPOSABLE_SQLITE_ROOT: root,
      KHAREEDO_DISPOSABLE_SQLITE_TOKEN: token,
      KHAREEDO_DISPOSABLE_SQLITE_DATABASE: canonicalPath(databasePath),
    },
  };
}

function removeOwnTemporaryRoot(root, token) {
  const canonicalRoot = canonicalPath(root);
  assertOutsideProtectedRoots(canonicalRoot);
  const marker = path.join(canonicalRoot, MARKER_NAME);
  if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== token) {
    throw new Error("Refusing cleanup: temporary directory marker is missing or does not match.");
  }
  if (canonicalRoot !== root || !fs.statSync(canonicalRoot).isDirectory()) {
    throw new Error("Refusing cleanup: temporary directory canonical path changed.");
  }
  fs.rmSync(canonicalRoot, { recursive: true, force: false });
}

function installSafepayTestConstraints(testEnvironment) {
  // Authoring only in Phase 3: this function runs only when the existing isolated
  // harness is explicitly executed. It cannot accept an application database path.
  const databasePath = assertDisposableTestDatabase(testEnvironment.env);
  assertOutsideProtectedRoots(path.dirname(databasePath));
  if (databasePath !== canonicalPath(testEnvironment.databasePath)) {
    throw new Error("Constraint target differs from the verified disposable database.");
  }

  const sql = fs.readFileSync(
    path.join(projectRoot, "prisma", "sqlite-safepay-test-constraints.sql"),
    "utf8"
  );
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    if (database.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
      throw new Error("Disposable SQLite foreign-key enforcement is disabled.");
    }
    database.exec(sql);
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Disposable SQLite schema contains foreign-key violations.");
    }
    console.log("SAFEPAY_TEST_CONSTRAINTS=INSTALLED (marked disposable SQLite only)");
  } finally {
    database.close();
  }
}

function runPrisma(args, env) {
  const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function selectTestFiles(arguments_) {
  const requested = arguments_.filter((argument) => argument !== "--check");
  const files = requested.length
    ? requested
    : [
        "tests/unit/integration.orders.test.ts",
        "tests/unit/integration.payment-relations.test.ts",
        "tests/unit/integration.safepay.test.ts",
        "tests/unit/integration.safepay-reservations.test.ts",
        "tests/unit/integration.safepay-webhook.test.ts",
        "tests/unit/integration.safepay-return-verify.test.ts",
        "tests/unit/integration.payment-settlement.test.ts",
      ];
  const unitTestRoot = path.join(projectRoot, "tests", "unit");

  return files.map((file) => {
    const absolutePath = path.resolve(projectRoot, file);
    const relativeToTests = path.relative(unitTestRoot, absolutePath);
    if (
      relativeToTests === "" ||
      relativeToTests === ".." ||
      relativeToTests.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToTests) ||
      !relativeToTests.endsWith(".test.ts") ||
      !fs.existsSync(absolutePath) ||
      !fs.statSync(absolutePath).isFile()
    ) {
      throw new Error("Only existing .test.ts files inside tests/unit may be run.");
    }

    return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
  });
}

function safetyCheck() {
  const appUrl = applicationDatabaseUrl();
  if (!appUrl) {
    throw new Error("Cannot verify isolation because no configured application DATABASE_URL was found.");
  }

  const { root, token } = makeMarkedRoot();
  try {
    const safe = createTestEnvironment(root, token, appUrl);
    if (fs.existsSync(safe.databasePath)) throw new Error("Dry-run unexpectedly found a database file.");

    let rejectedUnsafeUrl = false;
    try {
      assertDisposableTestDatabase({
        ...safe.env,
        DATABASE_URL: appUrl,
        KHAREEDO_DISPOSABLE_SQLITE_DATABASE: canonicalPath(sqlitePathFromUrl(safe.databaseUrl)),
      });
    } catch {
      rejectedUnsafeUrl = true;
    }
    if (!rejectedUnsafeUrl) throw new Error("Safety check accepted the configured application database URL.");

    const candidateRoot = path.join(root, "accepted-case");
    fs.mkdirSync(candidateRoot);
    const candidateToken = crypto.randomUUID();
    fs.writeFileSync(path.join(candidateRoot, MARKER_NAME), candidateToken, { flag: "wx" });
    const candidateDatabase = path.join(candidateRoot, "khareedo-test.sqlite");
    const candidateUrl = `file:${candidateDatabase}`;
    const candidateEnv = {
      ...safe.env,
      DATABASE_URL: candidateUrl,
      KHAREEDO_DISPOSABLE_SQLITE_ROOT: candidateRoot,
      KHAREEDO_DISPOSABLE_SQLITE_TOKEN: candidateToken,
      KHAREEDO_DISPOSABLE_SQLITE_DATABASE: canonicalPath(candidateDatabase),
    };
    fs.writeFileSync(candidateDatabase, "dry-run-only");
    if (assertDisposableTestDatabase(candidateEnv) !== canonicalPath(candidateDatabase)) {
      throw new Error("Safety check did not accept a correctly isolated disposable path.");
    }

    console.log("SAFETY_CHECK=PASS (unsafe application URL rejected; marked temporary SQLite path accepted)");
  } finally {
    removeOwnTemporaryRoot(root, token);
  }
}

function main() {
  safetyCheck();
  if (process.argv.includes("--check")) {
    console.log("DRY_RUN=PASS (no Prisma initialization or tests run)");
    return 0;
  }

  const testFiles = selectTestFiles(process.argv.slice(2));
  const appUrl = applicationDatabaseUrl();
  const { root, token } = makeMarkedRoot();
  let testEnvironment;
  try {
    testEnvironment = createTestEnvironment(root, token, appUrl);
    assertOutsideProtectedRoots(root);
    if (fs.existsSync(testEnvironment.databasePath)) {
      throw new Error("Refusing initialization because the disposable database already exists.");
    }

    console.log(`VERIFIED_DISPOSABLE_DATABASE=${canonicalPath(testEnvironment.databasePath)}`);
    console.log("APPLICATION_DATABASE_MATCH=false");

    const initStatus = runPrisma(
      ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"],
      testEnvironment.env
    );
    if (initStatus !== 0) throw new Error(`Prisma initialization failed with exit code ${initStatus}.`);
    if (!fs.existsSync(testEnvironment.databasePath)) {
      throw new Error("Prisma initialization did not create the verified disposable database.");
    }

    installSafepayTestConstraints(testEnvironment);

    const testStatus = spawnSync(
      process.execPath,
      [
        path.join(projectRoot, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--no-file-parallelism",
        ...testFiles,
      ],
      {
        cwd: projectRoot,
        env: testEnvironment.env,
        stdio: "inherit",
        windowsHide: true,
      }
    );
    if (testStatus.error) throw testStatus.error;
    if (testStatus.status !== 0) throw new Error(`Integration tests failed with exit code ${testStatus.status ?? 1}.`);
    return 0;
  } finally {
    removeOwnTemporaryRoot(root, token);
    console.log("DISPOSABLE_DATABASE_CLEANUP=VERIFIED_OWN_TEMP_DIRECTORY_ONLY");
  }
}

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown harness error.";
  console.error(`DISPOSABLE_SQLITE_HARNESS=FAILED: ${message}`);
  process.exitCode = 1;
}
