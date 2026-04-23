# glimpse-changes

A CLI tool that renders Markdown with inline diffs into a native [Glimpse](https://glimpse.app) window, using a Critique-like theme.

<img width="2742" height="2356" alt="Screenshot 2026-03-19 at 8 23 28 PM" src="https://github.com/user-attachments/assets/339a78c5-983c-4a96-ac5e-10f55b632330" />

## What it does

- Parses Markdown and renders it as a styled HTML page
- Renders fenced `diff` blocks with [`@pierre/diffs`](https://esm.sh/@pierre/diffs) (split layout by default)
- Executes inline command diffs (`` !`git diff ...` ``) at render time so diffs always reflect the current working tree
- Opens the result in a native Glimpse window via the `glimpseui` package

## Installation

```bash
npx skills add tanishqkancharla/glimpse-changes
```

## Default change-doc format

When using Glimpse Changes for a review or walkthrough, structure the
change-doc like this by default:

1. A short, specific title
2. A `## Summary` section with concise bullets
3. One section per logical change, each with:
   - a clear heading
   - a short rationale
   - a diff, ideally a live `git diff` command block

Prefer grouping by logical concern instead of file-by-file when possible.
Lead with rationale, then show the diff.

````markdown
# <Title>

## Summary
- Change 1
- Change 2
- Change 3

## <Section title>
What changed and why it matters.

!`git diff -- path/to/file`

## <Another section title>
More rationale for this group of changes.

```diff
diff --git a/foo.ts b/foo.ts
...
```
````

Example:

```bash
cat <<'EOF' | npx glimpse-changes -
# Improve review flow messaging

## Summary
- clarify the default blocking review flow
- document when to use background mode
- add stronger guidance for user-driven review sessions

## Clarify the default review flow
Explain that agents should usually open the review, ask the user to inspect it,
and wait until the user says they are done.

!`git diff -- packages/glimpse-changes/skills/glimpse-changes/SKILL.md`
EOF
```

## Usage

```bash
# Pipe from a file
cat /tmp/session-diff-report.md | bun scripts/render-md.ts

# Force stdin with '-'
cat /tmp/session-diff-report.md | bun scripts/render-md.ts -

# Heredoc for content with command diffs
cat <<'EOF' | bun scripts/render-md.ts -
# My Report

!`git diff -- src/auth.ts`
EOF

# Inline Markdown argument (best for simple content without command diffs)
bun scripts/render-md.ts "# My Report\n\nSome content"
```

### Inline command diffs

In your Markdown, use the `` !`<command>` `` syntax to execute a shell command and render its output as a diff block:

````markdown
## Changes to auth module

!`git diff -- src/auth.ts`
````

Prefer piping or heredocs for command diffs instead of shell-quoted inline
arguments. That avoids quoting issues with the embedded backticks.

### Fenced diff blocks

Fenced code blocks with language `diff` (or any block whose lines match unified diff patterns) are also rendered with `@pierre/diffs`:

````markdown
```diff
- old line
+ new line
```
````

For added-file snippets, you can also start the block with `+++ path/to/file.ext` and keep each added line prefixed with `+`. Glimpse Changes will synthesize a proper new-file diff so the file path and syntax highlighting are preserved.

## Assets

| File | Purpose |
|------|---------|
| `assets/critique-base.css` | Base Critique-style CSS |
| `assets/critique-markdown.css` | Markdown layout and diff shell styling |
| `assets/jetbrains-mono-nerd.woff2` | Embedded monospace font (loaded as base64) |

## Requirements

- [Bun](https://bun.sh) runtime
- [Glimpse](https://glimpse.app) installed
