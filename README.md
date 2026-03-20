# glimpse-changes

A CLI tool that renders Markdown with inline diffs into a native [Glimpse](https://glimpse.app) window, using a Critique-like theme.

<img width="1656" height="1740" alt="Screenshot 2026-03-19 at 8 06 49 PM" src="https://github.com/user-attachments/assets/93cf947e-3f48-40bd-91cf-ee47c3d5a9c9" />

## What it does

- Parses Markdown and renders it as a styled HTML page
- Renders fenced `diff` blocks with [`@pierre/diffs`](https://esm.sh/@pierre/diffs) (split layout by default)
- Executes inline command diffs (`` !`git diff ...` ``) at render time so diffs always reflect the current working tree
- Opens the result in a native Glimpse window via the `glimpseui` package

## Usage

```bash
# Inline Markdown argument
bun scripts/render-md.ts "# My Report\n\nSome content"

# Pipe from a file
cat /tmp/session-diff-report.md | bun scripts/render-md.ts
```

### Inline command diffs

In your Markdown, use the `` !`<command>` `` syntax to execute a shell command and render its output as a diff block:

````markdown
## Changes to auth module

!`git diff -- src/auth.ts`
````

### Fenced diff blocks

Fenced code blocks with language `diff` (or any block whose lines match unified diff patterns) are also rendered with `@pierre/diffs`:

````markdown
```diff
- old line
+ new line
```
````

## Assets

| File | Purpose |
|------|---------|
| `assets/critique-base.css` | Base Critique-style CSS |
| `assets/critique-markdown.css` | Markdown layout and diff shell styling |
| `assets/jetbrains-mono-nerd.woff2` | Embedded monospace font (loaded as base64) |

## Requirements

- [Bun](https://bun.sh) runtime
- [Glimpse](https://glimpse.app) installed
