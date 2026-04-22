import { describe, it, expect } from "vitest";
import { execSync, execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(__dirname, "..", "bin", "glimpse-changes.js");

function run(
  args: string[],
  input?: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      input,
      timeout: 10_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section"
  );
}

function readRenderedHtml(title: string) {
  const htmlPath = join(tmpdir(), `${slugify(title)}.html`);
  expect(existsSync(htmlPath)).toBe(true);
  return readFileSync(htmlPath, "utf8");
}

function decodeBase64DataAttribute(html: string, attribute: string) {
  const match = new RegExp(`${attribute}="([^"]+)"`).exec(html);
  expect(match).not.toBeNull();
  return Buffer.from(match![1], "base64").toString("utf8");
}

describe("glimpse-changes CLI", () => {
  describe("--help", () => {
    it("prints usage and exits 0", () => {
      const result = run(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("glimpse-changes");
      expect(result.stdout).toContain("Markdown");
    });

    it("-h also prints usage", () => {
      const result = run(["-h"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("glimpse-changes");
    });
  });

  describe("inline markdown argument", () => {
    it("accepts inline markdown with --dry-run", () => {
      const result = run(["--dry-run", "# Hello World"]);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
      expect(output.htmlPath).toBeTypeOf("string");
    });
  });

  describe("stdin input", () => {
    it("accepts markdown via stdin with --dry-run", () => {
      const result = run(["--dry-run"], "# From Stdin\n\nSome content here.");
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
    });

    it("handles complex markdown via stdin", () => {
      const md = [
        "# Code Review",
        "",
        "## Summary",
        "",
        "Here are some changes:",
        "",
        "- Item one",
        "- Item two",
        "- Item three",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "> A blockquote",
        "",
        "1. First",
        "2. Second",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
    });
  });

  describe("error cases", () => {
    it("errors with multiple non-child arguments", () => {
      const result = run(["arg1", "arg2"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "Expected a single inline Markdown argument or stdin.",
      );
    });

    it("errors on empty string argument", () => {
      const result = run(["--dry-run", ""]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No markdown content provided.");
    });

    it("errors on empty stdin", () => {
      const result = run(["--dry-run"], "");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No markdown content provided.");
    });

    it("errors on whitespace-only input", () => {
      const result = run(["--dry-run", "   \n\n  "]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No markdown content provided.");
    });
  });

  describe("diff rendering via stdin", () => {
    it("handles markdown with embedded diff blocks", () => {
      const md = [
        "# Diff Test",
        "",
        "```diff",
        "diff --git a/foo.txt b/foo.txt",
        "--- a/foo.txt",
        "+++ b/foo.txt",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-old line",
        "+new line",
        " line3",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
    });
  });

  describe("inline diff blocks", () => {
    it("preserves added-file paths for inline diff shorthands", () => {
      const title = "Inline Added File Diff";
      const md = [
        `# ${title}`,
        "",
        "```diff",
        "+++ packages/libretto/test/create-libretto.spec.ts",
        "+const result = await execProcess(",
        "+  process.execPath,",
        '+  [createLibrettoBin, "--skip-browsers"],',
        "+  workspaceDir,",
        "+);",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);

      const html = readRenderedHtml(title);
      const patch = decodeBase64DataAttribute(html, "data-diff-patch");

      expect(patch).toContain(
        "diff --git a/packages/libretto/test/create-libretto.spec.ts b/packages/libretto/test/create-libretto.spec.ts",
      );
      expect(patch).toContain("new file mode 100644");
      expect(patch).toContain("--- /dev/null");
      expect(patch).toContain(
        "+++ b/packages/libretto/test/create-libretto.spec.ts",
      );
      expect(patch).toContain('+  [createLibrettoBin, "--skip-browsers"],');
      expect(patch).not.toContain(
        "@@ -0,0 +1,5 @@\n+++ packages/libretto/test/create-libretto.spec.ts",
      );
    });

    it("handles bare inline diff with +/- lines", () => {
      const md = [
        "# Inline Diff",
        "",
        "```diff",
        "- old line",
        "+ new line",
        "  context line",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
    });

    it("handles inline diff with only additions", () => {
      const md = [
        "# Additions Only",
        "",
        "```diff",
        "+ added line 1",
        "+ added line 2",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
    });

    it("handles inline diff with only removals", () => {
      const md = [
        "# Removals Only",
        "",
        "```diff",
        "- removed line 1",
        "- removed line 2",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
    });

    it("errors on invalid inline diff lines", () => {
      const md = [
        "# Bad Inline Diff",
        "",
        "```diff",
        "this line has no prefix",
        "+ good line",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid inline diff at line 1");
    });

    it("still handles full unified diffs tagged as diff", () => {
      const md = [
        "# Full Unified",
        "",
        "```diff",
        "diff --git a/foo.txt b/foo.txt",
        "--- a/foo.txt",
        "+++ b/foo.txt",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-old line",
        "+new line",
        " line3",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
    });

    it("does not auto-detect mixed code blocks as diffs", () => {
      const title = "Mixed Code Block";
      const md = [
        `# ${title}`,
        "",
        "```ts",
        "const positive = +value;",
        "const negative = -otherValue;",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);

      const html = readRenderedHtml(title);
      expect(html).toContain('<div class="code-shell" data-code-shell');
      expect(html).not.toContain('<div class="diff-shell" data-diff-shell');
    });
  });

  describe("pre-detach validation", () => {
    it("errors on invalid command diff (non-git-diff command)", () => {
      const md = "# Bad Command\n\n!`echo hello`\n";
      const result = run(["--dry-run"], md);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        'Command diffs must start with "git diff"',
      );
    });

    it("errors on command diff that produces no valid diff output", () => {
      const md = "# Bad Diff\n\n!`git diff --no-such-flag-xxxxx`\n";
      const result = run(["--dry-run"], md);
      expect(result.exitCode).not.toBe(0);
    });

    it("renders valid markdown with all block types", () => {
      const md = [
        "# Full Test",
        "",
        "Some **bold** and *italic* text.",
        "",
        "- list item",
        "",
        "1. ordered item",
        "",
        "> blockquote",
        "",
        "---",
        "",
        "| Col1 | Col2 |",
        "| ---- | ---- |",
        "| a    | b    |",
        "",
        "```js",
        "const x = 1;",
        "```",
      ].join("\n");

      const result = run(["--dry-run"], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dryRun).toBe(true);
    });
  });
});
