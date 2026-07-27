import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { open as openZip } from "yauzl";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";

export const PINNED_REMOTE_VSCODE_VERSION = "1.130.0";
export const PINNED_REMOTE_VSCODE_COMMIT = "1b6a188127eeaf9194f945eb6eb89a657e93c54c";
export const PINNED_REMOTE_SSH_VERSION = "0.124.0";
export const PINNED_REMOTE_SSH_EXTENSION_ID = "ms-vscode-remote.remote-ssh";
export const PINNED_REMOTE_SSH_LICENSE_SHA256 = "75b72b0d3c48bd35d33641c731837be31ae2593f924abcdd296e8d57daf2f256";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_PATH_BYTES = 8 * 1024;
const MAX_VSIX_ENTRIES = 2_048;
const MAX_VSIX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_VSIX_TOTAL_BYTES = 128 * 1024 * 1024;
const PINNED_VSCODE_CLIENT_LICENSE_SHA256 = "318c800dec8b7a7d4faa013f4d688680c6fdb591c3516c939f6214e702586b0c";
const PINNED_VSCODE_SERVER_LICENSE_SHA256 = "b30dc57b522e7b728e453d0683dbc82982614c609f26225493bb21bb8518493d";
const PINNED_VSCODE_CLI_SHA256 = "81e7391534d35c9bc0fb097386b68ace9ac61ee42a63fda807154e5fbd2fc1a9";
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

export const PINNED_REMOTE_WORKSPACE_TARGETS = Object.freeze({
  vscode: Object.freeze({
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
  }),
  cli: Object.freeze({
    archiveRoot: undefined,
    artifactName: "vscode-cli-alpine-x64.tar.gz",
    decodedBytes: 12_192_722,
    decodedSha256: "46bb43be54a1b543f6eb5b8a98c750efa57d40cc47ce7634aaa3f2cfe467ac01",
    format: "tar.gz",
    identity: "cli",
    redirectUrl:
      "https://vscode.download.prss.microsoft.com/dbazure/download/stable/1b6a188127eeaf9194f945eb6eb89a657e93c54c/vscode_cli_alpine_x64_cli.tar.gz",
    url: "https://update.code.visualstudio.com/commit:1b6a188127eeaf9194f945eb6eb89a657e93c54c/cli-alpine-x64/stable",
    wireBytes: 12_192_722,
    wireContentEncoding: "identity",
    wireSha256: "46bb43be54a1b543f6eb5b8a98c750efa57d40cc47ce7634aaa3f2cfe467ac01"
  }),
  server: Object.freeze({
    archiveRoot: "vscode-server-linux-x64",
    artifactName: "vscode-server-linux-x64.tar.gz",
    decodedBytes: 192_198_459,
    decodedSha256: "a20b5740613dffcc5062f37f8ee0e096eeb09072736322fcc1eb45f2c5a7a9df",
    format: "tar.gz",
    identity: "server",
    redirectUrl:
      "https://vscode.download.prss.microsoft.com/dbazure/download/stable/1b6a188127eeaf9194f945eb6eb89a657e93c54c/vscode-server-linux-x64.tar.gz",
    url: "https://update.code.visualstudio.com/commit:1b6a188127eeaf9194f945eb6eb89a657e93c54c/server-linux-x64/stable",
    wireBytes: 192_198_459,
    wireContentEncoding: "identity",
    wireSha256: "a20b5740613dffcc5062f37f8ee0e096eeb09072736322fcc1eb45f2c5a7a9df"
  }),
  remoteSsh: Object.freeze({
    archiveRoot: undefined,
    artifactName: "ms-vscode-remote.remote-ssh-0.124.0.vsix",
    decodedBytes: 742_378,
    decodedSha256: "1a891224e1291e89a405b90f5018555d6642ac66e2e68653970e4f155d766416",
    format: "gzip-vsix",
    identity: "remoteSsh",
    redirectUrl: undefined,
    url: "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode-remote/vsextensions/remote-ssh/0.124.0/vspackage",
    wireBytes: 734_122,
    wireContentEncoding: "gzip",
    wireSha256: "8f8a278d2bd37ad764625c04af80054cff79c762e3be505822db7c368514a07c"
  })
});

export async function acquirePinnedRemoteWorkspaceArtifacts(parent, options = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Pinned Remote SSH acceptance supports only Linux x64.");
  }
  const parentReceipt = privateDirectoryReceipt(parent);
  const root = join(parentReceipt.path, `remote-workspace-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const rootReceipt = privateDirectoryReceipt(root, parentReceipt.canonicalPath);
  const artifacts = {};
  for (const key of ["vscode", "cli", "server", "remoteSsh"]) {
    const sourcePath = options.artifactPaths?.[key];
    artifacts[key] = sourcePath
      ? await stagePinnedRemoteArtifact(sourcePath, PINNED_REMOTE_WORKSPACE_TARGETS[key], rootReceipt)
      : await downloadPinnedRemoteArtifact(PINNED_REMOTE_WORKSPACE_TARGETS[key], rootReceipt, options);
  }
  await validateRemoteSshVsix(artifacts.remoteSsh.path);
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    root,
    rootReceipt,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  });
}

export async function stagePinnedRemoteArtifact(sourcePath, rawTarget, rootReceipt) {
  const target = validatePinnedRemoteTarget(rawTarget);
  assertPrivateDirectoryReceipt(rootReceipt);
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) {
    throw new Error("A cached pinned remote-workspace artifact must use an absolute path.");
  }
  const source = immutableFileReceipt(resolve(sourcePath), dirname(realpathSync(sourcePath)));
  if (source.snapshot.size !== BigInt(target.decodedBytes) || (await hashReceipt(source)) !== target.decodedSha256) {
    throw new Error("A cached pinned remote-workspace artifact did not match its exact receipt.");
  }
  const temporaryPath = join(rootReceipt.path, `.remote-cache-${randomUUID()}.tmp`);
  const finalPath = join(rootReceipt.path, target.artifactName);
  requireAbsentPath(finalPath);
  copyFileSync(source.path, temporaryPath, constants.COPYFILE_EXCL);
  chmodSync(temporaryPath, 0o600);
  const copied = immutableFileReceipt(temporaryPath, rootReceipt.canonicalPath);
  if (
    !sameFileSnapshot(source.snapshot, immutableFileReceipt(source.path, dirname(source.canonicalPath)).snapshot) ||
    copied.snapshot.size !== BigInt(target.decodedBytes) ||
    (await hashReceipt(copied)) !== target.decodedSha256
  ) {
    removeIdentifiedTemporary(temporaryPath, copied.snapshot);
    throw new Error("A cached pinned remote-workspace artifact changed while it was staged.");
  }
  renameSync(temporaryPath, finalPath);
  const receipt = immutableFileReceipt(finalPath, rootReceipt.canonicalPath);
  return Object.freeze({ ...receipt, sha256: target.decodedSha256, target });
}

export async function downloadPinnedRemoteArtifact(
  rawTarget,
  rootReceipt,
  { openResponse = openHttpsResponse, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}
) {
  const target = validatePinnedRemoteTarget(rawTarget);
  assertPrivateDirectoryReceipt(rootReceipt);
  if (typeof openResponse !== "function") {
    throw new Error("Pinned remote-workspace acquisition requires an HTTPS response provider.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOWNLOAD_TIMEOUT_MS) {
    throw new Error(`Pinned remote-workspace download timeout must be no larger than ${DOWNLOAD_TIMEOUT_MS} ms.`);
  }
  const wirePath = join(rootReceipt.path, `.remote-wire-${randomUUID()}.tmp`);
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
        throw new Error("The pinned remote-workspace artifact exceeded its exact wire-size receipt.");
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(descriptor, chunk, offset, chunk.length - offset, null);
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw new Error("The pinned remote-workspace artifact write made no progress.");
        }
        offset += written;
      }
    }
    if (bytes !== target.wireBytes || digest.digest("hex") !== target.wireSha256) {
      throw new Error("The pinned remote-workspace artifact did not match its exact wire receipt.");
    }
    fsyncSync(descriptor);
    assertOpenFileUnchanged(descriptor, wirePath, opened, target.wireBytes);
    closeSync(descriptor);

    if (target.format === "gzip-vsix") {
      const decodedPath = join(rootReceipt.path, `.remote-decoded-${randomUUID()}.tmp`);
      await decodePinnedGzip(wirePath, decodedPath, target);
      unlinkSync(wirePath);
      renameSync(decodedPath, finalPath);
    } else {
      renameSync(wirePath, finalPath);
    }
    publishedSnapshot = lstatSync(finalPath, { bigint: true });
    const receipt = immutableFileReceipt(finalPath, rootReceipt.canonicalPath);
    if (
      receipt.snapshot.size !== BigInt(target.decodedBytes) ||
      (await hashReceipt(receipt)) !== target.decodedSha256
    ) {
      throw new Error("The published pinned remote-workspace artifact changed before use.");
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

export function validatePinnedRemoteTarget(target) {
  let url;
  let redirectUrl;
  try {
    url = new URL(target?.url);
    redirectUrl = target?.redirectUrl ? new URL(target.redirectUrl) : undefined;
  } catch {
    throw new Error("The pinned remote-workspace target is malformed.");
  }
  if (
    !target ||
    typeof target !== "object" ||
    Object.keys(target).sort().join(",") !== [...TARGET_KEYS].sort().join(",") ||
    typeof target.identity !== "string" ||
    !["vscode", "cli", "server", "remoteSsh"].includes(target.identity) ||
    basename(target.artifactName) !== target.artifactName ||
    !/^[A-Za-z0-9._-]+$/u.test(target.artifactName) ||
    !["tar.gz", "gzip-vsix"].includes(target.format) ||
    (target.archiveRoot !== undefined &&
      (typeof target.archiveRoot !== "string" || !/^[A-Za-z0-9._-]+$/u.test(target.archiveRoot))) ||
    !isExactHttpsUrl(url, target.url) ||
    (redirectUrl && !isExactHttpsUrl(redirectUrl, target.redirectUrl)) ||
    !Number.isSafeInteger(target.wireBytes) ||
    target.wireBytes <= 0 ||
    !Number.isSafeInteger(target.decodedBytes) ||
    target.decodedBytes <= 0 ||
    !/^[0-9a-f]{64}$/u.test(target.wireSha256) ||
    !/^[0-9a-f]{64}$/u.test(target.decodedSha256) ||
    !["identity", "gzip"].includes(target.wireContentEncoding) ||
    (target.format === "gzip-vsix") !== (target.wireContentEncoding === "gzip") ||
    (target.format === "tar.gz" && target.decodedBytes !== target.wireBytes) ||
    (target.format === "tar.gz" && target.decodedSha256 !== target.wireSha256) ||
    (target.identity === "remoteSsh" &&
      (url.hostname !== "marketplace.visualstudio.com" || target.redirectUrl !== undefined)) ||
    (target.identity !== "remoteSsh" &&
      (url.hostname !== "update.code.visualstudio.com" ||
        redirectUrl?.hostname !== "vscode.download.prss.microsoft.com"))
  ) {
    throw new Error("The pinned remote-workspace target is malformed.");
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

export function assertRemoteSshPackIsolation(packageJson) {
  if (
    packageJson?.name !== "remote-ssh" ||
    packageJson?.publisher !== "ms-vscode-remote" ||
    packageJson?.version !== PINNED_REMOTE_SSH_VERSION ||
    packageJson?.engines?.vscode !== "^1.107.0" ||
    !Array.isArray(packageJson?.extensionKind) ||
    packageJson.extensionKind.join(",") !== "ui"
  ) {
    throw new Error("The Remote SSH VSIX identity or execution placement drifted.");
  }
  const pack = packageJson.extensionPack;
  if (
    !Array.isArray(pack) ||
    pack.length !== 2 ||
    pack[0] !== "ms-vscode-remote.remote-ssh-edit" ||
    pack[1] !== "ms-vscode.remote-explorer"
  ) {
    throw new Error("The Remote SSH optional extension pack drifted.");
  }
  return Object.freeze({
    installArguments: Object.freeze(["--do-not-include-pack-dependencies"]),
    optionalPack: Object.freeze([...pack])
  });
}

export async function validateRemoteSshVsix(path) {
  const receipt = immutableFileReceipt(path, dirname(realpathSync(path)));
  if (
    receipt.snapshot.size !== BigInt(PINNED_REMOTE_WORKSPACE_TARGETS.remoteSsh.decodedBytes) ||
    (await hashReceipt(receipt)) !== PINNED_REMOTE_WORKSPACE_TARGETS.remoteSsh.decodedSha256
  ) {
    throw new Error("The Remote SSH VSIX no longer matches its pinned receipt.");
  }
  const required = new Map([
    ["extension/package.json", undefined],
    ["extension/LICENSE.txt", undefined]
  ]);
  let total = 0;
  let count = 0;
  await visitZip(path, async (entry, zip) => {
    count += 1;
    if (count > MAX_VSIX_ENTRIES) throw new Error("The Remote SSH VSIX contains too many entries.");
    validateZipEntry(entry);
    total += entry.uncompressedSize;
    if (entry.uncompressedSize > MAX_VSIX_ENTRY_BYTES || total > MAX_VSIX_TOTAL_BYTES) {
      throw new Error("The Remote SSH VSIX exceeds its extraction budget.");
    }
    if (required.has(entry.fileName)) {
      required.set(entry.fileName, await readBoundedZipEntry(zip, entry));
    }
  });
  if ([...required.values()].some((value) => !value)) {
    throw new Error("The Remote SSH VSIX is missing required metadata.");
  }
  const packageJson = JSON.parse(required.get("extension/package.json").toString("utf8"));
  const packIsolation = assertRemoteSshPackIsolation(packageJson);
  const licenseSha = createHash("sha256").update(required.get("extension/LICENSE.txt")).digest("hex");
  if (licenseSha !== PINNED_REMOTE_SSH_LICENSE_SHA256) {
    throw new Error("The Remote SSH VSIX license receipt drifted.");
  }
  return Object.freeze({
    extensionId: PINNED_REMOTE_SSH_EXTENSION_ID,
    version: PINNED_REMOTE_SSH_VERSION,
    packIsolation,
    licenseSha256: licenseSha
  });
}

export async function extractPinnedRemoteTar(
  artifact,
  destination,
  { archiveRoot = artifact?.target?.archiveRoot, runCommand = runBoundedEditorCommand } = {}
) {
  if (!artifact?.path || artifact.target?.format !== "tar.gz") {
    throw new Error("Pinned remote extraction requires a validated tar artifact receipt.");
  }
  await assertPinnedRemoteArtifactReceipt(artifact);
  const destinationReceipt = privateDirectoryReceipt(destination);
  const listing = await inspectTarManifest(artifact.path, { archiveRoot, runCommand });
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
      label: `Pinned ${artifact.target.identity} extraction`
    },
    { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES }
  );
  assertPrivateDirectoryReceipt(destinationReceipt);
  return destinationReceipt;
}

export async function validatePinnedRemoteInstallations(
  { clientRoot, cliPath, serverRoot },
  { runCommand = runBoundedEditorCommand } = {}
) {
  const client = privateDirectoryReceipt(clientRoot);
  const server = privateDirectoryReceipt(serverRoot);
  const clientProduct = readBoundedJson(join(client.path, "resources", "app", "product.json"));
  const clientPackage = readBoundedJson(join(client.path, "resources", "app", "package.json"));
  const serverProduct = readBoundedJson(join(server.path, "product.json"));
  assertVSCodeProduct(clientProduct);
  assertVSCodeProduct(serverProduct);
  if (clientPackage.name !== "Code" || clientPackage.version !== PINNED_REMOTE_VSCODE_VERSION) {
    throw new Error("The pinned VS Code client package identity drifted.");
  }
  const clientExecutable = assertContainedRegularFile(client.canonicalPath, join(client.path, "code"));
  const clientCli = assertContainedRegularFile(client.canonicalPath, join(client.path, "bin", "code"));
  const serverExecutable = assertContainedRegularFile(server.canonicalPath, join(server.path, "bin", "code-server"));
  const cli = immutableFileReceipt(cliPath, dirname(realpathSync(cliPath)));
  if (
    cli.snapshot.size !== 32_732_320n ||
    (await hashReceipt(cli)) !== PINNED_VSCODE_CLI_SHA256 ||
    hashBoundedFile(join(client.path, "resources", "app", "LICENSE.rtf"), 2 * 1024 * 1024) !==
      PINNED_VSCODE_CLIENT_LICENSE_SHA256 ||
    hashBoundedFile(join(server.path, "LICENSE"), 64 * 1024) !== PINNED_VSCODE_SERVER_LICENSE_SHA256
  ) {
    throw new Error("The pinned VS Code executable or license receipt drifted.");
  }
  const environment = createEditorAcceptanceEnvironment();
  const [cliVersion, serverVersion] = await Promise.all([
    runCommand(
      {
        executable: cli.path,
        args: ["--version"],
        environment,
        label: "Pinned VS Code remote CLI identity"
      },
      { timeoutMs: 30_000, maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES }
    ),
    runCommand(
      {
        executable: serverExecutable,
        args: ["--version"],
        environment,
        label: "Pinned VS Code server identity"
      },
      { timeoutMs: 30_000, maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES }
    )
  ]);
  const expectedVersionLines = [PINNED_REMOTE_VSCODE_VERSION, PINNED_REMOTE_VSCODE_COMMIT, "x64"].join("\n");
  if (
    cliVersion.stdout.trim() !== `code ${PINNED_REMOTE_VSCODE_VERSION} (commit ${PINNED_REMOTE_VSCODE_COMMIT})` ||
    serverVersion.stdout.trim() !== expectedVersionLines
  ) {
    throw new Error("The pinned VS Code CLI or server executable identity drifted.");
  }
  return Object.freeze({
    clientExecutable,
    clientCli,
    cli: cli.path,
    serverExecutable,
    version: PINNED_REMOTE_VSCODE_VERSION,
    commit: PINNED_REMOTE_VSCODE_COMMIT
  });
}

async function inspectTarManifest(path, { archiveRoot, runCommand }) {
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
      executable: process.env.OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON ?? "python3",
      args: ["-I", "-c", script, path],
      environment: createEditorAcceptanceEnvironment(),
      label: "Pinned remote-workspace tar inspection"
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

async function decodePinnedGzip(wirePath, decodedPath, target) {
  const descriptor = openSync(
    decodedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  const opened = fstatSync(descriptor, { bigint: true });
  closeSync(descriptor);
  let completed = false;
  try {
    await pipeline(
      createReadStream(wirePath),
      createGunzip(),
      createWriteStream(decodedPath, { flags: "r+", mode: 0o600 })
    );
    const receipt = immutableFileReceipt(decodedPath, dirname(realpathSync(decodedPath)));
    if (
      receipt.snapshot.dev !== opened.dev ||
      receipt.snapshot.ino !== opened.ino ||
      receipt.snapshot.size !== BigInt(target.decodedBytes) ||
      (await hashReceipt(receipt)) !== target.decodedSha256
    ) {
      throw new Error("The decoded Remote SSH VSIX did not match its exact receipt.");
    }
    completed = true;
  } finally {
    if (!completed) rmSync(decodedPath, { force: true });
  }
}

function openHttpsResponse(url, { signal }) {
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(
      url,
      {
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": `OpenWrangler-Remote-Acceptance/${PINNED_REMOTE_VSCODE_VERSION}`
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
    throw new Error("The pinned remote-workspace redirect target drifted.");
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
    throw new Error("The pinned remote-workspace endpoint returned an unexpected response.");
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
    product?.version !== PINNED_REMOTE_VSCODE_VERSION ||
    product?.commit !== PINNED_REMOTE_VSCODE_COMMIT ||
    product?.quality !== "stable"
  ) {
    throw new Error("The pinned VS Code product identity drifted.");
  }
}

function readBoundedJson(path, maximumBytes = 2 * 1024 * 1024) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error("Pinned VS Code metadata must be one bounded regular file.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashBoundedFile(path, maximumBytes) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error("A pinned VS Code license must be one bounded regular file.");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function validateZipEntry(entry) {
  const name = entry.fileName;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (
    typeof name !== "string" ||
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    hasControlCharacters(name) ||
    name.split("/").some((part) => part === "." || part === "..") ||
    (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000)
  ) {
    throw new Error("The Remote SSH VSIX contains an unsafe archive entry.");
  }
}

function visitZip(path, visitor) {
  return new Promise((resolveVisit, reject) => {
    openZip(path, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("The Remote SSH VSIX could not be opened."));
      let chain = Promise.resolve();
      zip.once("error", reject);
      zip.once("end", () => chain.then(resolveVisit, reject));
      zip.on("entry", (entry) => {
        chain = chain.then(() => visitor(entry, zip));
        chain.then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  });
}

function readBoundedZipEntry(zip, entry) {
  return new Promise((resolveEntry, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error("A required VSIX entry could not be read."));
      const chunks = [];
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_VSIX_ENTRY_BYTES) stream.destroy(new Error("A VSIX entry exceeded its bound."));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolveEntry(Buffer.concat(chunks)));
    });
  });
}

export function createRemoteAcquisitionRootReceipt(path, containedBy) {
  return privateDirectoryReceipt(path, containedBy);
}

export function assertRemoteAcquisitionRootReceipt(receipt) {
  assertPrivateDirectoryReceipt(receipt);
}

function privateDirectoryReceipt(path, containedBy) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Pinned remote-workspace acquisition requires an absolute private directory.");
  }
  const resolved = resolve(path);
  const metadata = lstatSync(resolved, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o777n) !== 0o700n)
  ) {
    throw new Error("Pinned remote-workspace acquisition requires a real mode-0700 private directory.");
  }
  const canonicalPath = realpathSync(resolved);
  if (containedBy) assertContainedPath(containedBy, canonicalPath);
  return Object.freeze({ path: resolved, canonicalPath, snapshot: Object.freeze(directorySnapshot(metadata)) });
}

function assertPrivateDirectoryReceipt(receipt) {
  if (!receipt?.path || !receipt?.canonicalPath || !receipt?.snapshot) {
    throw new Error("Pinned remote-workspace acquisition requires an immutable private-root receipt.");
  }
  const current = lstatSync(receipt.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    realpathSync(receipt.path) !== receipt.canonicalPath ||
    !sameDirectoryIdentity(directorySnapshot(current), receipt.snapshot)
  ) {
    throw new Error("The pinned remote-workspace private root changed during acquisition.");
  }
}

function immutableFileReceipt(path, containedBy) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("A pinned remote-workspace artifact must be one private regular file.");
  }
  const canonicalPath = realpathSync(path);
  assertContainedPath(containedBy, canonicalPath);
  return Object.freeze({ path, canonicalPath, snapshot: Object.freeze(fileSnapshot(metadata)) });
}

async function assertPinnedRemoteArtifactReceipt(artifact) {
  const target = validatePinnedRemoteTarget(artifact.target);
  if (
    artifact.sha256 !== target.decodedSha256 ||
    artifact.snapshot?.size !== BigInt(target.decodedBytes) ||
    typeof artifact.canonicalPath !== "string" ||
    realpathSync(artifact.path) !== artifact.canonicalPath
  ) {
    throw new Error("The pinned remote-workspace artifact receipt changed before extraction.");
  }
  const receipt = immutableFileReceipt(artifact.path, dirname(artifact.canonicalPath));
  if (!sameFileSnapshot(receipt.snapshot, artifact.snapshot) || (await hashReceipt(receipt)) !== target.decodedSha256) {
    throw new Error("The pinned remote-workspace artifact receipt changed before extraction.");
  }
}

async function hashReceipt(receipt) {
  const descriptor = openSync(receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fileSnapshot(fstatSync(descriptor, { bigint: true }));
    if (!sameFileSnapshot(opened, receipt.snapshot)) {
      throw new Error("The pinned remote-workspace artifact changed before hashing.");
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(undefined, { fd: descriptor, autoClose: false })) {
      digest.update(chunk);
    }
    if (!sameFileSnapshot(fileSnapshot(fstatSync(descriptor, { bigint: true })), receipt.snapshot)) {
      throw new Error("The pinned remote-workspace artifact changed while hashing.");
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
    throw new Error("The pinned remote-workspace artifact changed during download.");
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
    throw new Error("Pinned remote-workspace acquisition escaped its private root.");
  }
}

function assertDirectChild(root, candidate) {
  const relation = relative(root, candidate);
  if (!relation || relation.includes(sep) || relation === ".." || isAbsolute(relation)) {
    throw new Error("Pinned remote-workspace acquisition requires a direct private-root child.");
  }
}

function requireAbsentPath(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Pinned remote-workspace acquisition refuses to replace an existing path.");
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
