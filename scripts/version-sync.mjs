#!/usr/bin/env node

/**
 * Sync or check that all version fields match the root package.json version.
 *
 * Usage:
 *   node scripts/version-sync.mjs          # write root version into all targets
 *   node scripts/version-sync.mjs --check  # verify all targets match (exit 1 on mismatch)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes("--check");

// Source of truth
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = rootPkg.version;

if (!version) {
  console.error("No version field in root package.json");
  process.exit(1);
}

// Targets: package.json files
const packageJsonTargets = [
  "packages/glimpse-changes/package.json",
  "packages/pi-glimpse-changes/package.json",
];

// Targets: SKILL.md frontmatter
const skillTargets = [
  "packages/pi-glimpse-changes/skills/glimpse-changes/SKILL.md",
  "skills/glimpse-changes/SKILL.md",
];

let mismatches = 0;

// Sync package.json files
for (const rel of packageJsonTargets) {
  const abs = join(root, rel);
  const pkg = JSON.parse(readFileSync(abs, "utf8"));

  if (pkg.version === version) continue;

  mismatches++;
  if (checkOnly) {
    console.error(`✗ ${rel}: ${pkg.version} (expected ${version})`);
  } else {
    pkg.version = version;
    writeFileSync(abs, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.log(`✓ ${rel} → ${version}`);
  }
}

// Sync SKILL.md frontmatter version
for (const rel of skillTargets) {
  const abs = join(root, rel);
  const content = readFileSync(abs, "utf8");

  // Match version in YAML frontmatter: `  version: "x.y.z"` or `  version: x.y.z`
  const pattern = /^(\s+version:\s*)"?[^"\n]+"?/m;
  const match = pattern.exec(content);

  if (!match) {
    console.error(`✗ ${rel}: no version field found in frontmatter`);
    mismatches++;
    continue;
  }

  const currentVersion = match[0].replace(match[1], "").replace(/"/g, "");
  if (currentVersion === version) continue;

  mismatches++;
  if (checkOnly) {
    console.error(`✗ ${rel}: ${currentVersion} (expected ${version})`);
  } else {
    const updated = content.replace(pattern, `${match[1]}"${version}"`);
    writeFileSync(abs, updated, "utf8");
    console.log(`✓ ${rel} → ${version}`);
  }
}

if (checkOnly && mismatches > 0) {
  console.error(
    `\n${mismatches} version mismatch(es) found. Run \`pnpm version:sync\` to fix.`,
  );
  process.exit(1);
}

if (checkOnly && mismatches === 0) {
  console.log(`All versions match: ${version}`);
}

if (!checkOnly && mismatches === 0) {
  console.log(`All versions already at ${version}`);
}
