#!/usr/bin/env bun

import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { open } from "glimpseui";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = dirname(scriptDir);
const assetsDir = join(skillDir, "assets");
const DEFAULT_DIFFS_MODULE_URL = "https://esm.sh/@pierre/diffs@1.1.1?bundle";
const DEFAULT_DIFFS_SSR_MODULE_URL =
  "https://esm.sh/@pierre/diffs@1.1.1/ssr?bundle";
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 920;

function printUsage() {
  console.log(`glimpse-changes [options] [markdown]

Render Markdown into a styled HTML page and open it in a Glimpse window.
Blocks until the window is closed.

Options:
  --dry-run      Render to file only, don't open Glimpse
  --background   Open window in background, print output file path, exit immediately

Input:
  - Prefer piping Markdown over stdin (for example with a heredoc), or
  - pass a single inline Markdown argument for simple content.

Tips:
  - Use '-' to force reading from stdin: npx glimpse-changes -
`);
}

function parseInput(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--") || a === "-h"));
  const positional = argv.filter((a) => !a.startsWith("--") && a !== "-h");

  if (flags.has("--help") || flags.has("-h")) {
    printUsage();
    process.exit(0);
  }

  const dryRun = flags.has("--dry-run");
  const background = flags.has("--background");

  if (positional.length > 1) {
    throw new Error("Expected a single inline Markdown argument or stdin.");
  }

  const input = positional[0] ?? null;
  const readFromStdin = input === "-";

  return {
    markdown: readFromStdin ? null : input,
    readFromStdin,
    dryRun,
    background,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section"
  );
}

function encodeBase64Utf8(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function formatUnifiedRange(start, count) {
  if (count === 1) return `${start}`;
  if (count === 0) return `${start},0`;
  return `${start},${count}`;
}

function isValidUnifiedHunkHeader(line) {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line);
}

function isMalformedHunkHeader(line) {
  return /^@@(?:\s.*)?$/.test(line) && !isValidUnifiedHunkHeader(line);
}

function normalizePatchForDiffs(patch) {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const normalized = [];
  let index = 0;
  let oldStart = 1;
  let newStart = 1;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("diff --git ")) {
      oldStart = 1;
      newStart = 1;
      normalized.push(line);
      index += 1;
      continue;
    }

    if (!isMalformedHunkHeader(line)) {
      normalized.push(line);
      index += 1;
      continue;
    }

    const hunkLines = [];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next.startsWith("diff --git ") || next.startsWith("@@")) break;
      hunkLines.push(next);
      index += 1;
    }

    let oldCount = 0;
    let newCount = 0;
    for (const hunkLine of hunkLines) {
      if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
        newCount += 1;
      } else if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
        oldCount += 1;
      } else {
        oldCount += 1;
        newCount += 1;
      }
    }

    normalized.push(
      `@@ -${formatUnifiedRange(oldStart, oldCount)} +${formatUnifiedRange(newStart, newCount)} @@`,
    );
    normalized.push(...hunkLines);
    oldStart += oldCount;
    newStart += newCount;
  }

  return normalized.join("\n");
}

function parseInline(text) {
  const codeSpans = [];
  const withPlaceholders = text.replace(/`([^`]+)`/g, (_, code) => {
    const key = `__CODE_${codeSpans.length}__`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return key;
  });

  let escaped = escapeHtml(withPlaceholders);
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = escapeHtml(href);
    return `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  escaped = escaped.replace(
    /(^|[\s(])(https?:\/\/[^\s)]+)/g,
    (_, lead, href) => {
      const safeHref = escapeHtml(href);
      return `${lead}<a href="${safeHref}" target="_blank" rel="noreferrer">${safeHref}</a>`;
    },
  );

  return codeSpans.reduce(
    (result, html, index) => result.replace(`__CODE_${index}__`, html),
    escaped,
  );
}

function renderDiffBlock(code) {
  const patchBase64 = encodeBase64Utf8(normalizePatchForDiffs(code));

  return `<div class="diff-shell" data-diff-shell data-diff-patch="${patchBase64}">
    <div class="diff-mount" data-diff-hosts></div>
  </div>`;
}

function renderPlainCodeBlock(code, language) {
  const lang = (language || "").trim().toLowerCase();
  const contentsBase64 = encodeBase64Utf8(code.replace(/\n$/, ""));
  const filename = lang ? `file.${lang}` : "file.txt";
  return `<div class="code-shell" data-code-shell data-code-contents="${contentsBase64}" data-code-filename="${escapeHtml(filename)}" data-code-lang="${escapeHtml(lang || "text")}"><div class="code-label">${escapeHtml(lang || "text")}</div><pre class="code-block"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`;
}

function renderChangesBlock(code) {
  const lines = code.split("\n").filter((l) => l.trim() !== "");
  const fileHtmlParts = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const rangeMatch = /^(.+):([0-9]+)-([0-9]+)$/.exec(trimmed);
    const filepath = rangeMatch ? rangeMatch[1] : trimmed;
    const focusStart = rangeMatch ? rangeMatch[2] : "";
    const focusEnd = rangeMatch ? rangeMatch[3] : "";

    let oldContents = null;
    let newContents = null;

    try {
      oldContents = execSync(`git show HEAD:./${filepath}`, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      oldContents = null;
    }

    try {
      newContents = readFileSync(filepath, "utf8");
    } catch {
      newContents = null;
    }

    if (oldContents === null && newContents === null) {
      fileHtmlParts.push(
        `<div class="changes-file-error">Could not resolve: ${escapeHtml(filepath)}</div>`,
      );
      continue;
    }

    const attrs = [
      `data-file-name="${escapeHtml(filepath)}"`,
      oldContents !== null
        ? `data-old-contents="${encodeBase64Utf8(oldContents)}"`
        : null,
      newContents !== null
        ? `data-new-contents="${encodeBase64Utf8(newContents)}"`
        : null,
      `data-focus-start="${escapeHtml(focusStart)}"`,
      `data-focus-end="${escapeHtml(focusEnd)}"`,
    ]
      .filter(Boolean)
      .join(" ");

    fileHtmlParts.push(
      `<div class="changes-file" ${attrs}>
    <div class="changes-file-header">${escapeHtml(filepath)}</div>
    <div class="changes-mount"></div>
  </div>`,
    );
  }

  return `<div class="changes-shell" data-changes-shell>
  ${fileHtmlParts.join("\n  ")}
</div>`;
}

function hasUnifiedDiffStructure(lines) {
  return lines.some(
    (line) => line.startsWith("diff --git ") || isValidUnifiedHunkHeader(line),
  );
}

function isInlineDiffCandidate(lines) {
  const nonEmptyLines = lines.filter((line) => line !== "");
  return (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => /^[+\- ]/.test(line))
  );
}

function normalizeInlineDiffPath(path) {
  return path.trim().replace(/^[ab]\//, "");
}

function tryWrapInlineFileDiffAsUnified(lines) {
  const firstLine = lines[0] ?? "";
  const addedFileMatch = /^\+\+\+\s+(.+)$/.exec(firstLine);
  if (addedFileMatch) {
    const filename = normalizeInlineDiffPath(addedFileMatch[1]);
    const bodyLines = lines.slice(1);
    const hasOnlyAdditions = bodyLines.every(
      (line) => line === "" || line.startsWith("+"),
    );

    if (filename && bodyLines.length > 0 && hasOnlyAdditions) {
      const newCount = bodyLines.filter((line) => line !== "").length;
      return [
        `diff --git a/${filename} b/${filename}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filename}`,
        `@@ -0,0 +${formatUnifiedRange(1, newCount)} @@`,
        ...bodyLines,
      ].join("\n");
    }
  }

  const deletedFileMatch = /^---\s+(.+)$/.exec(firstLine);
  if (deletedFileMatch) {
    const filename = normalizeInlineDiffPath(deletedFileMatch[1]);
    const bodyLines = lines.slice(1);
    const hasOnlyRemovals = bodyLines.every(
      (line) => line === "" || line.startsWith("-"),
    );

    if (filename && bodyLines.length > 0 && hasOnlyRemovals) {
      const oldCount = bodyLines.filter((line) => line !== "").length;
      return [
        `diff --git a/${filename} b/${filename}`,
        "deleted file mode 100644",
        `--- a/${filename}`,
        "+++ /dev/null",
        `@@ -${formatUnifiedRange(1, oldCount)} +0,0 @@`,
        ...bodyLines,
      ].join("\n");
    }
  }

  return null;
}

function validateInlineDiffLines(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    if (/^[+\- ]/.test(line)) continue;
    throw new Error(
      `Invalid inline diff at line ${i + 1}: every non-empty line must start with '+', '-', or ' ' (space). Got: ${JSON.stringify(line)}`,
    );
  }
}

function wrapInlineDiffAsUnified(code) {
  const lines = code.replace(/\n$/, "").split("\n");

  const filePatch = tryWrapInlineFileDiffAsUnified(lines);
  if (filePatch) {
    return filePatch;
  }

  validateInlineDiffLines(lines);

  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line === "") continue;
    const prefix = line[0];
    if (prefix === "-") {
      oldCount += 1;
    } else if (prefix === "+") {
      newCount += 1;
    } else {
      oldCount += 1;
      newCount += 1;
    }
  }

  const header = [
    "diff --git a/file b/file",
    "--- a/file",
    "+++ b/file",
    `@@ -${formatUnifiedRange(1, oldCount)} +${formatUnifiedRange(1, newCount)} @@`,
  ];

  return [...header, ...lines].join("\n");
}

function renderCodeBlock(code, language) {
  const lang = (language || "").trim().toLowerCase();
  const lines = code.replace(/\n$/, "").split("\n");

  if (lang === "diff") {
    if (hasUnifiedDiffStructure(lines)) {
      return renderDiffBlock(code);
    }
    return renderDiffBlock(wrapInlineDiffAsUnified(code));
  }

  const isDiff = hasUnifiedDiffStructure(lines) || isInlineDiffCandidate(lines);
  if (isDiff) {
    return renderDiffBlock(code);
  }

  return renderPlainCodeBlock(code, language);
}

function parseFenceOpen(trimmed) {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
  if (!match) return null;

  return {
    markerChar: match[1][0],
    markerLength: match[1].length,
    language: match[2].trim(),
  };
}

function isFenceClose(trimmed, opener) {
  const close = new RegExp(
    `^${opener.markerChar}{${opener.markerLength},}\\s*$`,
  );
  return close.test(trimmed);
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const headings = [];
  let index = 0;
  let blockIndex = 0;

  const isBlockBoundary = (line) =>
    line.trim() === "" ||
    /^#{1,6}\s+/.test(line) ||
    /^(`{3,}|~{3,})/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^([-*_])\1{2,}\s*$/.test(line) ||
    /^\|(.+)\|/.test(line.trim());

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const id = slugify(text);
      if (level <= 3) headings.push({ level, text, id });
      html.push(`<h${level} id="${id}" data-block-index="${blockIndex++}">${parseInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    const fenceOpen = parseFenceOpen(trimmed);
    if (fenceOpen) {
      const buffer = [];
      index += 1;
      while (
        index < lines.length &&
        !isFenceClose(lines[index].trim(), fenceOpen)
      ) {
        buffer.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      if (fenceOpen.language === "changes") {
        html.push(renderChangesBlock(buffer.join("\n")));
      } else {
        html.push(renderCodeBlock(buffer.join("\n"), fenceOpen.language));
      }
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
      html.push("<hr />");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(
        `<blockquote data-block-index="${blockIndex++}">${quoteLines.map((quoteLine) => parseInline(quoteLine)).join("<br />")}</blockquote>`,
      );
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*+]\s+/, ""));
        index += 1;
      }
      html.push(
        `<ul>${items.map((item) => `<li data-block-index="${blockIndex++}">${parseInline(item)}</li>`).join("")}</ul>`,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      html.push(
        `<ol>${items.map((item) => `<li data-block-index="${blockIndex++}">${parseInline(item)}</li>`).join("")}</ol>`,
      );
      continue;
    }

    if (
      /^\|(.+)\|/.test(trimmed) &&
      index + 1 < lines.length &&
      /^\|[\s:]*-+[\s:]*/.test(lines[index + 1].trim())
    ) {
      const tableRows = [];
      while (index < lines.length && /^\|(.+)\|/.test(lines[index].trim())) {
        tableRows.push(lines[index].trim());
        index += 1;
      }
      if (tableRows.length >= 2) {
        const parseRow = (row) =>
          row
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());
        const headerCells = parseRow(tableRows[0]);
        const separatorCells = parseRow(tableRows[1]);
        const alignments = separatorCells.map((cell) => {
          const left = cell.startsWith(":");
          const right = cell.endsWith(":");
          if (left && right) return "center";
          if (right) return "right";
          return "left";
        });
        const thead = `<thead><tr>${headerCells.map((cell, i) => `<th align="${alignments[i] || "left"}">${parseInline(cell)}</th>`).join("")}</tr></thead>`;
        const bodyRows = tableRows.slice(2).map((row) => {
          const cells = parseRow(row);
          return `<tr>${cells.map((cell, i) => `<td align="${alignments[i] || "left"}">${parseInline(cell)}</td>`).join("")}</tr>`;
        });
        const tbody =
          bodyRows.length > 0 ? `<tbody>${bodyRows.join("")}</tbody>` : "";
        html.push(`<table>${thead}${tbody}</table>`);
      }
      continue;
    }

    const paragraph = [];
    while (index < lines.length && !isBlockBoundary(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p data-block-index="${blockIndex++}">${parseInline(paragraph.join(" "))}</p>`);
  }

  return { html: html.join("\n"), headings };
}

function getLightTheme() {
  return {
    primary: "#0044ff",
    secondary: "#750049",
    accent: "#0044ff",
    text: "#000000",
    textMuted: "rgba(0,0,0,0.47)",
    background: "#fdfdf8",
    backgroundPanel: "#f5f5f0",
    backgroundElement: "#ebebdf",
    border: "#d0d0c8",
    borderActive: "#0044ff",
    borderSubtle: "#ddddd5",
    diffAdded: "#0d5e2a",
    diffRemoved: "#cf222e",
    diffContext: "rgba(0,0,0,0.47)",
    diffHunkHeader: "#6b5b95",
    diffAddedBg: "#e6f5e6",
    diffRemovedBg: "#fce8e8",
    diffContextBg: "#f5f5f0",
    diffLineNumber: "#cccccc",
    markdownHeading: "#002b8f",
    markdownLink: "#0044ff",
    markdownCode: "#002b8f",
    markdownBlockQuote: "#0d5e2a",
    markdownHorizontalRule: "#d0d0c8",
    selectionBg: "rgba(0, 68, 255, 0.18)",
    selectionText: "inherit",
  };
}

function getDarkTheme() {
  return {
    primary: "#e86cb5",
    secondary: "#ffd9b3",
    accent: "#e86cb5",
    text: "rgba(255,255,255,0.8)",
    textMuted: "rgba(255,255,255,0.35)",
    background: "#121212",
    backgroundPanel: "#1a1a1a",
    backgroundElement: "#242424",
    border: "#333333",
    borderActive: "#e86cb5",
    borderSubtle: "#2a2a2a",
    diffAdded: "#a3e8b0",
    diffRemoved: "#c76e6e",
    diffContext: "rgba(255,255,255,0.35)",
    diffHunkHeader: "#8099b3",
    diffAddedBg: "rgba(166,227,161,0.1)",
    diffRemovedBg: "rgba(199,110,110,0.1)",
    diffContextBg: "#1a1a1a",
    diffLineNumber: "rgba(255,255,255,0.3)",
    markdownHeading: "#ffffff",
    markdownLink: "#e86cb5",
    markdownCode: "#ffd9b3",
    markdownBlockQuote: "#8fb38f",
    markdownHorizontalRule: "#333333",
    selectionBg: "rgba(232, 108, 181, 0.22)",
    selectionText: "inherit",
  };
}

function loadCssAssets() {
  return {
    baseCss: readFileSync(join(assetsDir, "critique-base.css"), "utf8"),
    markdownCss: readFileSync(join(assetsDir, "critique-markdown.css"), "utf8"),
    annotationsCss: readFileSync(join(assetsDir, "annotations.css"), "utf8"),
  };
}

function loadAnnotationsScript() {
  return readFileSync(join(assetsDir, "annotations.js"), "utf8");
}

function loadFontFaceCss() {
  const fontPath = join(assetsDir, "jetbrains-mono-nerd.woff2");
  if (!existsSync(fontPath)) return "";
  const fontBase64 = readFileSync(fontPath).toString("base64");
  return `@font-face {
  font-family: 'JetBrains Mono Nerd';
  src: url(data:font/woff2;base64,${fontBase64}) format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}`;
}

function createDiffBootScript(moduleUrl, ssrModuleUrl) {
  return `<script type="module">
const moduleUrl = ${JSON.stringify(moduleUrl)};
const ssrModuleUrl = ${JSON.stringify(ssrModuleUrl)};
const defaults = {
  diffStyle: "split",
  overflow: "wrap",
  diffIndicators: "none",
  lineDiffType: "word-alt",
  hunkSeparators: "line-info",
  showLineNumbers: true,
  showBackground: true,
  showFileHeader: false,
  unifiedWidth: 80,
  splitPaneWidth: 70,
  maxHeight: 60,
};
const shellStates = [];
const diffUnsafeCss = \`
[data-column-number] {
  box-sizing: border-box !important;
  width: calc(var(--diffs-min-number-column-width-default, 2ch) + 1ch) !important;
  min-width: calc(var(--diffs-min-number-column-width-default, 2ch) + 1ch) !important;
  padding-left: 0 !important;
  padding-right: 1ch !important;
  text-align: right !important;
  font-variant-numeric: tabular-nums lining-nums !important;
}

[data-line-number-content] {
  display: block !important;
  font-variant-numeric: inherit !important;
}
\`;

const changesUnsafeCss = \`
[data-column-number] {
  box-sizing: border-box !important;
  width: calc(var(--diffs-min-number-column-width-default, 2ch) + 1ch) !important;
  min-width: calc(var(--diffs-min-number-column-width-default, 2ch) + 1ch) !important;
  padding-left: 0 !important;
  padding-right: 1ch !important;
  text-align: right !important;
  font-variant-numeric: tabular-nums lining-nums !important;
}

[data-line-number-content] {
  display: block !important;
  font-variant-numeric: inherit !important;
}

[data-expand-button] {
  cursor: pointer !important;
  color: var(--muted) !important;
  transition: color 0.15s !important;
}

[data-expand-button]:hover {
  color: var(--primary) !important;
}

[data-expand-button] svg {
  width: 16px !important;
  height: 16px !important;
  opacity: 0.7 !important;
  transition: opacity 0.15s !important;
}

[data-expand-button]:hover svg {
  opacity: 1 !important;
}

[data-separator-content] {
  color: var(--muted) !important;
}
\`;

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function applyLayoutState(state) {
  document.body.dataset.diffStyle = state.diffStyle;
  document.documentElement.style.setProperty("--diff-unified-width", \`\${state.unifiedWidth}ch\`);
  document.documentElement.style.setProperty("--diff-split-pane-width", \`\${state.splitPaneWidth}ch\`);
  document.documentElement.style.setProperty("--diff-shell-max-height", \`\${state.maxHeight}vh\`);
}

function createViewOptions(state) {
  return {
    diffStyle: state.diffStyle,
    overflow: state.overflow,
    diffIndicators: state.diffIndicators,
    lineDiffType: state.lineDiffType,
    hunkSeparators: state.hunkSeparators,
    disableLineNumbers: !state.showLineNumbers,
    disableBackground: !state.showBackground,
    disableFileHeader: !state.showFileHeader,
    themeType: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    unsafeCSS: diffUnsafeCss,
  };
}

async function renderShell(shellState, preloadPatchFile, renderHTML, state) {
  shellState.mount.replaceChildren();
  shellState.shell.dataset.renderState = "pending";

  const files = await preloadPatchFile({
    patch: shellState.patch,
    options: createViewOptions(state),
  });
  if (files.length === 0) {
    shellState.shell.dataset.renderState = "empty";
    return;
  }

  for (const file of files) {
    const wrapper = document.createElement("div");
    wrapper.className = "diff-file-block";

    const headerRow = document.createElement("div");
    headerRow.className = "diff-header-row";

    const pathLabel = document.createElement("div");
    pathLabel.className = "diff-path-label";
    pathLabel.textContent = file.fileDiff?.name || file.fileDiff?.prevName || "file";
    headerRow.append(pathLabel);
    wrapper.append(headerRow);

    const scroll = document.createElement("div");
    scroll.className = "diff-scroll";
    const host = document.createElement("div");
    host.className = "diffs-host";
    host.innerHTML = Array.isArray(file.prerenderedHTML)
      ? renderHTML(file.prerenderedHTML)
      : String(file.prerenderedHTML || "");
    scroll.append(host);
    wrapper.append(scroll);
    shellState.mount.append(wrapper);
  }
  shellState.shell.dataset.renderState = "ready";
}

try {
  const [mod, ssrMod] = await Promise.all([
    import(moduleUrl),
    import(ssrModuleUrl),
  ]);
  const { parsePatchFiles } = mod;
  const { preloadPatchFile, renderHTML } = ssrMod;
  const state = { ...defaults };

  applyLayoutState(state);

  for (const shell of document.querySelectorAll("[data-diff-shell]")) {
    try {
      const patch = decodeBase64Utf8(shell.dataset.diffPatch || "");
      const patchFiles = parsePatchFiles(patch);
      const mount = shell.querySelector("[data-diff-hosts]");

      if (!mount || patchFiles.every((entry) => (entry.files || []).length === 0)) {
        shell.dataset.renderState = "empty";
        continue;
      }

      shellStates.push({
        shell,
        mount,
        patch,
      });
    } catch (error) {
      shell.dataset.renderState = "error";
      console.error("Failed to render diff block.", error);
    }
  }

  for (const shellState of shellStates) {
    await renderShell(shellState, preloadPatchFile, renderHTML, state);
  }

  // Render changes blocks (expandable file diffs)
  // Uses FileDiff.render() for full interactivity (expand/collapse hunks).
  // FileDiff renders into a shadow DOM, so we inject the core CSS manually.
  const { FileDiff, preloadHighlighter, wrapCoreCSS, SVGSpriteSheet } = mod;
  const changesShells = document.querySelectorAll("[data-changes-shell]");
  if (FileDiff && changesShells.length > 0) {
    // Collect unique languages from filenames for syntax highlighting
    const langSet = new Set();
    for (const shell of changesShells) {
      for (const fileEl of shell.querySelectorAll(".changes-file")) {
        const name = fileEl.dataset.fileName || "";
        const ext = name.split(".").pop()?.toLowerCase();
        if (ext) langSet.add(ext === "ts" || ext === "tsx" ? "typescript" : ext === "js" || ext === "jsx" ? "javascript" : ext);
      }
    }

    // Preload highlighter with required themes and languages
    try {
      await preloadHighlighter({
        themes: ["pierre-dark", "pierre-light"],
        langs: [...langSet],
      });
    } catch (e) {
      console.warn("Failed to preload highlighter:", e);
    }

    // Get the core CSS to inject into shadow roots
    const coreCSS = wrapCoreCSS();

    for (const shell of changesShells) {
      for (const fileEl of shell.querySelectorAll(".changes-file")) {
        try {
          const filename = fileEl.dataset.fileName || "file";
          const oldEncoded = fileEl.dataset.oldContents;
          const newEncoded = fileEl.dataset.newContents;
          const focusStart = fileEl.dataset.focusStart;

          const oldContents = oldEncoded ? decodeBase64Utf8(oldEncoded) : "";
          const newContents = newEncoded ? decodeBase64Utf8(newEncoded) : "";

          const oldFile = { name: filename, contents: oldContents };
          const newFile = { name: filename, contents: newContents };

          const changesOptions = {
            ...createViewOptions(state),
            hunkSeparators: "line-info",
            disableFileHeader: true,
            unsafeCSS: changesUnsafeCss,
          };

          const mount = fileEl.querySelector(".changes-mount");
          if (!mount) continue;

          const host = document.createElement("div");
          host.className = "diffs-host";
          mount.replaceChildren(host);

          const instance = new FileDiff(changesOptions);
          instance.render({
            oldFile,
            newFile,
            fileContainer: host,
          });

          // Inject core CSS and SVG sprite sheet into shadow root
          if (host.shadowRoot) {
            if (coreCSS) {
              const styleEl = document.createElement("style");
              styleEl.textContent = coreCSS;
              host.shadowRoot.prepend(styleEl);
            }
            if (SVGSpriteSheet) {
              const spriteContainer = document.createElement("div");
              spriteContainer.innerHTML = SVGSpriteSheet;
              const spriteEl = spriteContainer.firstElementChild;
              if (spriteEl) host.shadowRoot.prepend(spriteEl);
            }

            // Preserve scroll position when hunks expand/collapse.
            // Capture height before click, then after DOM mutation + layout,
            // adjust scrollY if the host is above the viewport.
            const sr = host.shadowRoot;
            let heightBeforeClick = host.offsetHeight;

            sr.addEventListener("click", () => {
              heightBeforeClick = host.offsetHeight;
            }, { capture: true });

            const observer = new MutationObserver(() => {
              requestAnimationFrame(() => {
                const newHeight = host.offsetHeight;
                const delta = newHeight - heightBeforeClick;
                if (delta === 0) return;
                // Only adjust if the host starts above the viewport top,
                // meaning expanded content pushes things below it down.
                if (host.getBoundingClientRect().top < 0) {
                  window.scrollBy(0, delta);
                }
                heightBeforeClick = newHeight;
              });
            });
            observer.observe(sr, { childList: true, subtree: true });
          }

          if (focusStart) {
            mount.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        } catch (error) {
          console.error("Failed to render changes file block.", error);
        }
      }
    }
  }

  // Render plain code blocks with syntax highlighting
  const { preloadFile } = ssrMod;
  for (const shell of document.querySelectorAll("[data-code-shell]")) {
    try {
      const contents = decodeBase64Utf8(shell.dataset.codeContents || "");
      const filename = shell.dataset.codeFilename || "file.txt";

      const result = await preloadFile({
        file: { name: filename, contents },
        options: {
          overflow: "wrap",
          disableLineNumbers: false,
          disableFileHeader: true,
          themeType: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          unsafeCSS: diffUnsafeCss,
        },
      });

      if (result && result.prerenderedHTML) {
        const wrapper = document.createElement("div");
        wrapper.className = "code-file-block";
        const scroll = document.createElement("div");
        scroll.className = "code-scroll";
        const host = document.createElement("div");
        host.className = "diffs-host";
        host.innerHTML = Array.isArray(result.prerenderedHTML)
          ? renderHTML(result.prerenderedHTML)
          : String(result.prerenderedHTML || "");
        scroll.append(host);
        wrapper.append(scroll);

        // Keep the label, replace the pre/code fallback
        const label = shell.querySelector(".code-label");
        const pre = shell.querySelector("pre.code-block");
        if (pre) pre.replaceWith(wrapper);
      }
    } catch (error) {
      console.error("Failed to render code block.", error);
      // Falls back to the plain pre/code already in the DOM
    }
  }
} catch (error) {
  console.error("Failed to load @pierre/diffs.", error);
}
</script>`;
}

function renderDocument({ bodyHtml, title, sourceLabel }) {
  const { baseCss, markdownCss, annotationsCss } = loadCssAssets();
  const annotationsScript = loadAnnotationsScript();
  const fontFaceCss = loadFontFaceCss();
  const diffBootScript = createDiffBootScript(
    DEFAULT_DIFFS_MODULE_URL,
    DEFAULT_DIFFS_SSR_MODULE_URL,
  );
  const light = getLightTheme();
  const dark = getDarkTheme();

  const checkmarkSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.75 12.75L10 15.25L16.25 8.75" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --primary: ${light.primary};
        --secondary: ${light.secondary};
        --accent: ${light.accent};
        --text: ${light.text};
        --muted: ${light.textMuted};
        --bg: ${light.background};
        --panel: ${light.backgroundPanel};
        --element: ${light.backgroundElement};
        --border: ${light.border};
        --border-active: ${light.borderActive};
        --border-subtle: ${light.borderSubtle};
        --diff-add: ${light.diffAdded};
        --diff-remove: ${light.diffRemoved};
        --diff-context: ${light.diffContext};
        --diff-hunk: ${light.diffHunkHeader};
        --diff-add-bg: ${light.diffAddedBg};
        --diff-remove-bg: ${light.diffRemovedBg};
        --diff-context-bg: ${light.diffContextBg};
        --diff-line-number: ${light.diffLineNumber};
        --heading: ${light.markdownHeading};
        --link: ${light.markdownLink};
        --inline-code: ${light.markdownCode};
        --quote: ${light.markdownBlockQuote};
        --rule: ${light.markdownHorizontalRule};
        --selection-bg: ${light.selectionBg};
        --selection-text: ${light.selectionText};
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --primary: ${dark.primary};
          --secondary: ${dark.secondary};
          --accent: ${dark.accent};
          --text: ${dark.text};
          --muted: ${dark.textMuted};
          --bg: ${dark.background};
          --panel: ${dark.backgroundPanel};
          --element: ${dark.backgroundElement};
          --border: ${dark.border};
          --border-active: ${dark.borderActive};
          --border-subtle: ${dark.borderSubtle};
          --diff-add: ${dark.diffAdded};
          --diff-remove: ${dark.diffRemoved};
          --diff-context: ${dark.diffContext};
          --diff-hunk: ${dark.diffHunkHeader};
          --diff-add-bg: ${dark.diffAddedBg};
          --diff-remove-bg: ${dark.diffRemovedBg};
          --diff-context-bg: ${dark.diffContextBg};
          --diff-line-number: ${dark.diffLineNumber};
          --heading: ${dark.markdownHeading};
          --link: ${dark.markdownLink};
          --inline-code: ${dark.markdownCode};
          --quote: ${dark.markdownBlockQuote};
          --rule: ${dark.markdownHorizontalRule};
          --selection-bg: ${dark.selectionBg};
          --selection-text: ${dark.selectionText};
        }
      }

      ::selection {
        background: var(--selection-bg);
        color: var(--selection-text);
      }

${fontFaceCss}
${baseCss}
${markdownCss}
${annotationsCss}

      .done-button {
        position: fixed;
        top: 12px;
        right: 16px;
        z-index: 9999;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px 6px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg);
        color: var(--text);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
      }
      .done-button:hover {
        background: var(--panel);
        border-color: var(--border-active);
        box-shadow: 0 1px 4px rgba(0,0,0,0.12);
      }
      .done-button:active {
        background: var(--element);
      }
      .done-button svg {
        flex-shrink: 0;
      }
    </style>
  </head>
  <body data-diff-style="split">
    <button class="comment-trigger"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 18.25C15.866 18.25 19.25 16.1552 19.25 11.5C19.25 6.84483 15.866 4.75 12 4.75C8.13401 4.75 4.75 6.84483 4.75 11.5C4.75 13.2675 5.23783 14.6659 6.05464 15.7206C6.29358 16.0292 6.38851 16.4392 6.2231 16.7926C6.12235 17.0079 6.01633 17.2134 5.90792 17.4082C5.45369 18.2242 6.07951 19.4131 6.99526 19.2297C8.0113 19.0263 9.14752 18.722 10.0954 18.2738C10.2933 18.1803 10.5134 18.1439 10.7305 18.1714C11.145 18.224 11.5695 18.25 12 18.25Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M9.75 12H14.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M12 9.75V14.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>
    <div id="layout">
      <div id="content">
        <div class="review-shell">
          <main class="markdown-body">
            ${bodyHtml}
          </main>
          <footer class="review-footer">
            <p class="review-source">${escapeHtml(sourceLabel)}</p>
          </footer>
        </div>
      </div>
      <div id="comments-sidebar"></div>
    </div>
    <button class="done-button" title="Close window">${checkmarkSvg}<span class="done-label">Done</span></button>
${diffBootScript}
    <script>${annotationsScript}</script>
  </body>
</html>`;
}

function formatReviewOutput(doneData) {
  const anns = doneData?.annotations || [];
  if (anns.length === 0) return "Window closed. User marked done without review.";

  const lines = ["User review:", ""];
  for (const ann of anns) {
    const ctx = ann.context || {};
    let location = "";
    if (ctx.type === "diff" && ctx.file) {
      location = ctx.lineNumber ? ` (${ctx.file}:${ctx.lineNumber})` : ` (${ctx.file})`;
    } else if (ctx.blockTag) {
      location = ` (${ctx.blockTag})`;
    }
    const quote = (ann.selectedText || "").replace(/\n/g, "\n> ");
    lines.push(`> ${quote}${location}`);
    lines.push("");
    lines.push(ann.comment);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function openWithGlimpse(html, title, sessionFile, outputFile?: string) {
  const win = open(html, {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    title,
    openLinks: true,
  });

  let doneData = null;

  win.on("message", (data) => {
    const line = JSON.stringify({ ...data, ts: Date.now() }) + "\n";
    appendFileSync(sessionFile, line, "utf8");
    if (data.action === "done") doneData = data;
  });

  const closedPromise = new Promise((resolvePromise) => {
    win.once("closed", resolvePromise);
  });

  const firstEvent = await Promise.race([
    closedPromise.then(() => "closed"),
    new Promise((resolvePromise, rejectPromise) => {
      win.once("ready", () => resolvePromise("ready"));
      win.once("error", rejectPromise);
    }),
  ]);

  if (firstEvent === "closed") {
    const result = "Window closed. User marked done without review.";
    if (outputFile) writeFileSync(outputFile, result, "utf8");
    else console.log(result);
    process.exit(0);
  }

  await closedPromise;
  const result = formatReviewOutput(doneData);
  if (outputFile) {
    writeFileSync(outputFile, result, "utf8");
  } else {
    console.log(result);
  }
  process.exit(0);
}

function renderAndWrite(markdown: string, sourceLabel: string) {
  const { html: bodyHtml, headings } = renderMarkdown(markdown);
  const firstHeading =
    headings.find((heading) => heading.level === 1)?.text || null;
  const title = firstHeading || "Markdown Preview";
  const documentHtml = renderDocument({ bodyHtml, title, sourceLabel });
  const sessionId = randomBytes(6).toString("hex");
  const outPath = join(tmpdir(), `${slugify(title)}.html`);
  const sessionFile = join(tmpdir(), `glimpse-session-${sessionId}.jsonl`);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, documentHtml, "utf8");
  writeFileSync(sessionFile, "", "utf8");

  return { documentHtml, title, outPath, sessionFile };
}

async function serveMode(args: string[]) {
  // Internal entry point for detached background child process.
  // Args: <htmlPath> <outputFile> <title> <sessionFile>
  const [htmlPath, outputFile, title, sessionFile] = args;
  if (!htmlPath || !outputFile || !title || !sessionFile) {
    console.error("--__serve requires: <htmlPath> <outputFile> <title> <sessionFile>");
    process.exit(1);
  }
  const html = readFileSync(htmlPath, "utf8");
  await openWithGlimpse(html, title, sessionFile, outputFile);
}

async function main() {
  const args = process.argv.slice(2);

  // Internal child-process mode: not exposed to users
  if (args[0] === "--__serve") {
    await serveMode(args.slice(1));
    return;
  }

  const { markdown: inlineMarkdown, readFromStdin, dryRun, background } =
    parseInput(args);

  let markdown = "";
  if (readFromStdin) {
    markdown = await readStdin();
  } else if (inlineMarkdown !== null) {
    // Interpret common escape sequences in inline arguments so that
    // `npx glimpse-changes "# Title\n\nContent"` works as expected.
    markdown = inlineMarkdown.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  } else if (!process.stdin.isTTY) {
    markdown = await readStdin();
  } else {
    printUsage();
    process.exit(1);
  }

  if (!markdown.trim()) {
    console.error("No markdown content provided.");
    process.exit(1);
  }

  const { documentHtml, title, outPath, sessionFile } = renderAndWrite(
    markdown,
    "glimpse-changes",
  );

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, htmlPath: outPath, title }));
    return;
  }

  if (background) {
    const sessionId = randomBytes(6).toString("hex");
    const outputFile = join(tmpdir(), `glimpse-review-${sessionId}.txt`);
    writeFileSync(outputFile, "__PENDING__", "utf8");

    const child = spawn(
      process.execPath,
      [process.argv[1], "--__serve", outPath, outputFile, title, sessionFile],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    console.log(`Glimpse window opened. Read ${outputFile} for user feedback.`);
    process.exit(0);
  }

  await openWithGlimpse(documentHtml, title, sessionFile);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
