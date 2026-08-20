import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WEBVIEW_STYLE_IMPORTS = [
  "foundations.css",
  "application.css",
  "column-search.css",
  "workspace.css",
  "filters.css",
  "grid.css",
  "grid-insights.css",
  "summary.css",
  "operations.css",
  "responsive.css"
];

const REMOVED_SELECTORS = new Set(["columnSearchCount", "miniBar"]);
const MAX_ENTRY_BYTES = 4 * 1024;
const MAX_FOUNDATION_LINES = 100;
const MAX_OWNED_STYLESHEET_LINES = 700;
const MAX_STYLE_BYTES = 1024 * 1024;
const MAX_STYLE_FILE_BYTES = 128 * 1024;
const MAX_WEBVIEW_DIRECTORY_DEPTH = 8;
const MAX_WEBVIEW_ENTRIES = 512;
const MAX_WEBVIEW_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_WEBVIEW_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_WEBVIEW_SOURCE_FILES = 128;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function lineCount(source) {
  return source === "" ? 0 : source.replace(/\n$/u, "").split("\n").length;
}

function selectorClasses(source) {
  return new Set([...source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu)].map((match) => match[1]));
}

function sourceContainsClass(source, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const quotedToken =
    "[\"'`][^\"'`]*(?<![A-Za-z0-9_-])" + escaped + "(?![A-Za-z0-9_-])[^\"'`]*[\"'`]";
  return new RegExp(quotedToken, "u").test(source);
}

async function sourceFiles(directory, depth = 0, state = { entries: 0, files: [] }) {
  if (depth > MAX_WEBVIEW_DIRECTORY_DEPTH) {
    throw new Error(`Webview source tree exceeds ${MAX_WEBVIEW_DIRECTORY_DEPTH} directory levels.`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    state.entries += 1;
    if (state.entries > MAX_WEBVIEW_ENTRIES) {
      throw new Error(`Webview source tree exceeds ${MAX_WEBVIEW_ENTRIES} entries.`);
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await sourceFiles(path, depth + 1, state);
      continue;
    }
    if (entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name))) {
      state.files.push(path);
      if (state.files.length > MAX_WEBVIEW_SOURCE_FILES) {
        throw new Error(`Webview source tree exceeds ${MAX_WEBVIEW_SOURCE_FILES} TypeScript files.`);
      }
    }
  }
  return state.files;
}

async function readBoundedFile(path, maxBytes, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new Error(`${label} must be a regular file no larger than ${maxBytes} bytes.`);
  }
  return readFile(path, "utf8");
}

export async function checkWebviewStyles(root = repositoryRoot) {
  const webviewRoot = resolve(root, "src/webviews");
  const styleRoot = resolve(webviewRoot, "styles");
  const entryPath = resolve(webviewRoot, "styles.css");
  const expectedEntry = `${WEBVIEW_STYLE_IMPORTS.map((file) => `@import "./styles/${file}";`).join("\n")}\n`;
  const entry = await readBoundedFile(entryPath, MAX_ENTRY_BYTES, "src/webviews/styles.css");
  if (entry !== expectedEntry) {
    throw new Error("src/webviews/styles.css must contain only the canonical owned-style imports in order.");
  }

  const actualStyleFiles = (await readdir(styleRoot, { withFileTypes: true }))
    .filter((entry_) => entry_.isFile() && extname(entry_.name) === ".css")
    .map((entry_) => entry_.name)
    .sort();
  const expectedStyleFiles = [...WEBVIEW_STYLE_IMPORTS].sort();
  if (JSON.stringify(actualStyleFiles) !== JSON.stringify(expectedStyleFiles)) {
    throw new Error(
      `Owned stylesheet inventory differs: expected ${expectedStyleFiles.join(", ")}; found ${actualStyleFiles.join(", ")}.`
    );
  }

  const styleSources = [];
  let styleBytes = 0;
  for (const file of WEBVIEW_STYLE_IMPORTS) {
    const path = resolve(styleRoot, file);
    const metadata = await lstat(path);
    styleBytes += metadata.size;
    if (styleBytes > MAX_STYLE_BYTES) {
      throw new Error(`Owned stylesheets exceed ${MAX_STYLE_BYTES} bytes in total.`);
    }
    const source = await readBoundedFile(path, MAX_STYLE_FILE_BYTES, file);
    if (/^\s*@import\b/mu.test(source)) {
      throw new Error(`${file} must not contain nested imports; styles.css owns the production order.`);
    }
    const lines = lineCount(source);
    const limit = file === "foundations.css" ? MAX_FOUNDATION_LINES : MAX_OWNED_STYLESHEET_LINES;
    if (lines > limit) {
      throw new Error(`${file} has ${lines} lines, above its ${limit}-line ownership limit; split it before adding CSS.`);
    }
    styleSources.push({ file, source });
  }

  const classes = new Map();
  for (const { file, source } of styleSources) {
    for (const className of selectorClasses(source)) {
      const owners = classes.get(className) ?? [];
      owners.push(file);
      classes.set(className, owners);
    }
  }

  const resurrected = [...REMOVED_SELECTORS].filter((className) => classes.has(className));
  if (resurrected.length > 0) {
    throw new Error(`Removed selector(s) must stay absent: ${resurrected.sort().join(", ")}.`);
  }

  const webviewSources = [];
  let sourceBytes = 0;
  for (const path of await sourceFiles(webviewRoot)) {
    const metadata = await lstat(path);
    sourceBytes += metadata.size;
    if (sourceBytes > MAX_WEBVIEW_SOURCE_BYTES) {
      throw new Error(`Webview TypeScript sources exceed ${MAX_WEBVIEW_SOURCE_BYTES} bytes in total.`);
    }
    webviewSources.push({
      path: relative(root, path),
      source: await readBoundedFile(path, MAX_WEBVIEW_SOURCE_FILE_BYTES, relative(root, path))
    });
  }
  const dead = [...classes]
    .filter(([className]) => !webviewSources.some(({ source }) => sourceContainsClass(source, className)))
    .map(([className, owners]) => `${className} (${owners.join(", ")})`)
    .sort();
  if (dead.length > 0) {
    throw new Error(`Unreferenced webview selector class(es): ${dead.join(", ")}.`);
  }

  return {
    entry: relative(root, entryPath),
    ownedStylesheets: WEBVIEW_STYLE_IMPORTS.length,
    selectorClasses: classes.size,
    sourceFiles: webviewSources.length
  };
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/check-webview-styles.mjs");
  }
  const receipt = await checkWebviewStyles();
  process.stdout.write(
    `Webview styles are owned and live: ${receipt.ownedStylesheets} files, ${receipt.selectorClasses} class selectors, ${receipt.sourceFiles} source files.\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
