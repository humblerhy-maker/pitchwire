/**
 * Nitro bundles @electric-sql/pglite into the Vercel function but does not
 * emit the sibling wasm/data files that PGlite loads via import.meta.url.
 * Copy them next to the bundled module so preview and deploy can open PGLite.
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@electric-sql/pglite/dist");
const dest = join(root, ".vercel/output/functions/__server.func/_libs");
const files = ["pglite.wasm", "pglite.data", "initdb.wasm"];

if (!existsSync(dest)) {
  console.log("[pglite] no nitro function bundle — skip asset copy");
  process.exit(0);
}

for (const name of files) {
  const from = join(src, name);
  if (!existsSync(from)) {
    console.error(`[pglite] missing ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(dest, name));
  console.log(`[pglite] copied ${name}`);
}
