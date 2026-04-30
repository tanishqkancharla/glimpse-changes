#!/usr/bin/env node

/**
 * End-to-end test for the bundled skill.
 *
 * Simulates what happens when a user installs the skill:
 *   1. Copy the skill directory to a fresh temp location (like `npx skills add` does)
 *   2. Run `npm install` (the setup step from SKILL.md)
 *   3. Run the bundled CLI with --dry-run and verify it works
 *   4. Verify the rendered HTML contains expected asset references
 *
 * Tests both install paths:
 *   - GitHub-based: top-level skills/glimpse-changes/
 *   - npm-based:    packages/pi-glimpse-changes/skills/glimpse-changes/
 */

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const skillSources = [
  {
    label: "GitHub-based (skills/glimpse-changes/)",
    path: join(root, "skills", "glimpse-changes"),
  },
  {
    label: "npm-based (packages/pi-glimpse-changes/skills/glimpse-changes/)",
    path: join(
      root,
      "packages",
      "pi-glimpse-changes",
      "skills",
      "glimpse-changes",
    ),
  },
];

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    failed++;
    failures.push(message);
    console.error(`    ✗ ${message}`);
  } else {
    passed++;
    console.log(`    ✓ ${message}`);
  }
}

function runCli(binPath, args, input) {
  try {
    const stdout = execFileSync("node", [binPath, ...args], {
      encoding: "utf8",
      input,
      timeout: 15_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

for (const source of skillSources) {
  console.log(`\n── ${source.label}`);

  // 1. Verify source exists
  if (!existsSync(source.path)) {
    assert(false, `source directory exists at ${source.path}`);
    continue;
  }
  assert(true, "source directory exists");

  // 2. Verify expected files are present in source
  const expectedFiles = [
    "SKILL.md",
    "package.json",
    "bin/glimpse-changes.js",
    "assets/critique-base.css",
    "assets/critique-markdown.css",
    "assets/annotations.css",
    "assets/annotations.js",
    "assets/jetbrains-mono-nerd.woff2",
  ];
  for (const f of expectedFiles) {
    assert(existsSync(join(source.path, f)), `has ${f}`);
  }

  // 3. Copy to a fresh temp directory (simulates `npx skills add`)
  const tmpDir = mkdtempSync(join(tmpdir(), "skill-test-"));
  const installedSkill = join(tmpDir, "glimpse-changes");
  try {
    cpSync(source.path, installedSkill, { recursive: true });
    assert(true, "copied to temp directory");

    // 4. Run npm install (the setup step)
    try {
      execSync("npm install", {
        cwd: installedSkill,
        stdio: "pipe",
        timeout: 30_000,
      });
      assert(true, "npm install succeeded");
    } catch (err) {
      assert(false, `npm install failed: ${err.stderr || err.message}`);
      continue;
    }

    const bin = join(installedSkill, "bin", "glimpse-changes.js");

    // 5. --help works
    const helpResult = runCli(bin, ["--help"]);
    assert(helpResult.exitCode === 0, "--help exits 0");
    assert(
      helpResult.stdout.includes("Markdown"),
      "--help output mentions Markdown",
    );

    // 6. --dry-run with inline arg
    const dryRunResult = runCli(bin, ["--dry-run", "# Test Title"]);
    assert(dryRunResult.exitCode === 0, "--dry-run inline arg exits 0");
    if (dryRunResult.exitCode === 0) {
      const output = JSON.parse(dryRunResult.stdout.trim());
      assert(output.dryRun === true, "--dry-run output has dryRun: true");
      assert(
        output.title === "Test Title",
        "--dry-run output has correct title",
      );

      // 7. Verify rendered HTML has inlined assets (CSS + base64 font)
      if (output.htmlPath && existsSync(output.htmlPath)) {
        const html = readFileSync(output.htmlPath, "utf8");
        assert(
          html.includes("@font-face") &&
            html.includes("JetBrains Mono Nerd"),
          "rendered HTML embeds base64 font via @font-face",
        );
        assert(
          html.includes("<style>") && html.includes("font-smoothing"),
          "rendered HTML inlines CSS in <style> blocks",
        );
      } else {
        assert(false, `rendered HTML exists at ${output.htmlPath}`);
      }
    }

    // 8. --dry-run with stdin
    const stdinResult = runCli(
      bin,
      ["--dry-run", "-"],
      "# Stdin Test\n\nHello world\n\n```js\nconst x = 1;\n```\n",
    );
    assert(stdinResult.exitCode === 0, "--dry-run stdin exits 0");
    if (stdinResult.exitCode === 0) {
      const output = JSON.parse(stdinResult.stdout.trim());
      assert(output.title === "Stdin Test", "stdin title parsed correctly");
    }

    // 9. Error on empty input
    const emptyResult = runCli(bin, ["--dry-run", ""]);
    assert(emptyResult.exitCode !== 0, "empty input exits non-zero");
    assert(
      emptyResult.stderr.includes("No markdown content"),
      "empty input error message is correct",
    );
  } finally {
    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Summary
console.log(`\n${"─".repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f}`);
  }
  process.exit(1);
}
