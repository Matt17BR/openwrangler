import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
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
const WINDOWS_AUTHENTICODE_TIMEOUT_MS = 2 * 60_000;
const CURSOR_MACOS_TEAM_IDENTIFIER = "VDXQ22DGB9";
const CURSOR_WINDOWS_SIGNER_NAME = "Anysphere, Inc.";
const CURSOR_WINDOWS_SIGNER_CERTIFICATE_SHA256 = "A64BA881C8D4EEAA0E9556856B750CB3C658E0C9765BABFDCEAB3A2797B905AB";
const CURSOR_WINDOWS_AUTHENTICODE_SOURCE = String.raw`using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

public static class OpenWranglerCursorAuthenticode
{
    private const uint WTD_UI_NONE = 2;
    private const uint WTD_REVOKE_NONE = 0;
    private const uint WTD_CHOICE_FILE = 1;
    private const uint WTD_STATEACTION_VERIFY = 1;
    private const uint WTD_STATEACTION_CLOSE = 2;
    private const uint WTD_REVOCATION_CHECK_NONE = 0x10;
    private const uint WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000;
    private const uint WTD_DISABLE_MD2_MD4 = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_FILE_INFO
    {
        internal uint cbStruct;
        internal IntPtr pcwszFilePath;
        internal IntPtr hFile;
        internal IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_DATA
    {
        internal uint cbStruct;
        internal IntPtr pPolicyCallbackData;
        internal IntPtr pSIPClientData;
        internal uint dwUIChoice;
        internal uint fdwRevocationChecks;
        internal uint dwUnionChoice;
        internal IntPtr pFile;
        internal uint dwStateAction;
        internal IntPtr hWVTStateData;
        internal IntPtr pwszURLReference;
        internal uint dwProvFlags;
        internal uint dwUIContext;
        internal IntPtr pSignatureSettings;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CRYPT_PROVIDER_SGNR_PREFIX
    {
        internal uint cbStruct;
        internal System.Runtime.InteropServices.ComTypes.FILETIME sftVerifyAsOf;
        internal uint csCertChain;
        internal IntPtr pasCertChain;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CRYPT_PROVIDER_CERT_PREFIX
    {
        internal uint cbStruct;
        internal IntPtr pCert;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CERT_CONTEXT_PREFIX
    {
        internal uint dwCertEncodingType;
        internal IntPtr pbCertEncoded;
        internal uint cbCertEncoded;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int WinVerifyTrust(
        IntPtr hwnd,
        [In] ref Guid pgActionID,
        [In, Out] ref WINTRUST_DATA pWinTrustData);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperProvDataFromStateData(IntPtr hStateData);

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern IntPtr WTHelperGetProvSignerFromChain(
        IntPtr pProvData,
        uint idxSigner,
        [MarshalAs(UnmanagedType.Bool)] bool fCounterSigner,
        uint idxCounterSigner);

    public static X509Certificate2 VerifyAndGetSigner(string path)
    {
        if (String.IsNullOrEmpty(path))
        {
            throw new ArgumentException("A signed file path is required.", "path");
        }

        IntPtr pathPointer = IntPtr.Zero;
        IntPtr fileInfoPointer = IntPtr.Zero;
        WINTRUST_DATA trustData = new WINTRUST_DATA();
        Guid action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        try
        {
            pathPointer = Marshal.StringToCoTaskMemUni(path);
            WINTRUST_FILE_INFO fileInfo = new WINTRUST_FILE_INFO();
            fileInfo.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
            fileInfo.pcwszFilePath = pathPointer;
            fileInfo.hFile = IntPtr.Zero;
            fileInfo.pgKnownSubject = IntPtr.Zero;
            fileInfoPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);

            trustData.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
            trustData.pPolicyCallbackData = IntPtr.Zero;
            trustData.pSIPClientData = IntPtr.Zero;
            trustData.dwUIChoice = WTD_UI_NONE;
            trustData.fdwRevocationChecks = WTD_REVOKE_NONE;
            trustData.dwUnionChoice = WTD_CHOICE_FILE;
            trustData.pFile = fileInfoPointer;
            trustData.dwStateAction = WTD_STATEACTION_VERIFY;
            trustData.hWVTStateData = IntPtr.Zero;
            trustData.pwszURLReference = IntPtr.Zero;
            trustData.dwProvFlags = WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_DISABLE_MD2_MD4;
            trustData.dwUIContext = 0;
            trustData.pSignatureSettings = IntPtr.Zero;

            int status = WinVerifyTrust(new IntPtr(-1), ref action, ref trustData);
            if (status != 0)
            {
                throw new CryptographicException(
                    String.Format("WinVerifyTrust rejected the pinned artifact with status 0x{0:X8}.", unchecked((uint)status)));
            }
            if (trustData.hWVTStateData == IntPtr.Zero)
            {
                throw new CryptographicException("WinVerifyTrust returned no provider state.");
            }

            IntPtr providerData = WTHelperProvDataFromStateData(trustData.hWVTStateData);
            if (providerData == IntPtr.Zero)
            {
                throw new CryptographicException("WinVerifyTrust returned no provider data.");
            }
            IntPtr signerPointer = WTHelperGetProvSignerFromChain(providerData, 0, false, 0);
            if (signerPointer == IntPtr.Zero)
            {
                throw new CryptographicException("WinVerifyTrust returned no primary signer.");
            }
            CRYPT_PROVIDER_SGNR_PREFIX signer = (CRYPT_PROVIDER_SGNR_PREFIX)Marshal.PtrToStructure(
                signerPointer,
                typeof(CRYPT_PROVIDER_SGNR_PREFIX));
            if (signer.csCertChain == 0 || signer.pasCertChain == IntPtr.Zero)
            {
                throw new CryptographicException("WinVerifyTrust returned an empty signer chain.");
            }
            CRYPT_PROVIDER_CERT_PREFIX providerCertificate =
                (CRYPT_PROVIDER_CERT_PREFIX)Marshal.PtrToStructure(
                    signer.pasCertChain,
                    typeof(CRYPT_PROVIDER_CERT_PREFIX));
            if (providerCertificate.pCert == IntPtr.Zero)
            {
                throw new CryptographicException("WinVerifyTrust returned no leaf certificate context.");
            }
            CERT_CONTEXT_PREFIX certificateContext = (CERT_CONTEXT_PREFIX)Marshal.PtrToStructure(
                providerCertificate.pCert,
                typeof(CERT_CONTEXT_PREFIX));
            if (
                certificateContext.pbCertEncoded == IntPtr.Zero ||
                certificateContext.cbCertEncoded == 0 ||
                certificateContext.cbCertEncoded > 1024 * 1024)
            {
                throw new CryptographicException("WinVerifyTrust returned a malformed leaf certificate.");
            }
            int certificateLength = checked((int)certificateContext.cbCertEncoded);
            byte[] rawCertificate = new byte[certificateLength];
            Marshal.Copy(certificateContext.pbCertEncoded, rawCertificate, 0, rawCertificate.Length);
            return new X509Certificate2(rawCertificate);
        }
        finally
        {
            if (trustData.hWVTStateData != IntPtr.Zero)
            {
                trustData.dwStateAction = WTD_STATEACTION_CLOSE;
                WinVerifyTrust(new IntPtr(-1), ref action, ref trustData);
            }
            if (fileInfoPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(fileInfoPointer);
            }
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pathPointer);
            }
        }
    }
}`;
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
  "linux-x64": Object.freeze({
    architecture: "x64",
    artifactName: "cursor_3.13.10_amd64.deb",
    bytes: 209_277_476,
    format: "deb",
    platform: "linux",
    productCommit: PINNED_CURSOR_PRODUCT_COMMIT,
    sha256: "8a5b734be3bccc3de6daf96c536daa644c715e5fe3e5eaf21721538072ea104c",
    url: "https://downloads.cursor.com/production/4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7/linux/x64/deb/amd64/deb/cursor_3.13.10_amd64.deb",
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
      : platform === "linux" && architecture === "x64"
        ? "linux-x64"
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
  {
    afterHashReadForTest,
    afterTemporaryOpenForTest,
    openResponse = openPinnedCursorResponse,
    timeoutMs = DOWNLOAD_TIMEOUT_MS
  } = {}
) {
  const target = validatePinnedCursorTarget(rawTarget);
  assertPrivateDirectoryReceipt(rootReceipt);
  if (typeof openResponse !== "function") {
    throw new Error("Pinned Cursor acquisition requires an HTTPS response provider.");
  }
  if (afterTemporaryOpenForTest !== undefined && typeof afterTemporaryOpenForTest !== "function") {
    throw new Error("Pinned Cursor acquisition received a malformed descriptor-race test hook.");
  }
  if (afterHashReadForTest !== undefined && typeof afterHashReadForTest !== "function") {
    throw new Error("Pinned Cursor acquisition received a malformed hash-race test hook.");
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
    if (
      receipt.snapshot.size !== BigInt(target.bytes) ||
      (await hashReceipt(receipt, { afterReadForTest: afterHashReadForTest })) !== target.sha256
    ) {
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
      : target.platform === "linux"
        ? join(rootReceipt.path, "cursor")
        : join(rootReceipt.path, "Cursor.exe");
  const cli =
    target.platform === "darwin"
      ? join(appRoot, "bin", "cursor")
      : target.platform === "linux"
        ? join(rootReceipt.path, "bin", "cursor")
        : join(appRoot, "bin", "cursor.cmd");
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
      (target.platform === "linux" && target.architecture === "x64" && target.format === "deb") ||
      (target.platform === "win32" && target.architecture === "x64" && target.format === "inno")
    )
  ) {
    throw new Error("The pinned Cursor acquisition target is malformed.");
  }
  return target;
}

export async function extractPinnedCursorTarget(
  target,
  artifact,
  rootReceipt,
  {
    beforeArtifactSpawnForTest,
    environment = createEditorAcceptanceEnvironment(),
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (beforeArtifactSpawnForTest !== undefined && typeof beforeArtifactSpawnForTest !== "function") {
    throw new Error("Pinned Cursor extraction received a malformed launch-race test hook.");
  }
  if (typeof runCommand !== "function") {
    throw new Error("Pinned Cursor extraction requires a bounded command runner.");
  }
  await assertImmutableArtifactReceipt(target, artifact, rootReceipt);
  const installationRoot = join(rootReceipt.path, "installation");
  mkdirSync(installationRoot, { mode: 0o700 });
  privateDirectoryReceipt(installationRoot, rootReceipt.canonicalPath);
  if (target.platform === "darwin") {
    return extractDarwinTarget(target, artifact, rootReceipt, installationRoot, {
      beforeArtifactSpawnForTest,
      environment,
      runCommand
    });
  }
  if (target.platform === "linux") {
    return extractLinuxTarget(target, artifact, rootReceipt, installationRoot, {
      beforeArtifactSpawnForTest,
      environment,
      runCommand
    });
  }
  return extractWindowsTarget(target, artifact, rootReceipt, installationRoot, {
    beforeArtifactSpawnForTest,
    environment,
    runCommand
  });
}

async function extractLinuxTarget(
  target,
  artifact,
  rootReceipt,
  installationRoot,
  { beforeArtifactSpawnForTest, environment, runCommand }
) {
  await runCommand(
    {
      executable: "/usr/bin/dpkg-deb",
      args: ["--extract", artifact.path, installationRoot],
      beforeSpawnCheck: artifactPreSpawnCheck(
        target,
        artifact,
        rootReceipt,
        "Pinned Cursor Debian package extraction",
        beforeArtifactSpawnForTest
      ),
      environment,
      label: "Pinned Cursor Debian package extraction"
    },
    { timeoutMs: EXTRACTION_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
  );
  await assertImmutableArtifactReceipt(target, artifact, rootReceipt);
  const applicationRoot = join(installationRoot, "usr", "share", "cursor");
  const applicationMetadata = lstatSync(applicationRoot);
  if (!applicationMetadata.isDirectory() || applicationMetadata.isSymbolicLink()) {
    throw new Error("The pinned Cursor Debian package did not contain one regular application root.");
  }
  chmodSync(applicationRoot, 0o700);
  privateDirectoryReceipt(applicationRoot, rootReceipt.canonicalPath);
  return { installationRoot: applicationRoot };
}

async function extractDarwinTarget(
  target,
  artifact,
  rootReceipt,
  installationRoot,
  { beforeArtifactSpawnForTest, environment, runCommand }
) {
  const mountPoint = join(rootReceipt.path, "mount");
  mkdirSync(mountPoint, { mode: 0o700 });
  privateDirectoryReceipt(mountPoint, rootReceipt.canonicalPath);
  let attached = false;
  let primaryError;
  try {
    await runCommand(
      {
        executable: "/usr/bin/hdiutil",
        args: ["attach", artifact.path, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, "-quiet"],
        beforeSpawnCheck: artifactPreSpawnCheck(
          target,
          artifact,
          rootReceipt,
          "Pinned Cursor DMG attachment",
          beforeArtifactSpawnForTest
        ),
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
    await runCommand(
      {
        executable: "/usr/bin/ditto",
        args: ["--rsrc", "--extattr", sourceApp, join(installationRoot, "Cursor.app")],
        environment,
        label: "Pinned Cursor application extraction"
      },
      { timeoutMs: EXTRACTION_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
    );
    await runCommand(
      {
        executable: "/usr/bin/codesign",
        args: ["--verify", "--deep", "--strict", join(installationRoot, "Cursor.app")],
        environment,
        label: "Pinned Cursor code-signature verification"
      },
      { timeoutMs: 60_000, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
    );
    const signature = await runCommand(
      {
        executable: "/usr/bin/codesign",
        args: ["--display", "--verbose=4", join(installationRoot, "Cursor.app")],
        environment,
        label: "Pinned Cursor signing-team inspection"
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
      await runCommand(
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

async function extractWindowsTarget(
  target,
  artifact,
  rootReceipt,
  installationRoot,
  { beforeArtifactSpawnForTest, environment, runCommand }
) {
  const systemRoot = environment.SYSTEMROOT;
  if (!systemRoot) throw new Error("Pinned Cursor Windows acquisition requires the isolated system root.");
  const encodedArtifactPath = Buffer.from(artifact.path, "utf16le").toString("base64");
  const authenticodeScript = [
    "$ErrorActionPreference = 'Stop'",
    "$nativeSource = @'",
    CURSOR_WINDOWS_AUTHENTICODE_SOURCE,
    "'@",
    `$literalPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedArtifactPath}'))`,
    "try { $null = Add-Type -TypeDefinition $nativeSource -Language CSharp; $certificate = [OpenWranglerCursorAuthenticode]::VerifyAndGetSigner($literalPath) } catch { exit 42 }",
    "if ($null -eq $certificate) { exit 41 }",
    `$simpleName = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)`,
    "$sha256 = [System.Security.Cryptography.SHA256]::Create()",
    "try { $leafSha256 = [BitConverter]::ToString($sha256.ComputeHash($certificate.RawData)).Replace('-', '') } finally { $sha256.Dispose(); $certificate.Dispose() }",
    `if ($simpleName -cne '${CURSOR_WINDOWS_SIGNER_NAME}') { exit 43 }`,
    `if ($leafSha256 -cne '${CURSOR_WINDOWS_SIGNER_CERTIFICATE_SHA256}') { exit 44 }`
  ].join("\n");
  await runCommand(
    {
      executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(authenticodeScript, "utf16le").toString("base64")
      ],
      beforeSpawnCheck: artifactPreSpawnCheck(
        target,
        artifact,
        rootReceipt,
        "Pinned Cursor Authenticode verification",
        beforeArtifactSpawnForTest
      ),
      environment,
      label: "Pinned Cursor Authenticode verification"
    },
    { timeoutMs: WINDOWS_AUTHENTICODE_TIMEOUT_MS, maxOutputBytes: DOWNLOAD_OUTPUT_LIMIT_BYTES }
  );
  await runCommand(
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
      beforeSpawnCheck: artifactPreSpawnCheck(
        target,
        artifact,
        rootReceipt,
        "Pinned Cursor private installation",
        beforeArtifactSpawnForTest
      ),
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
      await runCommand(
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
  assertArtifactReceiptShape(target, artifact, rootReceipt);
  if ((await hashReceipt(artifact)) !== target.sha256) {
    throw new Error("The pinned Cursor artifact receipt changed before extraction.");
  }
}

function artifactPreSpawnCheck(target, artifact, rootReceipt, label, beforeArtifactSpawnForTest) {
  return () => {
    const hookResult = beforeArtifactSpawnForTest?.(Object.freeze({ label, path: artifact.path }));
    if (hookResult !== undefined) {
      throw new Error("Pinned Cursor extraction launch-race hooks must complete synchronously without a result.");
    }
    assertArtifactReceiptShape(target, artifact, rootReceipt);
    const current = lstatSync(artifact.path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      !sameSnapshot(fileSnapshot(current), artifact.snapshot) ||
      realpathSync(artifact.path) !== artifact.canonicalPath
    ) {
      throw new Error("The pinned Cursor artifact changed at a command launch boundary.");
    }
  };
}

function assertArtifactReceiptShape(target, artifact, rootReceipt) {
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

async function hashReceipt(receipt, { afterReadForTest } = {}) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(receipt.path, flags);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !sameSnapshot(fileSnapshot(opened), receipt.snapshot) ||
      !sameSnapshot(fileSnapshot(lstatSync(receipt.path, { bigint: true })), receipt.snapshot) ||
      realpathSync(receipt.path) !== receipt.canonicalPath
    ) {
      throw new Error("The pinned Cursor artifact changed before it could be hashed.");
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(undefined, { fd: descriptor, autoClose: false })) {
      digest.update(chunk);
    }
    afterReadForTest?.(Object.freeze({ descriptor, path: receipt.path }));
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !sameSnapshot(fileSnapshot(completed), receipt.snapshot) ||
      !sameSnapshot(fileSnapshot(lstatSync(receipt.path, { bigint: true })), receipt.snapshot) ||
      realpathSync(receipt.path) !== receipt.canonicalPath
    ) {
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
