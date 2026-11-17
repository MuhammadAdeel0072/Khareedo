// Registers the `@/...` alias hook (./ts-alias-hooks.mjs) for plain-Node runs
// of TypeScript sources. Loaded via `node --import` before the entry file so
// the hook applies to every import in the process.
import { register } from "node:module";

register("./ts-alias-hooks.mjs", import.meta.url);
