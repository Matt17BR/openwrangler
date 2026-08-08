import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export const R_EDITOR_ACCEPTANCE_TOOLING = Object.freeze({
  rSyntax: Object.freeze({
    id: "reditorsupport.r-syntax@0.1.4",
    fileName: "REditorSupport.r-syntax-0.1.4.vsix",
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/REditorSupport/vsextensions/r-syntax/0.1.4/vspackage",
    bytes: 91_323,
    sha256: "ecc5f4d6688f6e239f9f15da08c834c802875ec05cc11518ba253dc93ccc1884"
  }),
  r: Object.freeze({
    id: "reditorsupport.r@2.8.8",
    fileName: "REditorSupport.r-2.8.8.vsix",
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/REditorSupport/vsextensions/r/2.8.8/vspackage",
    bytes: 2_767_944,
    sha256: "9add9b7aceda1dc0072cc9e048b5bfcc8de4488ccd2802ea5fe834517a3ce2e2"
  }),
  quartoExtension: Object.freeze({
    id: "quarto.quarto@1.135.0",
    fileName: "quarto.quarto-1.135.0.vsix",
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/quarto/vsextensions/quarto/1.135.0/vspackage",
    bytes: 9_519_967,
    sha256: "2b17625bf58540dee709986107bc27b4285cbfe555dc4f1de457c0ac2b7ed0a4"
  }),
  quartoCli: Object.freeze({
    version: "1.10.18",
    fileName: "quarto-1.10.18-linux-amd64.tar.gz",
    url: "https://github.com/quarto-dev/quarto-cli/releases/download/v1.10.18/quarto-1.10.18-linux-amd64.tar.gz",
    bytes: 147_010_003,
    sha256: "afad071b5bd22c02f2d300695743189d3650e0537a53073e654b630cff2b0c73"
  })
});

export async function prepareREditorAcceptanceTooling(
  parent,
  {
    artifactPaths = {},
    fetchImpl = fetch,
    runCommand = runBoundedEditorCommand,
    environment = createEditorAcceptanceEnvironment()
  } = {}
) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Native R and Quarto editor acceptance currently supports Linux x64 only.");
  }
  const canonicalParent = privateDirectory(parent);
  const root = join(canonicalParent, `r-editor-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const extensionVsixes = [];
  for (const key of ["rSyntax", "r", "quartoExtension"]) {
    const pin = R_EDITOR_ACCEPTANCE_TOOLING[key];
    extensionVsixes.push(
      await acquireExactArtifact(root, pin, {
        fetchImpl,
        sourcePath: artifactPaths[key]
      })
    );
  }
  const quartoArchive = await acquireExactArtifact(root, R_EDITOR_ACCEPTANCE_TOOLING.quartoCli, {
    fetchImpl,
    sourcePath: artifactPaths.quartoCli
  });
  const installRoot = join(root, "quarto");
  mkdirSync(installRoot, { mode: 0o700 });
  await runCommand(
    {
      executable: "tar",
      args: ["-xzf", quartoArchive, "-C", installRoot, "--no-same-owner", "--no-same-permissions"],
      environment,
      label: "Pinned Quarto CLI extraction"
    },
    { timeoutMs: 120_000 }
  );
  const quartoExecutable = resolve(
    installRoot,
    `quarto-${R_EDITOR_ACCEPTANCE_TOOLING.quartoCli.version}`,
    "bin",
    "quarto"
  );
  assertContainedExecutable(quartoExecutable, installRoot);
  const version = await runCommand(
    {
      executable: quartoExecutable,
      args: ["--version"],
      environment,
      label: "Pinned Quarto CLI version probe"
    },
    { timeoutMs: 30_000 }
  );
  if (version.stdout.trim() !== R_EDITOR_ACCEPTANCE_TOOLING.quartoCli.version) {
    throw new Error("The pinned Quarto CLI reported an unexpected version.");
  }
  return Object.freeze({
    root,
    extensionVsixes: Object.freeze(extensionVsixes),
    quartoExecutable
  });
}

async function acquireExactArtifact(root, pin, { fetchImpl, sourcePath }) {
  const destination = join(root, pin.fileName);
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) {
      throw new Error(`${pin.fileName} override must be an absolute path.`);
    }
    const source = resolve(sourcePath);
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) {
      throw new Error(`${pin.fileName} override must be a regular, non-symbolic file.`);
    }
    await writeVerifiedArtifact(createReadStream(source), destination, pin);
    return destination;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(pin.url, {
      headers: { "User-Agent": "Open-Wrangler-release-acceptance" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`Could not download ${pin.fileName}: HTTP ${response.status}.`);
    }
    await writeVerifiedArtifact(Readable.fromWeb(response.body), destination, pin);
    return destination;
  } finally {
    clearTimeout(timer);
  }
}

async function writeVerifiedArtifact(source, destination, pin) {
  const digest = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > pin.bytes) {
        callback(new Error(`${pin.fileName} exceeded its pinned size.`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== pin.bytes || digest.digest("hex") !== pin.sha256) {
        callback(new Error(`${pin.fileName} did not match its pinned checksum.`));
        return;
      }
      callback();
    }
  });
  const writer = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    await pipeline(source, verifier, writer);
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

function privateDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("R editor tooling requires an absolute private parent directory.");
  }
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("R editor tooling requires a regular private parent directory.");
  }
  return canonical;
}

function assertContainedExecutable(path, parent) {
  const canonical = realpathSync(path);
  const canonicalParent = realpathSync(parent);
  const contained = relative(canonicalParent, canonical);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("The Quarto executable escaped its private installation root.");
  }
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error("The extracted Quarto CLI is not an executable regular file.");
  }
  if (basename(canonical) !== "quarto" || !existsSync(canonical)) {
    throw new Error("The extracted Quarto CLI path is invalid.");
  }
}
