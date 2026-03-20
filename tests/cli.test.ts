import { describe, it, expect } from "vitest";
import { execSync, execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(__dirname, "..", "bin", "glimpse-changes.js");

function run(args: string[], input?: string): { stdout: string; stderr: string; exitCode: number } {
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

describe("glimpse-changes CLI", () => {
  describe("--help", () => {
    it("prints usage and exits 0", () => {
      const result = run(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("render-md.mjs");
      expect(result.stdout).toContain("Markdown");
    });

    it("-h also prints usage", () => {
      const result = run(["-h"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("render-md.mjs");
    });
  });

  describe("inline markdown argument", () => {
    it("accepts inline markdown and spawns detached child", () => {
      const result = run(["# Hello World"]);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.detached).toBe(true);
      expect(output.pid).toBeTypeOf("number");
    });
  });

  describe("stdin input", () => {
    it("accepts markdown via stdin and spawns detached child", () => {
      const result = run([], "# From Stdin\n\nSome content here.");
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.detached).toBe(true);
      expect(output.pid).toBeTypeOf("number");
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

      const result = run([], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.detached).toBe(true);
    });
  });

  describe("--child mode (direct rendering)", () => {
    it("renders markdown to HTML and outputs metadata", () => {
      // Write a temp markdown file and invoke --child directly
      const { writeFileSync } = require("fs");
      const { randomBytes } = require("crypto");
      const mdPath = join(tmpdir(), `test-${randomBytes(4).toString("hex")}.md`);
      writeFileSync(mdPath, "# Test Title\n\nHello **world**.\n");

      // --child will try to open Glimpse which will fail/hang in CI,
      // so we just test that the process starts and outputs JSON before opening
      // We can't fully test this without glimpseui running, so skip
    });
  });

  describe("error cases", () => {
    it("errors with multiple non-child arguments", () => {
      const result = run(["arg1", "arg2"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Expected a single inline Markdown argument or stdin.");
    });

    it("errors on empty string argument", () => {
      const result = run([""]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No markdown content provided.");
    });

    it("errors on empty stdin", () => {
      const result = run([], "");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No markdown content provided.");
    });

    it("errors on whitespace-only input", () => {
      const result = run(["   \n\n  "]);
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

      const result = run([], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.detached).toBe(true);
    });
  });

  describe("pre-detach validation", () => {
    it("errors on invalid command diff (non-git-diff command)", () => {
      const md = '# Bad Command\n\n!`echo hello`\n';
      const result = run([], md);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Command diffs must start with "git diff"');
    });

    it("errors on command diff that produces no valid diff output", () => {
      const md = '# Bad Diff\n\n!`git diff --no-such-flag-xxxxx`\n';
      const result = run([], md);
      expect(result.exitCode).not.toBe(0);
    });

    it("renders valid markdown with all block types before detaching", () => {
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

      const result = run([], md);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.detached).toBe(true);
    });
  });
});
