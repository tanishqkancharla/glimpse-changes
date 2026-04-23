---
name: glimpse-changes
description: Create a visual explanation of the current session diff as a single HTML page and show it in a native Glimpse window. Use when the user wants a visual walkthrough of local code changes instead of a plain text diff.
metadata:
  author: tanishqkancharla
  version: "1.8.1"
---

# Glimpse Changes

Render a Markdown document in a native Glimpse window with syntax-highlighted code and rich diff rendering.

## Default change-doc format

When creating a change-doc for Glimpse, use this structure by default:

1. A short, specific title.
2. A `## Summary` section with a concise bulleted list of the main changes.
3. One section per logical change, each with:
   - a clear section title
   - a short explanation of what changed and why
   - a diff, preferably a live `git diff` command block

Prefer grouping by logical concern instead of by file whenever possible.
Lead with rationale, then show the diff that supports it.

Template:

````md
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

Prefer piping markdown over stdin. This avoids shell-quoting issues, especially
for command diffs that use backticks.

```bash
cat report.md | npx glimpse-changes
cat report.md | npx glimpse-changes -

cat <<'EOF' | npx glimpse-changes -
# Title

Content
EOF
```

You can still pass a single inline markdown argument for simple content:

```bash
npx glimpse-changes "# Title\n\nContent"
```

The CLI opens a Glimpse window and blocks until closed.

## Review workflow

This skill is not just for rendering a nice diff view — it can also collect
user review feedback.

- Use the default blocking mode when you only need to show the content and wait.
- In an interactive agent session, prefer a user-driven workflow: open the
  review, ask the user to review it, and wait for them to tell you when they
  are done.
- Use `--background` only when you specifically want an asynchronous workflow.
- In background mode, the CLI prints a review file path.
- That file contains `__PENDING__` until the window is closed.
- Once the user is done, the file contains either their review text or a
  no-review completion message.

Default interactive agent flow:

1. Render the report for the user.
2. Tell the user to review it in Glimpse.
3. Wait for the user to say they are finished.
4. Then continue the task.

Asynchronous/background flow (only when explicitly useful):

1. Render the report with `npx glimpse-changes --background -`.
2. Capture the printed review file path.
3. Poll that file until it is no longer `__PENDING__`.
4. Read the review text and continue the task.

### Background mode

Use `--background` to open the window without blocking:

```bash
npx glimpse-changes --background "# Title\n\nContent"
# prints: Glimpse window opened. Read /tmp/glimpse-review-<id>.txt for user feedback.
```

The output file contains `__PENDING__` until the user closes the window, then it contains the review text. Poll by reading the file and checking whether it still says `__PENDING__`. If the user closes the window without adding review comments, the file will contain a no-review completion message.

## Diff blocks

**Command diffs** — executed at render time, must start with `git diff`:

```
!`git diff -- path/to/file`
```

When using command diffs, prefer piping markdown via stdin or a heredoc:

```bash
cat <<'EOF' | npx glimpse-changes -
## Changes

!`git diff -- path/to/file`
EOF
```

**Full unified diffs** — paste standard `git diff` output in a `diff` fenced block:

````
```diff
diff --git a/foo.txt b/foo.txt
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 context
-old
+new
```
````

**Inline diffs** — bare `+`/`-`/` ` prefixed lines in a `diff` fenced block:

````
```diff
-removed line
+added line
 context line
```
````

Every non-empty line must start with `+`, `-`, or a space. Invalid lines cause an error.

For added-file snippets, you can start with `+++ path/to/file.ext` and keep the remaining lines prefixed with `+`. The renderer will synthesize a proper new-file diff so the filename and syntax highlighting are preserved.

## Code blocks

Fenced code blocks with a language tag get syntax highlighting via `@pierre/diffs`:

````
```js
const x = 1;
```
````

## Typical workflow

1. Inspect changes with `git diff`, `git status`, etc.
2. Write the change-doc using the default format: title, summary bullets, then rationale-plus-diff sections.
3. Pipe it to `npx glimpse-changes`.
4. Ask the user to review it and tell you when they are done.
5. Only use `--background` and review-file polling for explicitly asynchronous workflows.

Prefer command diffs (`!`git diff ...``) over pasting raw diff content — they always reflect the current working tree. Prefer stdin/heredocs over inline shell-quoted arguments when command diffs are involved.
