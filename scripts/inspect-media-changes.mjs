import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const MAXIMUM_PATHS = 512;
const MAXIMUM_PATH_BYTES = 512;
const MAXIMUM_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PIXEL_COUNT = 20_000_000;
const MAXIMUM_GIT_LIST_BYTES = 1024 * 1024;
const MAXIMUM_CHILD_OUTPUT_BYTES = 16 * 1024;
const CHILD_HEAP_MIB = 384;
const scriptPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(message);
}

function runGit(root, args, maximumBytes = MAXIMUM_GIT_LIST_BYTES) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: maximumBytes,
    windowsHide: true
  });
  if (result.error) throw result.error;
  return result;
}

function parseNulPaths(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAXIMUM_GIT_LIST_BYTES) {
    fail(`${label} exceeded its output bound.`);
  }
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) fail(`${label} did not return a complete NUL-delimited list.`);
  return buffer
    .subarray(0, -1)
    .toString("utf8")
    .split("\0")
    .map((entry) => validateRelativePngPath(entry));
}

function validateBase(base) {
  if (
    typeof base !== "string" ||
    base.length === 0 ||
    Buffer.byteLength(base, "utf8") > 128 ||
    /[\0\r\n:]/u.test(base) ||
    base.startsWith("-")
  ) {
    fail("The comparison base is invalid.");
  }
  return base;
}

function validateRelativePngPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > MAXIMUM_PATH_BYTES ||
    /[\0\r\n]/u.test(path) ||
    !path.toLowerCase().endsWith(".png") ||
    path.startsWith("/") ||
    path.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("The media path is invalid.");
  }
  return path;
}

function assertContainedRegularFile(root, path) {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
    fail(`Media path escaped the repository: ${path}`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAXIMUM_COMPRESSED_BYTES) {
    fail(`Media file is missing, non-regular, or too large: ${path}`);
  }
  return absolute;
}

function decodeBoundedPng(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAXIMUM_COMPRESSED_BYTES) {
    fail(`${label} is missing or exceeds the compressed-size bound.`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > MAXIMUM_PIXEL_COUNT) {
    fail(`${label} exceeds the pixel bound.`);
  }
  const image = PNG.sync.read(buffer, { checkCRC: true });
  if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) {
    fail(`${label} decoded to an unexpected shape.`);
  }
  return image;
}

export function compareDecodedPng(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    return {
      changedPixels: null,
      bounds: null,
      before: { width: left.width, height: left.height },
      after: { width: right.width, height: right.height }
    };
  }
  let changedPixels = 0;
  let minimumX = left.width;
  let minimumY = left.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const offset = (y * left.width + x) * 4;
      let changed = false;
      for (let channel = 0; channel < 4; channel += 1) {
        if (left.data[offset + channel] !== right.data[offset + channel]) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      changedPixels += 1;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  return {
    changedPixels,
    bounds: changedPixels === 0 ? null : { minimumX, minimumY, maximumX, maximumY },
    before: { width: left.width, height: left.height },
    after: { width: right.width, height: right.height }
  };
}

function inspectOne(root, base, path) {
  const absolute = assertContainedRegularFile(root, path);
  const currentBuffer = readFileSync(absolute);
  const current = decodeBoundedPng(currentBuffer, `Current ${path}`);
  const object = `${base}:${path}`;
  const exists = runGit(root, ["cat-file", "-e", object], 1024);
  if (exists.status !== 0) {
    return {
      path,
      status: "added",
      changedPixels: null,
      bounds: null,
      before: null,
      after: { width: current.width, height: current.height }
    };
  }
  const sizeResult = runGit(root, ["cat-file", "-s", object], 1024);
  if (sizeResult.status !== 0) fail(`Could not read the baseline size for ${path}.`);
  const baselineSize = Number(sizeResult.stdout.toString("utf8").trim());
  if (!Number.isSafeInteger(baselineSize) || baselineSize < 1 || baselineSize > MAXIMUM_COMPRESSED_BYTES) {
    fail(`Baseline media is missing or too large: ${path}`);
  }
  const baselineResult = runGit(root, ["show", object], MAXIMUM_COMPRESSED_BYTES + 1024);
  if (baselineResult.status !== 0 || baselineResult.stdout.length !== baselineSize) {
    fail(`Could not read the complete baseline for ${path}.`);
  }
  const baseline = decodeBoundedPng(baselineResult.stdout, `Baseline ${path}`);
  return { path, status: "modified", ...compareDecodedPng(baseline, current) };
}

function changedPngPaths(root, base) {
  const changed = runGit(root, ["diff", "--name-only", "--diff-filter=AM", "-z", base, "--", "*.png"]);
  if (changed.status !== 0) fail("Could not list changed PNG files.");
  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "*.png"]);
  if (untracked.status !== 0) fail("Could not list untracked PNG files.");
  const paths = [
    ...new Set([...parseNulPaths(changed.stdout, "git diff"), ...parseNulPaths(untracked.stdout, "git ls-files")])
  ].sort();
  if (paths.length > MAXIMUM_PATHS) fail("Too many changed PNG files for one inspection.");
  return paths;
}

function renderResult(result) {
  if (result.status === "added") {
    return `added\t${result.after.width}x${result.after.height}\t${result.path}`;
  }
  if (result.changedPixels === null) {
    return `resized\t${result.before.width}x${result.before.height} -> ${result.after.width}x${result.after.height}\t${result.path}`;
  }
  const bounds = result.bounds
    ? `${result.bounds.minimumX},${result.bounds.minimumY}-${result.bounds.maximumX},${result.bounds.maximumY}`
    : "unchanged";
  return `${result.changedPixels}\t${bounds}\t${result.path}`;
}

function parseArguments(argv) {
  if (argv[0] === "--one" && argv.length === 3) {
    return { mode: "one", base: validateBase(argv[1]), path: validateRelativePngPath(argv[2]) };
  }
  if (argv.length === 0) return { mode: "all", base: "HEAD" };
  if (argv.length === 2 && argv[0] === "--base") return { mode: "all", base: validateBase(argv[1]) };
  fail("Usage: npm run inspect:media-changes -- [--base <revision>]");
}

export function runMediaInspection(argv = process.argv.slice(2), root = realpathSync(process.cwd())) {
  const options = parseArguments(argv);
  if (options.mode === "one") {
    process.stdout.write(`${JSON.stringify(inspectOne(root, options.base, options.path))}\n`);
    return;
  }
  const paths = changedPngPaths(root, options.base);
  if (paths.length === 0) {
    process.stdout.write("No changed PNG files.\n");
    return;
  }
  for (const path of paths) {
    const child = spawnSync(
      process.execPath,
      [`--max-old-space-size=${CHILD_HEAP_MIB}`, scriptPath, "--one", options.base, path],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: MAXIMUM_CHILD_OUTPUT_BYTES,
        windowsHide: true
      }
    );
    if (child.error) throw child.error;
    if (child.status !== 0 || child.signal !== null) {
      const diagnostic = `${child.stderr ?? ""}`.trim().slice(0, 512);
      fail(`PNG inspection failed for ${path}${diagnostic ? `: ${diagnostic}` : "."}`);
    }
    let result;
    try {
      result = JSON.parse(child.stdout);
    } catch {
      fail(`PNG inspection returned malformed output for ${path}.`);
    }
    process.stdout.write(`${renderResult(result)}\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  try {
    runMediaInspection();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
