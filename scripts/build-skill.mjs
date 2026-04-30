#!/usr/bin/env node

/**
 * Build the CLI and copy built artifacts into both skill directories:
 *   - skills/glimpse-changes/          (for GitHub-based installs)
 *   - packages/pi-glimpse-changes/skills/glimpse-changes/  (for npm installs)
 *
 * Also syncs SKILL.md from the canonical top-level skills/ copy into the
 * packages/ copy.
 */

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const cliPkg = join(root, "packages", "glimpse-changes");
const topSkill = join(root, "skills", "glimpse-changes");
const npmSkill = join(
  root,
  "packages",
  "pi-glimpse-changes",
  "skills",
  "glimpse-changes",
);

// 1. Build the CLI
console.log("Building CLI…");
execSync("pnpm run build", { cwd: cliPkg, stdio: "inherit" });

// 2. Ensure target directories exist
for (const dir of [
  join(topSkill, "bin"),
  join(topSkill, "assets"),
  join(npmSkill, "bin"),
  join(npmSkill, "assets"),
]) {
  mkdirSync(dir, { recursive: true });
}

// 3. Copy bin/glimpse-changes.js to both skill directories
const builtBin = join(cliPkg, "bin", "glimpse-changes.js");
for (const target of [topSkill, npmSkill]) {
  cpSync(builtBin, join(target, "bin", "glimpse-changes.js"));
  console.log(
    `  → ${join(target, "bin", "glimpse-changes.js").replace(root + "/", "")}`,
  );
}

// 4. Copy all asset files to both skill directories
const assetsDir = join(cliPkg, "assets");
const assetFiles = readdirSync(assetsDir);
for (const file of assetFiles) {
  for (const target of [topSkill, npmSkill]) {
    cpSync(join(assetsDir, file), join(target, "assets", file));
  }
}
console.log(`  → copied ${assetFiles.length} asset files to both skill dirs`);

// 5. Copy SKILL.md from canonical (top-level) to npm skill dir
cpSync(join(topSkill, "SKILL.md"), join(npmSkill, "SKILL.md"));
console.log("  → synced SKILL.md to packages/pi-glimpse-changes/");

console.log("\nDone.");
