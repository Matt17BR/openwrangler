import { createHash, randomUUID } from "node:crypto";
import {
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
  unlinkSync,
  writeSync
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBoundedRegularFile } from "./bounded-file-read.mjs";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";

export const PINNED_CURSOR_VERSION = "3.13.10";
export const PINNED_CURSOR_PRODUCT_COMMIT = "4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f0";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EXTRACTION_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_OUTPUT_LIMIT_BYTES = 16 * 1024;
const CURSOR_MACOS_TEAM_IDENTIFIER = "VDXQ22DGB9";
const CURSOR_WINDOWS_SIGNER = "CN=Anysphere, Inc.";
const TARGET_KEYS = new Set([
  "architecture",
  "artifactName",
  "bytes",
  "format",
  "platform",
  "productCommit",
  "sha256",
  "url",
  "version"
]);

export const PINNED_CURSOR_TARGETS = Object.freeze({
  "darwin-universal": Object.freeze({
    architecture: "universal",
    artifactName: "Cursor-darwin-universal.dmg",
    bytes: 430_139_751,
    format: "dmg",
    platform: "darwin",
    productCommit: PINNED_CURSOR_PRODUCT_COMMIT,
    sha256: "42b1edea8912eb0b2fc686ea89a4a0047aaaf43da4f7d8eb34a4bafa35d477b1",
    url: "https://downloads.cursor.com/production/4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7/darwin/universal/Cursor-darwin-universal.dmg",
    version: PINNED_CURSOR_VERSION
  }),
  "win32-x64": Object.freeze({
    architecture: "x64",
    artifactName: "CursorUserSetup-x64-3.13.10.exe",
    bytes: 199_233_712,
    format: "inno",
    platform: "win32",
    productCommit: PINNED_CURSOR_PRODUCT_COMMIT,
    sha256: "2f99ebb41bcce62cd6c8e4611e56a613b9abaf2399a8ce02e7925798e0f64522",
    url: "https://downloads.cursor.com/production/4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7/win32/x64/user-setup/CursorUserSetup-x64-3.13.10.exe",
    version: PINNED_CURSOR_VERSION
  })
});

export function resolvePinnedCursorTarget(platform = hostPlatform(), architecture = hostArchitecture()) {
  const key =
    platform === "darwin" && (architecture === "arm64" || architecture === "x64")
      ? "darwin-universal"
      : platform === "win32" && architecture === "x64"
        ? "win32-x64"
        : undefined;
  if (!key) {
    throw new Error(
      `Pinned Cursor acceptance does not support ${JSON.stringify(platform)} ${JSON.stringify(architecture)}.`
    );
  }
  return validatePinnedCursorTarget(PINNED_CURSOR_TARGETS[key]);
}

export async function acquirePinnedCursor(
  parent,
  {
    platform = hostPlatform(),
    architecture = hostArchitecture(),
    openResponse = openPinnedCursorResponse,
    extractTarget = extractPinnedCursorTarget
  } = {}
) {
  const target = resolvePinnedCursorTarget(platform, architecture);
  const parentReceipt = privateDirectoryReceipt(parent);
  const root = join(parentReceipt.path, `cursor-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const rootReceipt = privateDirectoryReceipt(root, parentReceipt.canonicalPath);
  const artifact = await downloadPinnedCursorArtifact(target, rootReceipt, { openResponse });
  const extracted = await extractTarget(target, artifact, rootReceipt);
  privateDirectoryReceipt(extracted.installationRoot, rootReceipt.canonicalPath);
  let editor;
  try {
    editor = validatePinnedCursorInstallation(target, extracted.installationRoot);
  } catch (error) {
    try {
      await extracted.cleanup?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The pinned Cursor installation was invalid and its private installation could not be removed."
      );
    }
    throw error;
  }
  return Object.freeze({
    editor: Object.freeze({
      name: "Cursor",
      key: "cursor",
      executable: editor.executable,
      cli: editor.cli,
      sharedDataDir: false
    }),
    root,
    target,
    cleanup: extracted.cleanup ?? (async () => undefined)
  });
}

export async function downloadPinnedCursorArtifact(
  rawTarget,
  rootReceipt,
  { afterTemporaryOpenForTest, openResponse = openPinnedCursorResponse, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}
) {
  const target = validatePinnedCursorTarget(rawTarget);
  assertPrivateDirectoryReceipt(rootReceipt);
  if (typeof openResponse !== "function") {
    throw new Error("Pinned Cursor acquisition requires an HTTPS response provider.");
  }
  if (afterTemporaryOpenForTest !== undefined && typeof afterTemporaryOpenForTest !== "function") {
    throw new Error("Pinned Cursor acquisition received a malformed descriptor-race test hook.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOWNLOAD_TIMEOUT_MS) {
    throw new Error(`Pinned Cursor download timeout must be no larger than ${DOWNLOAD_TIMEOUT_MS} ms.`);
  }

  const temporaryPath = join(rootReceipt.path, `.cursor-download-${randomUUID()}.tmp`);
  const finalPath = join(rootReceipt.path, target.artifactName);
  assertDirectChild(rootReceipt.path, temporaryPath);
  assertDirectChild(rootReceipt.path, finalPath);
  requireAbsentPath(finalPath);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(temporaryPath, flags, 0o600);
  const opened = fstatSync(descriptor, { bigint: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let completed = false;
  let publishedSnapshot;
  try {
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1n ||
      opened.size !== 0n ||
      (process.platform !== "win32" && (opened.mode & 0o777n) !== 0o600n)
    ) {
      throw new Error("The pinned Cursor artifact quarantine descriptor is malformed.");
    }
    assertPrivateDirectoryReceipt(rootReceipt);
    afterTemporaryOpenForTest?.(Object.freeze({ descriptor, temporaryPath }));
    const response = await openResponse(target.url, {
      signal: controller.signal,
      version: target.version
    });
    try {
      if (response?.statusCode !== 200 || !response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
        throw new Error("The pinned Cursor artifact endpoint did not return one successful bounded body.");
      }
      const contentLength = cursorHeaderValue(response.headers, "content-length");
      if (contentLength !== undefined && contentLength !== String(target.bytes)) {
        throw new Error("The pinned Cursor artifact endpoint returned an unexpected content length.");
      }
    } catch (error) {
      disposeRejectedCursorResponseBody(response?.body);
      throw error;
    }
    const received = await writePinnedCursorResponse(response.body, descriptor, target);
    if (received.bytes !== target.bytes || received.digest.digest("hex") !== target.sha256) {
      throw new Error("The pinned Cursor artifact did not match its exact size and SHA-256 receipt.");
    }
    fsyncSync(descriptor);
    const completedSnapshot = fstatSync(descriptor, { bigint: true });
    const pathSnapshot = lstatSync(temporaryPath, { bigint: true });
    if (
      !sameFileSnapshot(opened, completedSnapshot, { allowSizeChange: true }) ||
      !sameFileSnapshot(completedSnapshot, pathSnapshot) ||
      !pathSnapshot.isFile() ||
      pathSnapshot.isSymbolicLink() ||
      pathSnapshot.nlink !== 1n ||
      pathSnapshot.size !== BigInt(target.bytes)
    ) {
      throw new Error("The pinned Cursor artifact changed while it was downloaded.");
    }
    assertPrivateDirectoryReceipt(rootReceipt);
    closeSync(descriptor);
    requireAbsentPath(finalPath);
    renameSync(temporaryPath, finalPath);
    publishedSnapshot = lstatSync(finalPath, { bigint: true });
    const receipt = immutableFileReceipt(finalPath, rootReceipt.canonicalPath);
    if (receipt.snapshot.size !== BigInt(target.bytes) || (await hashReceipt(receipt)) !== target.sha256) {
      throw new Error("The published pinned Cursor artifact changed before extraction.");
    }
    completed = true;
    return Object.freeze({ ...receipt, sha256: target.sha256 });
  } finally {
    clearTimeout(timer);
    if (!completed) {
      try {
        closeSync(descriptor);
      } catch {
        // The original error remains authoritative.
      }
      removeIdentifiedTemporary(temporaryPath, opened);
      if (publishedSnapshot) removeIdentifiedTemporary(finalPath, publishedSnapshot);
    }
  }
}

function openPinnedCursorResponse(url, { signal, version }) {
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(
      url,
      {
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": `OpenWrangler-Cursor-Acceptance/${version}`
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

async function writePinnedCursorResponse(body, descriptor, target) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const rawChunk of body) {
    const chunk = Buffer.from(rawChunk);
    bytes += chunk.length;
    if (bytes > target.bytes) {
      throw new Error("The pinned Cursor artifact exceeded its exact byte receipt.");
    }
    digest.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const written = writeSync(descriptor, chunk, offset, chunk.length - offset, null);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("The pinned Cursor artifact write made no progress.");
      }
      offset += written;
    }
  }
  return Object.freeze({ bytes, digest });
}

function cursorHeaderValue(headers, name) {
  if (headers === undefined) return undefined;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("The pinned Cursor artifact endpoint returned malformed headers.");
  }
  const matches = Object.entries(headers).filter(([header]) => header.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return undefined;
  if (matches.length !== 1 || typeof matches[0][1] !== "string") {
    throw new Error("The pinned Cursor artifact endpoint returned an ambiguous content length.");
  }
  return matches[0][1];
}

function disposeRejectedCursorResponseBody(body) {
  if (!body) return;
  if (typeof body.destroy === "function") {
    body.destroy();
    return;
  }
  if (typeof body.resume === "function") {
    body.resume();
    return;
  }
  throw new Error("The rejected pinned Cursor response body could not be disposed.");
}

export function validatePinnedCursorInstallation(rawTarget, installationRoot) {
  const target = validatePinnedCursorTarget(rawTarget);
  const rootReceipt = privateDirectoryReceipt(installationRoot);
  const appRoot =
    target.platform === "darwin"
      ? join(rootReceipt.path, "Cursor.app", "Contents", "Resources", "app")
      : join(rootReceipt.path, "resources", "app");
  const executable =
    target.platform === "darwin"
      ? join(rootReceipt.path, "Cursor.app", "Contents", "MacOS", "Cursor")
      : join(rootReceipt.path, "Cursor.exe");
  const cli = target.platform === "darwin" ? join(appRoot, "bin", "cursor") : join(appRoot, "bin", "cursor.cmd");
  const packageJson = readBoundedJson(join(appRoot, "package.json"), 2 * 1024 * 1024, rootReceipt.canonicalPath);
  const productJson = readBoundedJson(join(appRoot, "product.json"), 2 * 1024 * 1024, rootReceipt.canonicalPath);
  if (
    packageJson.name !== "Cursor" ||
    packageJson.version !== target.version ||
    productJson.nameLong !== "Cursor" ||
    productJson.nameShort !== "Cursor" ||
    productJson.applicationName !== "cursor" ||
    productJson.version !== target.version ||
    productJson.commit !== target.productCommit ||
    productJson.quality !== "stable"
  ) {
    throw new Error("The extracted Cursor product identity does not match the pinned acceptance target.");
  }
  for (const path of [executable, cli]) assertContainedRegularFile(rootReceipt.canonicalPath, path);
  return Object.freeze({ executable, cli, installationRoot: rootReceipt.path });
}

export function validatePinnedCursorTarget(target) {
  let url;
  try {
    url = new URL(target?.url);
  } catch {
    throw new Error("The pinned Cursor acquisition target is malformed.");
  }
  if (
    !target ||
    typeof target !== "object" ||
    Object.keys(target).sort().join(",") !== [...TARGET_KEYS].sort().join(",") ||
    typeof target.url !== "string" ||
    url.href !== target.url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname !== "downloads.cursor.com" ||
    url.search ||
    url.hash ||
    typeof target.artifactName !== "string" ||
    basename(target.artifactName) !== target.artifactName ||
    !/^[A-Za-z0-9._-]+$/u.test(target.artifactName) ||
    !Number.isSafeInteger(target.bytes) ||
    target.bytes <= 0 ||
    typeof target.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(target.sha256) ||
    target.version !== PINNED_CURSOR_VERSION ||
    target.productCommit !== PINNED_CURSOR_PRODUCT_COMMIT ||
    !/^[0-9a-f]{40}$/u.test(target.productCommit) ||
    !(
      (target.platform === "darwin" && target.architecture === "universal" && target.format === "dmg") ||
      (target.platform === "win32" && target.architecture === "x64" && target.format === "inno")
    )
  ) {
    throw new Error("The pinned Cursor acquisition target is malformed.");
  }
  return target;
}

async function extractPinnedCursorTarget(target, artifact, rootReceipt) {
  await assertImmutableArtifactReceipt(target, artifact, rootReceipt);
  const installationRoot = join(rootReceipt.path, "installation");
  mkdirSync(installationRoot, { mode: 0o700 });
  privateDirectoryReceipt(installationRoot, rootReceipt.canonicalPath);
  if (target.platform === "darwin") {
    return extractDarwinTarget(target, artifact, rootReceipt, installationRoot);
  }
  return extractWindowsTarget(target, artifact, rootReceipt, installationRoot);
}

async function extractDarwinTarget(target, artifact, rootReceipt, installationRoot) {
  const mountPoint = join(rootReceipt.path, "mount");
  mkdirSync(mountPoint, { mode: 0o700 });
  privateDirectoryReceipt(mountPoint, rootReceipt.canonicalPath);
  const environment = createEditorAcceptanceEnvironment();
  let attached = false;
  let primaryError;
  try {
    await runBoundedEditorCommand(
      {
        executable: "/usr/bin/hdiutil",
        args: ["attach", artifact.path, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, "-quiet"],
        environment,
        label: "Pinned Cursor DMG attachment"
      },
      { timeoutMs: EXTRACTION_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
    );
    attached = true;
    const sourceApp = join(mountPoint, "Cursor.app");
    const sourceMetadata = lstatSync(sourceApp);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new Error("The pinned Cursor DMG did not contain one regular Cursor.app bundle.");
    }
    await runBoundedEditorCommand(
      {
        executable: "/usr/bin/ditto",
        args: ["--rsrc", "--extattr", sourceApp, join(installationRoot, "Cursor.app")],
        environment,
        label: "Pinned Cursor application extraction"
      },
      { timeoutMs: EXTRACTION_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
    );
    const signature = await runBoundedEditorCommand(
      {
        executable: "/usr/bin/codesign",
        args: ["--display", "--verbose=4", "--verify", "--deep", "--strict", join(installationRoot, "Cursor.app")],
        environment,
        label: "Pinned Cursor code-signature verification"
      },
      { timeoutMs: 60_000, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
    );
    if (
      !new RegExp(`^TeamIdentifier=${CURSOR_MACOS_TEAM_IDENTIFIER}$`, "mu").test(
        `${signature.stdout}\n${signature.stderr}`
      )
    ) {
      throw new Error("The pinned Cursor application did not retain its expected Apple signing team.");
    }
  } catch (error) {
    primaryError = error;
  }
  let detachError;
  if (attached) {
    try {
      await runBoundedEditorCommand(
        {
          executable: "/usr/bin/hdiutil",
          args: ["detach", mountPoint, "-force", "-quiet"],
          environment,
          label: "Pinned Cursor DMG detachment"
        },
        { timeoutMs: 60_000, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
      );
    } catch (error) {
      detachError = error;
    }
  }
  if (primaryError && detachError) {
    throw new AggregateError(
      [primaryError, detachError],
      "Pinned Cursor extraction failed and its DMG did not detach."
    );
  }
  if (primaryError) throw primaryError;
  if (detachError) throw detachError;
  return { installationRoot };
}

async function extractWindowsTarget(target, artifact, rootReceipt, installationRoot) {
  const environment = createEditorAcceptanceEnvironment();
  const systemRoot = environment.SYSTEMROOT;
  if (!systemRoot) throw new Error("Pinned Cursor Windows acquisition requires the isolated system root.");
  await runBoundedEditorCommand(
    {
      executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$signature = Get-AuthenticodeSignature -LiteralPath $args[0]; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*${CURSOR_WINDOWS_SIGNER}*') { exit 41 }`,
        artifact.path
      ],
      environment,
      label: "Pinned Cursor Authenticode verification"
    },
    { timeoutMs: 60_000, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
  );
  await runBoundedEditorCommand(
    {
      executable: artifact.path,
      args: [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/NOICONS",
        "/CURRENTUSER",
        "/TASKS=",
        "/SP-",
        `/DIR=${installationRoot}`
      ],
      environment,
      label: "Pinned Cursor private installation"
    },
    { timeoutMs: EXTRACTION_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
  );
  const uninstaller = join(installationRoot, "unins000.exe");
  assertContainedRegularFile(rootReceipt.canonicalPath, uninstaller);
  return {
    installationRoot,
    cleanup: async () => {
      await runBoundedEditorCommand(
        {
          executable: uninstaller,
          args: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
          environment,
          label: "Pinned Cursor private uninstallation"
        },
        { timeoutMs: EXTRACTION_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
      );
    }
  };
}

async function assertImmutableArtifactReceipt(target, artifact, rootReceipt) {
  assertPrivateDirectoryReceipt(rootReceipt);
  if (
    !artifact ||
    typeof artifact !== "object" ||
    artifact.sha256 !== target.sha256 ||
    artifact.snapshot?.size !== BigInt(target.bytes)
  ) {
    throw new Error("The pinned Cursor artifact receipt changed before extraction.");
  }
  assertContainedPath(rootReceipt.canonicalPath, artifact.canonicalPath);
  if ((await hashReceipt(artifact)) !== target.sha256) {
    throw new Error("The pinned Cursor artifact receipt changed before extraction.");
  }
}

export function createCursorAcquisitionRootReceipt(path, containedBy) {
  return privateDirectoryReceipt(path, containedBy);
}

export function assertCursorAcquisitionRootReceipt(receipt) {
  assertPrivateDirectoryReceipt(receipt);
}

function privateDirectoryReceipt(path, containedBy) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Pinned Cursor acquisition requires an absolute private directory.");
  }
  const resolved = resolve(path);
  const metadata = lstatSync(resolved, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o777n) !== 0o700n)
  ) {
    throw new Error("Pinned Cursor acquisition requires a real mode-0700 private directory.");
  }
  const canonicalPath = realpathSync(resolved);
  if (containedBy) assertContainedPath(containedBy, canonicalPath);
  return Object.freeze({
    path: resolved,
    canonicalPath,
    snapshot: Object.freeze(fileSnapshot(metadata))
  });
}

function assertPrivateDirectoryReceipt(receipt) {
  if (!receipt?.path || !receipt?.canonicalPath || !receipt?.snapshot) {
    throw new Error("Pinned Cursor acquisition requires an immutable private-root receipt.");
  }
  const current = lstatSync(receipt.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    realpathSync(receipt.path) !== receipt.canonicalPath ||
    !sameDirectoryIdentity(fileSnapshot(current), receipt.snapshot)
  ) {
    throw new Error("The pinned Cursor private root changed during acquisition.");
  }
}

function immutableFileReceipt(path, containedBy) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("A pinned Cursor artifact must be one private regular file.");
  }
  const canonicalPath = realpathSync(path);
  assertContainedPath(containedBy, canonicalPath);
  return Object.freeze({
    path,
    canonicalPath,
    snapshot: Object.freeze(fileSnapshot(metadata))
  });
}

async function hashReceipt(receipt) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(receipt.path, flags);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(fileSnapshot(opened), receipt.snapshot)) {
      throw new Error("The pinned Cursor artifact changed before it could be hashed.");
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(undefined, { fd: descriptor, autoClose: false })) {
      digest.update(chunk);
    }
    const completed = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(fileSnapshot(completed), receipt.snapshot)) {
      throw new Error("The pinned Cursor artifact changed while it was hashed.");
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedJson(path, maximumBytes, containedBy) {
  return JSON.parse(
    readBoundedRegularFile(path, maximumBytes, {
      containedBy,
      label: "Extracted Cursor metadata"
    }).toString("utf8")
  );
}

function assertContainedRegularFile(root, path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The extracted Cursor installation is incomplete.");
  }
  assertContainedPath(root, realpathSync(path));
}

function assertContainedPath(root, candidate) {
  const relation = relative(root, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("Pinned Cursor acquisition escaped its private root.");
  }
}

function assertDirectChild(root, candidate) {
  const relation = relative(root, candidate);
  if (!relation || relation.includes(sep) || relation === ".." || isAbsolute(relation)) {
    throw new Error("Pinned Cursor acquisition requires a direct private-root child.");
  }
}

function requireAbsentPath(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Pinned Cursor acquisition refuses to replace an existing path.");
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
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // The caller-owned root remains available for fail-closed cleanup.
    }
  }
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

function sameSnapshot(left, right) {
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

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFileSnapshot(left, right, { allowSizeChange = false } = {}) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    (allowSizeChange || left.size === right.size) &&
    left.birthtimeNs === right.birthtimeNs
  );
}
