// Module customization hook for running TypeScript sources under plain Node.js
// (used by the process-error child-process tests — see
// tests/unit/process-error-monitoring.test.ts).
//
// Maps the repo's `@/...` path alias to `src/...` and the Next.js build-time
// `server-only` import to the same no-op stub Vitest uses, so a plain `node`
// process can import `src/instrumentation.ts` with type stripping and no
// bundler. This file is test infrastructure only; production code never loads it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// TypeScript sources are imported without an extension (`@/lib/db`); plain
// Node needs the real file, so resolve the extension the way a bundler would.
function toFileUrl(filePath) {
  const candidates = [filePath, `${filePath}.ts`, path.join(filePath, "index.ts")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return pathToFileURL(found ?? filePath).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      url: pathToFileURL(path.join(repoRoot, "tests/helpers/server-only.ts")).href,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith("@/")) {
    return {
      url: toFileUrl(path.join(repoRoot, "src", specifier.slice(2))),
      shortCircuit: true,
    };
  }
  // Relative imports of TypeScript sources without an extension (the harness
  // imports `../../src/instrumentation` extensionless so `tsc` stays happy).
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file://")
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const target = path.resolve(path.dirname(parentPath), specifier);
    if (!path.extname(target) && (fs.existsSync(`${target}.ts`) || fs.existsSync(path.join(target, "index.ts")))) {
      return { url: toFileUrl(target), shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
