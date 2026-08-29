import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBoundedRegularFile } from "./bounded-file-read.mjs";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";

export const PINNED_VSCODE_VERSION = "1.130.0";
export const PINNED_VSCODE_COMMIT = "1b6a188127eeaf9194f945eb6eb89a657e93c54c";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_PATH_BYTES = 8 * 1024;
const PINNED_VSCODE_CLIENT_LICENSE_SHA256 = "318c800dec8b7a7d4faa013f4d688680c6fdb591c3516c939f6214e702586b0c";
const TARGET_KEYS = new Set([
  "archiveRoot",
  "artifactName",
  "decodedBytes",
  "decodedSha256",
  "format",
  "identity",
  "redirectUrl",
  "url",
  "wireBytes",
  "wireContentEncoding",
  "wireSha256"
]);

export const PINNED_VSCODE_CLIENT_TARGET = Object.freeze({
  archiveRoot: "VSCode-linux-x64",
  artifactName: "vscode-linux-x64.tar.gz",
  decodedBytes: 356_926_919,
  decodedSha256: "7d6ad3d3a78ac4551c14631f78d7e03c85282ab505c3ce8b1bc04e01fafe88ea",
  format: "tar.gz",
  identity: "vscode",
  redirectUrl:
    "https://vscode.download.prss.microsoft.com/dbazure/download/stable/1b6a188127eeaf9194f945eb6eb89a657e93c54c/code-stable-x64-1784734420.tar.gz",
  url: "https://update.code.visualstudio.com/commit:1b6a188127eeaf9194f945eb6eb89a657e93c54c/linux-x64/stable",
  wireBytes: 356_926_919,
  wireContentEncoding: "identity",
  wireSha256: "7d6ad3d3a78ac4551c14631f78d7e03c85282ab505c3ce8b1bc04e01fafe88ea"
});

export async function acquirePinnedVSCodeClient(
  parent,
  {
    downloadArtifact = downloadPinnedVSCodeClientArtifact,
    extractTar = extractPinnedVSCodeClientTar,
    inspectionPython = process.env.OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON,
    openResponse,
    runCommand,
    validateInstallation = validatePinnedVSCodeClientInstallation
  } = {}
) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Pinned VS Code client acquisition supports only Linux x64.");
  }
  if (
    typeof downloadArtifact !== "function" ||
    typeof extractTar !== "function" ||
    typeof validateInstallation !== "function"
  ) {
    throw new TypeError(
      "Pinned VS Code client acquisition requires bounded download, extraction, and validation functions."
    );
  }
  const exactInspectionPython = resolveRemoteInspectionPython(inspectionPython);
  const parentReceipt = privateDirectoryReceipt(parent);
  const root = join(parentReceipt.path, `vscode-client-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const rootReceipt = privateDirectoryReceipt(root, parentReceipt.canonicalPath);
  const target = validatePinnedVSCodeClientTarget(PINNED_VSCODE_CLIENT_TARGET);
  const artifact = await downloadArtifact(target, rootReceipt, { openResponse });
  const installationRoot = join(rootReceipt.path, "installation");
  mkdirSync(installationRoot, { mode: 0o700 });
  await extractTar(artifact, installationRoot, {
    archiveRoot: target.archiveRoot,
    inspectionPython: exactInspectionPython,
    runCommand
  });
  const editor = validateInstallation(installationRoot);
  return Object.freeze({
    editor: Object.freeze({
      name: "VS Code",
      key: "vscode",
      executable: editor.executable,
      cli: editor.cli,
      sharedDataDir: true
    }),
    root,
    target,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  });
}

export async function downloadPinnedVSCodeClientArtifact(
  rawTarget,
  rootReceipt,
  { openResponse = openHttpsResponse, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}
) {
  const target = validatePinnedVSCodeClientTarget(rawTarget);
  assertPrivateDirectoryReceipt(rootReceipt);
  if (typeof openResponse !== "function") {
    throw new Error("Pinned VS Code client acquisition requires an HTTPS response provider.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOWNLOAD_TIMEOUT_MS) {
    throw new Error(`Pinned VS Code client download timeout must be no larger than ${DOWNLOAD_TIMEOUT_MS} ms.`);
  }
  const wirePath = join(rootReceipt.path, `.vscode-wire-${randomUUID()}.tmp`);
  const finalPath = join(rootReceipt.path, target.artifactName);
  assertDirectChild(rootReceipt.path, wirePath);
  assertDirectChild(rootReceipt.path, finalPath);
  requireAbsentPath(finalPath);
  const descriptor = openSync(
    wirePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  const opened = fstatSync(descriptor, { bigint: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let completed = false;
  let publishedSnapshot;
  try {
    let response = await openResponse(target.url, { signal: controller.signal });
    if (target.redirectUrl) {
      assertRedirectResponse(response, target.redirectUrl);
      response = await openResponse(target.redirectUrl, { signal: controller.signal });
    }
    assertArtifactResponse(response, target);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > target.wireBytes) {
        throw new Error("The pinned VS Code client artifact exceeded its exact wire-size receipt.");
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(descriptor, chunk, offset, chunk.length - offset, null);
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw new Error("The pinned VS Code client artifact write made no progress.");
        }
        offset += written;
      }
    }
    if (bytes !== target.wireBytes || digest.digest("hex") !== target.wireSha256) {
      throw new Error("The pinned VS Code client artifact did not match its exact wire receipt.");
    }
    fsyncSync(descriptor);
    assertOpenFileUnchanged(descriptor, wirePath, opened, target.wireBytes);
    closeSync(descriptor);

    renameSync(wirePath, finalPath);
    publishedSnapshot = lstatSync(finalPath, { bigint: true });
    const receipt = immutableFileReceipt(finalPath, rootReceipt.canonicalPath);
    if (
      receipt.snapshot.size !== BigInt(target.decodedBytes) ||
      (await hashReceipt(receipt)) !== target.decodedSha256
    ) {
      throw new Error("The published pinned VS Code client artifact changed before use.");
    }
    completed = true;
    return Object.freeze({ ...receipt, sha256: target.decodedSha256, target });
  } finally {
    clearTimeout(timer);
    if (!completed) {
      try {
        closeSync(descriptor);
      } catch {
        // The original acquisition error remains authoritative.
      }
      removeIdentifiedTemporary(wirePath, opened);
      if (publishedSnapshot) removeIdentifiedTemporary(finalPath, publishedSnapshot);
    }
  }
}

export function validatePinnedVSCodeClientTarget(target) {
  let url;
  let redirectUrl;
  try {
    url = new URL(target?.url);
    redirectUrl = new URL(target?.redirectUrl);
  } catch {
    throw new Error("The pinned VS Code client target is malformed.");
  }
  if (
    !target ||
    typeof target !== "object" ||
    Object.keys(target).sort().join(",") !== [...TARGET_KEYS].sort().join(",") ||
    target.identity !== "vscode" ||
    basename(target.artifactName) !== target.artifactName ||
    !/^[A-Za-z0-9._-]+$/u.test(target.artifactName) ||
    target.format !== "tar.gz" ||
    typeof target.archiveRoot !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(target.archiveRoot) ||
    !isExactHttpsUrl(url, target.url) ||
    !isExactHttpsUrl(redirectUrl, target.redirectUrl) ||
    url.hostname !== "update.code.visualstudio.com" ||
    redirectUrl.hostname !== "vscode.download.prss.microsoft.com" ||
    !Number.isSafeInteger(target.wireBytes) ||
    target.wireBytes <= 0 ||
    !Number.isSafeInteger(target.decodedBytes) ||
    target.decodedBytes <= 0 ||
    target.decodedBytes !== target.wireBytes ||
    !/^[0-9a-f]{64}$/u.test(target.wireSha256) ||
    target.decodedSha256 !== target.wireSha256 ||
    target.wireContentEncoding !== "identity"
  ) {
    throw new Error("The pinned VS Code client target is malformed.");
  }
  return target;
}

export function validateTarManifest(entries, { archiveRoot, maximumEntries = MAX_ARCHIVE_ENTRIES } = {}) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > maximumEntries) {
    throw new Error("The pinned tar archive has an invalid entry count.");
  }
  const seen = new Set();
  const files = new Set();
  const normalizedRoot = archiveRoot ? `${archiveRoot}/` : undefined;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !["file", "directory"].includes(entry.type) ||
      typeof entry.name !== "string" ||
      Buffer.byteLength(entry.name, "utf8") <= 0 ||
      Buffer.byteLength(entry.name, "utf8") > MAX_ARCHIVE_PATH_BYTES ||
      entry.name.includes("\\") ||
      hasControlCharacters(entry.name)
    ) {
      throw new Error("The pinned tar archive contains an unsafe entry.");
    }
    const name = entry.name.replace(/\/+$/u, "");
    const parts = name.split("/");
    if (
      !name ||
      name.startsWith("/") ||
      parts.some((part) => !part || part === "." || part === "..") ||
      (normalizedRoot && name !== archiveRoot && !name.startsWith(normalizedRoot)) ||
      seen.has(name)
    ) {
      throw new Error("The pinned tar archive contains an unsafe or duplicate path.");
    }
    let ancestor = "";
    for (const part of parts.slice(0, -1)) {
      ancestor = ancestor ? `${ancestor}/${part}` : part;
      if (files.has(ancestor)) {
        throw new Error("The pinned tar archive places an entry below a file.");
      }
    }
    seen.add(name);
    if (entry.type === "file") files.add(name);
  }
  return Object.freeze({ entries: entries.length });
}
export async function extractPinnedVSCodeClientTar(
  artifact,
  destination,
  {
    archiveRoot = artifact?.target?.archiveRoot,
    runCommand = runBoundedEditorCommand,
    beforeArtifactSpawnForTest,
    inspectionPython = process.env.OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON
  } = {}
) {
  if (!artifact?.path || artifact.target?.format !== "tar.gz") {
    throw new Error("Pinned VS Code client extraction requires a validated tar artifact receipt.");
  }
  await assertPinnedVSCodeClientArtifactReceipt(artifact);
  const destinationReceipt = privateDirectoryReceipt(destination);
  const listing = await inspectTarManifest(artifact.path, {
    archiveRoot,
    inspectionPython: resolveRemoteInspectionPython(inspectionPython),
    runCommand,
    beforeSpawnCheck: pinnedVSCodeClientArtifactPreSpawnCheck(
      artifact,
      "Pinned VS Code client tar inspection",
      beforeArtifactSpawnForTest
    )
  });
  await assertPinnedVSCodeClientArtifactReceipt(artifact);
  validateTarManifest(listing, { archiveRoot });
  const args = [
    "--extract",
    "--gzip",
    "--file",
    artifact.path,
    "--directory",
    destinationReceipt.path,
    "--no-same-owner",
    "--no-same-permissions",
    "--delay-directory-restore",
    "--numeric-owner"
  ];
  if (archiveRoot) args.push("--strip-components=1");
  await runCommand(
    {
      executable: "/usr/bin/tar",
      args,
      environment: createEditorAcceptanceEnvironment(),
      label: `Pinned ${artifact.target.identity} extraction`,
      beforeSpawnCheck: pinnedVSCodeClientArtifactPreSpawnCheck(
        artifact,
        `Pinned ${artifact.target.identity} extraction`,
        beforeArtifactSpawnForTest
      )
    },
    { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES }
  );
  await assertPinnedVSCodeClientArtifactReceipt(artifact);
  assertPrivateDirectoryReceipt(destinationReceipt);
  return destinationReceipt;
}
export function validatePinnedVSCodeClientInstallation(clientRoot) {
  const client = privateDirectoryReceipt(clientRoot);
  const product = readBoundedJson(
    join(client.path, "resources", "app", "product.json"),
    2 * 1024 * 1024,
    client.canonicalPath
  );
  const packageJson = readBoundedJson(
    join(client.path, "resources", "app", "package.json"),
    2 * 1024 * 1024,
    client.canonicalPath
  );
  assertVSCodeProduct(product);
  if (packageJson.name !== "Code" || packageJson.version !== PINNED_VSCODE_VERSION) {
    throw new Error("The pinned VS Code client package identity drifted.");
  }
  if (
    hashBoundedFile(join(client.path, "resources", "app", "LICENSE.rtf"), 2 * 1024 * 1024, client.canonicalPath) !==
    PINNED_VSCODE_CLIENT_LICENSE_SHA256
  ) {
    throw new Error("The pinned VS Code client license receipt drifted.");
  }
  return Object.freeze({
    executable: assertContainedRegularFile(client.canonicalPath, join(client.path, "code")),
    cli: assertContainedRegularFile(client.canonicalPath, join(client.path, "bin", "code")),
    installationRoot: client.path,
    version: PINNED_VSCODE_VERSION,
    commit: PINNED_VSCODE_COMMIT
  });
}

async function inspectTarManifest(path, { archiveRoot, inspectionPython, runCommand, beforeSpawnCheck }) {
  const script = [
    "import json,sys,tarfile",
    "p=sys.argv[1]",
    "with tarfile.open(p,'r:gz') as t:",
    " m=t.getmembers()",
    " if len(m)>5000: raise SystemExit(43)",
    " for x in m:",
    "  k='directory' if x.isdir() else 'file' if x.isfile() else 'forbidden'",
    "  print(json.dumps({'name':x.name,'type':k},ensure_ascii=True,separators=(',',':')))"
  ].join("\n");
  const result = await runCommand(
    {
      executable: inspectionPython,
      args: ["-I", "-c", script, path],
      environment: createEditorAcceptanceEnvironment(),
      label: "Pinned VS Code client tar inspection",
      beforeSpawnCheck
    },
    { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 }
  );
  const entries = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  validateTarManifest(entries, { archiveRoot });
  return entries;
}

export function resolveRemoteInspectionPython(value = process.env.OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(
      "OW_REMOTE_INSPECTION_PYTHON_PREREQUISITE: set OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON to one prepared absolute interpreter."
    );
  }
  try {
    if (!statSync(value).isFile()) throw new Error("not a file");
    accessSync(value, constants.X_OK);
  } catch {
    throw new Error(
      "OW_REMOTE_INSPECTION_PYTHON_PREREQUISITE: OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON must identify one executable file."
    );
  }
  return value;
}
function openHttpsResponse(url, { signal }) {
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(
      url,
      {
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": `OpenWrangler-Installed-Performance/${PINNED_VSCODE_VERSION}`
        },
        method: "GET",
        signal
      },
      (response) => resolveResponse({ statusCode: response.statusCode, headers: response.headers, body: response })
    );
    request.once("error", reject);
    request.end();
  });
}

function assertRedirectResponse(response, expectedLocation) {
  if (
    !response ||
    ![301, 302, 303, 307, 308].includes(response.statusCode) ||
    headerValue(response.headers, "location") !== expectedLocation
  ) {
    throw new Error("The pinned VS Code client redirect target drifted.");
  }
  response.body?.resume?.();
}

function assertArtifactResponse(response, target) {
  const contentLength = headerValue(response?.headers, "content-length");
  const contentEncoding = headerValue(response?.headers, "content-encoding") ?? "identity";
  if (
    response?.statusCode !== 200 ||
    !response.body ||
    contentLength !== String(target.wireBytes) ||
    contentEncoding.toLowerCase() !== target.wireContentEncoding
  ) {
    throw new Error("The pinned VS Code client endpoint returned an unexpected response.");
  }
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertVSCodeProduct(product) {
  if (
    product?.nameLong !== "Visual Studio Code" ||
    product?.nameShort !== "Code" ||
    product?.applicationName !== "code" ||
    product?.version !== PINNED_VSCODE_VERSION ||
    product?.commit !== PINNED_VSCODE_COMMIT ||
    product?.quality !== "stable"
  ) {
    throw new Error("The pinned VS Code product identity drifted.");
  }
}

function readBoundedJson(path, maximumBytes, containedBy) {
  return JSON.parse(
    readBoundedRegularFile(path, maximumBytes, {
      containedBy,
      label: "Pinned VS Code metadata"
    }).toString("utf8")
  );
}

function hashBoundedFile(path, maximumBytes, containedBy) {
  return createHash("sha256")
    .update(
      readBoundedRegularFile(path, maximumBytes, {
        containedBy,
        label: "Pinned VS Code runtime or license"
      })
    )
    .digest("hex");
}

function assertContainedRegularFile(root, path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The pinned VS Code installation is incomplete.");
  }
  assertContainedPath(root, realpathSync(path));
  return path;
}

function isExactHttpsUrl(url, raw) {
  return (
    url.href === raw &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !raw.includes("\\")
  );
}
function privateDirectoryReceipt(path, containedBy) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Pinned VS Code client acquisition requires an absolute private directory.");
  }
  const resolved = resolve(path);
  const metadata = lstatSync(resolved, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o777n) !== 0o700n)
  ) {
    throw new Error("Pinned VS Code client acquisition requires a real mode-0700 private directory.");
  }
  const canonicalPath = realpathSync(resolved);
  if (containedBy) assertContainedPath(containedBy, canonicalPath);
  return Object.freeze({ path: resolved, canonicalPath, snapshot: Object.freeze(directorySnapshot(metadata)) });
}

function assertPrivateDirectoryReceipt(receipt) {
  if (!receipt?.path || !receipt?.canonicalPath || !receipt?.snapshot) {
    throw new Error("Pinned VS Code client acquisition requires an immutable private-root receipt.");
  }
  const current = lstatSync(receipt.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    realpathSync(receipt.path) !== receipt.canonicalPath ||
    !sameDirectoryIdentity(directorySnapshot(current), receipt.snapshot)
  ) {
    throw new Error("The pinned VS Code client private root changed during acquisition.");
  }
}

function immutableFileReceipt(path, containedBy) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("A pinned VS Code client artifact must be one private regular file.");
  }
  const canonicalPath = realpathSync(path);
  assertContainedPath(containedBy, canonicalPath);
  return Object.freeze({ path, canonicalPath, snapshot: Object.freeze(fileSnapshot(metadata)) });
}

export async function assertPinnedVSCodeClientArtifactReceipt(artifact, { afterHashOpen } = {}) {
  const target = assertPinnedVSCodeClientArtifactIdentity(artifact);
  const receipt = immutableFileReceipt(artifact.path, dirname(artifact.canonicalPath));
  if (
    !sameFileSnapshot(receipt.snapshot, artifact.snapshot) ||
    (await hashReceipt(receipt, { afterOpen: afterHashOpen })) !== target.decodedSha256
  ) {
    throw new Error("The pinned VS Code client artifact receipt changed before use.");
  }
}

function assertPinnedVSCodeClientArtifactIdentity(artifact) {
  const target = validatePinnedVSCodeClientTarget(artifact?.target);
  if (
    !artifact ||
    typeof artifact !== "object" ||
    artifact.sha256 !== target.decodedSha256 ||
    artifact.snapshot?.size !== BigInt(target.decodedBytes) ||
    typeof artifact.path !== "string" ||
    typeof artifact.canonicalPath !== "string" ||
    realpathSync(artifact.path) !== artifact.canonicalPath
  ) {
    throw new Error("The pinned VS Code client artifact receipt changed before use.");
  }
  const receipt = immutableFileReceipt(artifact.path, dirname(artifact.canonicalPath));
  if (!sameFileSnapshot(receipt.snapshot, artifact.snapshot)) {
    throw new Error("The pinned VS Code client artifact receipt changed before use.");
  }
  return target;
}

function pinnedVSCodeClientArtifactPreSpawnCheck(artifact, label, beforeArtifactSpawnForTest) {
  return () => {
    const hookResult = beforeArtifactSpawnForTest?.(Object.freeze({ label, path: artifact.path }));
    if (hookResult !== undefined) {
      throw new Error(
        "Pinned VS Code client extraction launch-race hooks must complete synchronously without a result."
      );
    }
    assertPinnedVSCodeClientArtifactIdentity(artifact);
  };
}

async function hashReceipt(receipt, { afterOpen } = {}) {
  const descriptor = openSync(receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fileSnapshot(fstatSync(descriptor, { bigint: true }));
    if (!sameFileSnapshot(opened, receipt.snapshot)) {
      throw new Error("The pinned VS Code client artifact changed before hashing.");
    }
    if (afterOpen !== undefined) {
      if (typeof afterOpen !== "function") {
        throw new Error("The pinned VS Code client artifact hash hook is malformed.");
      }
      await afterOpen();
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(undefined, { fd: descriptor, autoClose: false })) {
      digest.update(chunk);
    }
    const completed = fileSnapshot(fstatSync(descriptor, { bigint: true }));
    const named = lstatSync(receipt.path, { bigint: true });
    if (
      !sameFileSnapshot(completed, receipt.snapshot) ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      !sameFileSnapshot(fileSnapshot(named), receipt.snapshot)
    ) {
      throw new Error("The pinned VS Code client artifact changed while hashing.");
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function assertOpenFileUnchanged(descriptor, path, opened, expectedBytes) {
  const completed = fstatSync(descriptor, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  if (
    completed.dev !== opened.dev ||
    completed.ino !== opened.ino ||
    named.dev !== opened.dev ||
    named.ino !== opened.ino ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size !== BigInt(expectedBytes)
  ) {
    throw new Error("The pinned VS Code client artifact changed during download.");
  }
}

function directorySnapshot(metadata) {
  return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, birthtimeNs: metadata.birthtimeNs };
}

function fileSnapshot(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  };
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function assertContainedPath(root, candidate) {
  const relation = relative(root, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("Pinned VS Code client acquisition escaped its private root.");
  }
}

function assertDirectChild(root, candidate) {
  const relation = relative(root, candidate);
  if (!relation || relation.includes(sep) || relation === ".." || isAbsolute(relation)) {
    throw new Error("Pinned VS Code client acquisition requires a direct private-root child.");
  }
}

function requireAbsentPath(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Pinned VS Code client acquisition refuses to replace an existing path.");
}

function removeIdentifiedTemporary(path, expected) {
  try {
    const current = lstatSync(path, { bigint: true });
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1n &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    ) {
      unlinkSync(path);
    }
  } catch {
    // The caller-owned private root remains available for fail-closed cleanup.
  }
}
