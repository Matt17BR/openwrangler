import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { readBoundedRegularFile } from "./bounded-file-read.mjs";
import { LINUX_PSS_OWNERSHIP_PROTOCOL } from "./linux-pss-sampler.mjs";

const PRODUCT_KEYS = Object.freeze(["open-wrangler", "data-wrangler"]);
const PROCESS_CATEGORIES = Object.freeze([
  "editor-main",
  "renderer-gpu",
  "extension-host",
  "configured-kernel",
  "open-wrangler-runtime",
  "other-owned-child"
]);
const LAUNCH_RECEIPT_KEYS = Object.freeze([
  "protocol",
  "kind",
  "nonce",
  "supervisor",
  "editorRoot",
  "supervisorSource",
  "pythonExecutable",
  "invocationPolicySha256",
  "invocationSha256",
  "payloadArgvSha256",
  "payloadEnvironmentSha256"
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/u;
const NON_NEGATIVE_INTEGER_TEXT = /^(?:0|[1-9]\d*)$/u;
const KERNEL_NAME = /^dataframe-comparison-study-[a-z0-9][a-z0-9._-]{0,95}$/u;
const CONNECTION_FILE_TOKEN = /^kernel-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXTENSION_HOST_ENTRYPOINT = Buffer.from(
  "VSCODE_AMD_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess",
  "utf8"
);
const MAXIMUM_PYTHON_BYTES = 32 * 1024 * 1024;
const MAXIMUM_EDITOR_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_STAT_BYTES = 4 * 1024;
const MAXIMUM_CMDLINE_BYTES = 64 * 1024;
const MAXIMUM_ENVIRON_BYTES = 256 * 1024;
const MAXIMUM_ARGUMENTS = 128;
const MAXIMUM_ARGUMENT_BYTES = 8 * 1024;
const MAXIMUM_ENVIRONMENT_ENTRIES = 512;
const MAXIMUM_ENVIRONMENT_NAME_BYTES = 256;
const MAXIMUM_PROC_LINK_BYTES = 4 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} is malformed.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is malformed.`);
}

function validateFilesystemIdentity(value, label) {
  exactKeys(value, ["device", "inode", "sizeBytes", "mtimeNs"], label);
  if (
    !NON_NEGATIVE_INTEGER_TEXT.test(value.device) ||
    !NON_NEGATIVE_INTEGER_TEXT.test(value.inode) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    !NON_NEGATIVE_INTEGER_TEXT.test(value.mtimeNs)
  ) {
    fail(`${label} is malformed.`);
  }
}

function validateFileReceipt(value, label) {
  exactKeys(value, ["sha256", "filesystemIdentity"], label);
  if (!SHA256.test(value.sha256)) fail(`${label} is malformed.`);
  validateFilesystemIdentity(value.filesystemIdentity, `${label} filesystem identity`);
}

function validateLaunchReceipt(receipt) {
  exactKeys(receipt, LAUNCH_RECEIPT_KEYS, "Linux study supervisor launch receipt");
  if (receipt.protocol !== LINUX_PSS_OWNERSHIP_PROTOCOL || receipt.kind !== "launch" || !SHA256.test(receipt.nonce)) {
    fail("Linux study supervisor launch receipt is not an exact launch receipt.");
  }
  exactKeys(
    receipt.supervisor,
    ["pid", "startTimeTicks", "subreaperVerified", "pidfdVerified"],
    "Linux study supervisor identity"
  );
  assertPositiveInteger(receipt.supervisor.pid, "Linux study supervisor PID");
  if (
    !NON_NEGATIVE_INTEGER_TEXT.test(receipt.supervisor.startTimeTicks) ||
    receipt.supervisor.subreaperVerified !== true ||
    receipt.supervisor.pidfdVerified !== true
  ) {
    fail("Linux study supervisor identity is malformed.");
  }
  exactKeys(
    receipt.editorRoot,
    ["pid", "startTimeTicks", "processGroupId", "sessionId"],
    "Linux study editor-root identity"
  );
  assertPositiveInteger(receipt.editorRoot.pid, "Linux study editor-root PID");
  if (
    !NON_NEGATIVE_INTEGER_TEXT.test(receipt.editorRoot.startTimeTicks) ||
    receipt.editorRoot.pid === receipt.supervisor.pid ||
    receipt.editorRoot.processGroupId !== receipt.editorRoot.pid ||
    receipt.editorRoot.sessionId !== receipt.editorRoot.pid
  ) {
    fail("Linux study editor-root identity is malformed.");
  }
  validateFileReceipt(receipt.supervisorSource, "Linux study supervisor source");
  exactKeys(
    receipt.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "Linux study Python executable"
  );
  if (
    receipt.pythonExecutable.implementation !== "CPython" ||
    !/^3\.12(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(receipt.pythonExecutable.version) ||
    !SHA256.test(receipt.pythonExecutable.sha256)
  ) {
    fail("Linux study Python executable receipt is malformed.");
  }
  validateFilesystemIdentity(
    receipt.pythonExecutable.filesystemIdentity,
    "Linux study Python executable filesystem identity"
  );
  for (const value of [
    receipt.invocationPolicySha256,
    receipt.invocationSha256,
    receipt.payloadArgvSha256,
    receipt.payloadEnvironmentSha256
  ]) {
    if (!SHA256.test(value)) fail("Linux study launch binding is malformed.");
  }
}

function filesystemIdentity(metadata) {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString()
  };
}

function sameFileMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFilesystemIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes &&
    left.mtimeNs === right.mtimeNs
  );
}

function pinPythonExecutable(path, expectedSha256, receipt, dependencies) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || !SHA256.test(expectedSha256)) {
    fail("The study Python executable input is malformed.");
  }
  let canonical;
  try {
    canonical = dependencies.realpath(path);
  } catch {
    fail("The study Python executable could not be resolved.");
  }
  if (canonical !== path) fail("The study Python executable path is not canonical.");

  let metadata;
  let bytes;
  try {
    metadata = dependencies.lstat(path, { bigint: true });
    bytes = dependencies.readPython(path, MAXIMUM_PYTHON_BYTES, {
      label: "Study Python executable"
    });
  } catch {
    fail("The study Python executable could not be pinned.");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(MAXIMUM_PYTHON_BYTES) ||
    (metadata.mode & 0o111n) === 0n
  ) {
    fail("The study Python executable is not one bounded executable file.");
  }
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  const observedIdentity = filesystemIdentity(metadata);
  if (
    observedSha256 !== expectedSha256 ||
    receipt.pythonExecutable.sha256 !== expectedSha256 ||
    !sameFilesystemIdentity(observedIdentity, receipt.pythonExecutable.filesystemIdentity)
  ) {
    fail("The study Python executable does not match the supervisor launch receipt.");
  }
  return canonical;
}

function pinRunningEditorExecutable(procExecutablePath, expectedPath, expectedSha256, dependencies) {
  if (
    typeof expectedPath !== "string" ||
    !isAbsolute(expectedPath) ||
    resolve(expectedPath) !== expectedPath ||
    !SHA256.test(expectedSha256)
  ) {
    fail("The study editor executable input is malformed.");
  }
  const expectedCanonical = dependencies.realpath(expectedPath);
  if (expectedCanonical !== expectedPath) fail("The study editor executable path is not canonical.");
  const linkBefore = readBoundedProcLink(procExecutablePath, dependencies.readProcLink);
  let descriptor;
  try {
    descriptor = openSync(procExecutablePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.size <= 0n ||
      opened.size > BigInt(MAXIMUM_EDITOR_EXECUTABLE_BYTES) ||
      (opened.mode & 0o111n) === 0n
    ) {
      fail("The running study editor executable is not one bounded executable file.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Number(opened.size)));
    let position = 0;
    while (position < Number(opened.size)) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(opened.size) - position), position);
      if (!Number.isSafeInteger(count) || count <= 0) fail("The running study editor executable ended early.");
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (readSync(descriptor, buffer, 0, 1, position) !== 0) {
      fail("The running study editor executable exceeded its pinned size.");
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const linkAfter = readBoundedProcLink(procExecutablePath, dependencies.readProcLink);
    if (
      !sameFileMetadata(opened, completed) ||
      linkBefore !== linkAfter ||
      linkAfter !== expectedCanonical ||
      hash.digest("hex") !== expectedSha256
    ) {
      fail("The running study editor does not match the spawn-bound executable receipt.");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateKernelBinding(kernel) {
  exactKeys(kernel, ["name", "displayName"], "Study kernel binding");
  if (
    !KERNEL_NAME.test(kernel.name) ||
    typeof kernel.displayName !== "string" ||
    kernel.displayName.length === 0 ||
    kernel.displayName.length > 128 ||
    /[\0\r\n/\\]/u.test(kernel.displayName) ||
    !/CPython 3\.12/iu.test(kernel.displayName)
  ) {
    fail("Study kernel binding is malformed.");
  }
  return Object.freeze({ name: kernel.name, displayName: kernel.displayName });
}

function readBoundedProcBytes(path, maximumBytes) {
  let descriptor;
  let operationError;
  let result;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0));
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(8 * 1024, maximumBytes + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!Number.isSafeInteger(count) || count < 0) fail("A Linux process evidence read failed.");
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) fail("A Linux process evidence file exceeds its fixed bound.");
      chunks.push(chunk.subarray(0, count));
    }
    result = Buffer.concat(chunks, total);
  } catch (error) {
    operationError = error;
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined || closeError !== undefined) {
    if (operationError !== undefined && closeError === undefined) throw operationError;
    throw new AggregateError(
      [operationError, closeError].filter(Boolean),
      "A Linux process evidence file did not close cleanly."
    );
  }
  return result;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8.`);
  }
}

function parseProcessStat(bytes, expectedPid) {
  const text = decodeUtf8(bytes, "Linux process identity");
  const close = text.lastIndexOf(")");
  if (!text.startsWith(`${expectedPid} (`) || close <= 0) {
    fail("Linux process identity is malformed.");
  }
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const parentPid = fields[1];
  const processGroupId = fields[2];
  const sessionId = fields[3];
  const startTimeTicks = fields[19];
  if (
    !/^\S$/u.test(fields[0] ?? "") ||
    !NON_NEGATIVE_INTEGER_TEXT.test(parentPid ?? "") ||
    !POSITIVE_INTEGER_TEXT.test(processGroupId ?? "") ||
    !POSITIVE_INTEGER_TEXT.test(sessionId ?? "") ||
    !NON_NEGATIVE_INTEGER_TEXT.test(startTimeTicks ?? "")
  ) {
    fail("Linux process identity is malformed.");
  }
  const numericFields = [parentPid, processGroupId, sessionId].map(Number);
  if (numericFields.some((value) => !Number.isSafeInteger(value))) {
    fail("Linux process identity exceeds its numeric bound.");
  }
  return Object.freeze({
    pid: expectedPid,
    parentPid: numericFields[0],
    processGroupId: numericFields[1],
    sessionId: numericFields[2],
    startTimeTicks
  });
}

function sameProcessIdentity(left, right) {
  return (
    left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.processGroupId === right.processGroupId &&
    left.sessionId === right.sessionId &&
    left.startTimeTicks === right.startTimeTicks
  );
}

function parseNullTerminatedUtf8(bytes, label) {
  if (bytes.length === 0 || bytes.at(-1) !== 0) fail(`${label} is malformed.`);
  const fields = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    const field = bytes.subarray(start, index);
    if (field.length === 0 || field.length > MAXIMUM_ARGUMENT_BYTES) fail(`${label} is malformed.`);
    fields.push(decodeUtf8(field, label));
    if (fields.length > MAXIMUM_ARGUMENTS) fail(`${label} exceeds its fixed argument bound.`);
    start = index + 1;
  }
  return fields;
}

function hasExactExtensionHostEntrypoint(bytes) {
  if (bytes.length === 0 || bytes.at(-1) !== 0) fail("Linux process environment is malformed.");
  let entries = 0;
  let entrypointEntries = 0;
  let matches = 0;
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    const entry = bytes.subarray(start, index);
    if (entry.length === 0) fail("Linux process environment is malformed.");
    const equals = entry.indexOf(0x3d);
    if (equals <= 0 || equals > MAXIMUM_ENVIRONMENT_NAME_BYTES) {
      fail("Linux process environment is malformed.");
    }
    const name = decodeUtf8(entry.subarray(0, equals), "Linux process environment name");
    if (!ENVIRONMENT_NAME.test(name)) fail("Linux process environment is malformed.");
    entries += 1;
    if (entries > MAXIMUM_ENVIRONMENT_ENTRIES) {
      fail("Linux process environment exceeds its fixed entry bound.");
    }
    if (name === "VSCODE_AMD_ENTRYPOINT") entrypointEntries += 1;
    if (entry.equals(EXTENSION_HOST_ENTRYPOINT)) matches += 1;
    start = index + 1;
  }
  if (entrypointEntries > 1) fail("Linux process environment contains an ambiguous extension-host marker.");
  return matches === 1;
}

function readBoundedProcLink(path, readlink) {
  let value;
  try {
    value = readlink(path, "utf8");
  } catch {
    fail("Linux process executable evidence could not be read.");
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_PROC_LINK_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    fail("Linux process executable evidence is malformed or exceeds its bound.");
  }
  return value;
}

function kernelConnectionPath(arguments_) {
  const allowedPrefixes = [[], ["-I"], ["-Xfrozen_modules=off"], ["-I", "-Xfrozen_modules=off"]];
  for (const prefix of allowedPrefixes) {
    if (!prefix.every((value, index) => arguments_[index + 1] === value)) continue;
    const tail = arguments_.slice(prefix.length + 1);
    if (tail[0] !== "-m" || tail[1] !== "ipykernel_launcher") continue;
    if (tail.length === 4 && ["-f", "--f"].includes(tail[2])) return tail[3];
    if (tail.length === 3 && /^(?:--?f)=.+/u.test(tail[2])) return tail[2].slice(tail[2].indexOf("=") + 1);
    fail("The configured-kernel command is malformed.");
  }
  if (arguments_.some((value, index) => value === "-m" && arguments_[index + 1] === "ipykernel_launcher")) {
    fail("The configured-kernel command is malformed.");
  }
  return null;
}

function canonicalKernelId(connectionPath) {
  if (typeof connectionPath !== "string" || !isAbsolute(connectionPath) || resolve(connectionPath) !== connectionPath) {
    fail("The configured-kernel connection file is not canonical.");
  }
  const token = basename(connectionPath);
  const match = CONNECTION_FILE_TOKEN.exec(token);
  if (match === null) fail("The configured-kernel connection token is malformed.");
  return Object.freeze({
    tokenSha256: createHash("sha256").update(token, "utf8").digest("hex"),
    kernelIdSha256: createHash("sha256").update(match[1], "utf8").digest("hex")
  });
}

function classifyArguments({ arguments_, executable, pinnedPython, product, extensionHost }) {
  const renderer = arguments_.includes("--type=renderer");
  const gpu = arguments_.includes("--type=gpu-process");
  if (renderer || gpu) return Object.freeze({ category: "renderer-gpu", kernel: null });

  const connectionPath = kernelConnectionPath(arguments_);
  const runtimeShape =
    arguments_.length === 4 &&
    arguments_[1] === "-s" &&
    arguments_[2] === "-m" &&
    arguments_[3] === "openwrangler_runtime.server";
  if (connectionPath !== null || runtimeShape) {
    if (executable !== pinnedPython || arguments_[0] !== pinnedPython) {
      fail("A measured Python process did not use the manifest-pinned executable.");
    }
  }
  if (connectionPath !== null) {
    return Object.freeze({ category: "configured-kernel", kernel: canonicalKernelId(connectionPath) });
  }
  if (runtimeShape) {
    if (product !== "open-wrangler") fail("A Data Wrangler trial launched an Open Wrangler runtime.");
    return Object.freeze({ category: "open-wrangler-runtime", kernel: null });
  }
  if (extensionHost) return Object.freeze({ category: "extension-host", kernel: null });
  return Object.freeze({ category: "other-owned-child", kernel: null });
}

function sameSelectedKernel(left, right) {
  return left.name === right.name && left.displayName === right.displayName;
}

function frozenProofs(editorRoot, configuredKernel, runtime, product, executableSha256) {
  return Object.freeze({
    editorRoot: Object.freeze({
      pid: editorRoot.pid,
      startTimeTicks: editorRoot.startTimeTicks,
      capturedAtLaunch: true
    }),
    configuredKernel:
      configuredKernel === null
        ? null
        : Object.freeze({
            pid: configuredKernel.pid,
            startTimeTicks: configuredKernel.startTimeTicks,
            executableSha256,
            kernelIdSha256: configuredKernel.kernelIdSha256,
            observedBeforeAction: true
          }),
    openWranglerRuntime: Object.freeze(
      configuredKernel === null
        ? null
        : product === "data-wrangler"
          ? { status: "not-applicable", pid: null, startTimeTicks: null }
          : runtime === null
            ? { status: "live-kernel-absence-proven", pid: null, startTimeTicks: null }
            : { status: "observed", pid: runtime.pid, startTimeTicks: runtime.startTimeTicks }
    )
  });
}

export function createDataWranglerComparisonProcessEvidence({
  launchReceipt,
  editorExecutablePath,
  editorExecutableSha256,
  pythonExecutablePath,
  pythonExecutableSha256,
  product,
  expectedKernel,
  expectedConnectionFileToken,
  procRoot = "/proc",
  readProcFile = readBoundedProcBytes,
  readProcLink = readlinkSync,
  realpath = realpathSync,
  lstat = lstatSync,
  readPython = readBoundedRegularFile
}) {
  validateLaunchReceipt(launchReceipt);
  if (!PRODUCT_KEYS.includes(product)) fail("Study process evidence product is invalid.");
  if (
    typeof procRoot !== "string" ||
    !isAbsolute(procRoot) ||
    resolve(procRoot) !== procRoot ||
    typeof readProcFile !== "function" ||
    typeof readProcLink !== "function" ||
    typeof realpath !== "function" ||
    typeof lstat !== "function" ||
    typeof readPython !== "function"
  ) {
    fail("Study process evidence dependencies are malformed.");
  }
  if (
    expectedConnectionFileToken !== undefined &&
    (typeof expectedConnectionFileToken !== "string" ||
      CONNECTION_FILE_TOKEN.exec(expectedConnectionFileToken) === null)
  ) {
    fail("Expected configured-kernel connection token is malformed.");
  }
  const expectedConnectionFileTokenSha256 =
    expectedConnectionFileToken === undefined
      ? undefined
      : createHash("sha256").update(expectedConnectionFileToken, "utf8").digest("hex");
  const kernelBinding = validateKernelBinding(expectedKernel);
  if ((editorExecutablePath === undefined) !== (editorExecutableSha256 === undefined)) {
    fail("Study editor executable evidence requires both its path and SHA-256.");
  }
  const pinnedPython = pinPythonExecutable(pythonExecutablePath, pythonExecutableSha256, launchReceipt, {
    realpath,
    lstat,
    readPython
  });
  const procPrefix = procRoot.replace(/\/$/u, "");
  const identities = new Map();
  let rootObserved = false;
  let configuredKernel = null;
  let runtime = null;

  const classify = ({ pid, startTimeTicks, rootPid, rootStartTimeTicks }) => {
    assertPositiveInteger(pid, "Owned process PID");
    if (
      !NON_NEGATIVE_INTEGER_TEXT.test(startTimeTicks) ||
      rootPid !== launchReceipt.editorRoot.pid ||
      rootStartTimeTicks !== launchReceipt.editorRoot.startTimeTicks
    ) {
      fail("Owned process classification is not bound to the supervisor launch receipt.");
    }
    const retained = identities.get(pid);
    if (retained !== undefined && retained.startTimeTicks !== startTimeTicks) {
      fail("An owned PID was reused during process classification.");
    }

    const processRoot = `${procPrefix}/${pid}`;
    const before = parseProcessStat(readProcFile(`${processRoot}/stat`, MAXIMUM_STAT_BYTES), pid);
    if (before.startTimeTicks !== startTimeTicks) fail("Owned process identity changed before classification.");
    const executableBefore = readBoundedProcLink(`${processRoot}/exe`, readProcLink);
    const commandBefore = readProcFile(`${processRoot}/cmdline`, MAXIMUM_CMDLINE_BYTES);
    const arguments_ = parseNullTerminatedUtf8(commandBefore, "Linux process command line");
    const isRoot = pid === launchReceipt.editorRoot.pid && startTimeTicks === launchReceipt.editorRoot.startTimeTicks;
    let environmentBefore = null;
    let extensionHost = false;
    if (!isRoot && !arguments_.includes("--type=renderer") && !arguments_.includes("--type=gpu-process")) {
      environmentBefore = readProcFile(`${processRoot}/environ`, MAXIMUM_ENVIRON_BYTES);
      extensionHost = hasExactExtensionHostEntrypoint(environmentBefore);
    }

    const executableAfter = readBoundedProcLink(`${processRoot}/exe`, readProcLink);
    const commandAfter = readProcFile(`${processRoot}/cmdline`, MAXIMUM_CMDLINE_BYTES);
    const environmentAfter =
      environmentBefore === null ? null : readProcFile(`${processRoot}/environ`, MAXIMUM_ENVIRON_BYTES);
    const after = parseProcessStat(readProcFile(`${processRoot}/stat`, MAXIMUM_STAT_BYTES), pid);
    if (
      !sameProcessIdentity(before, after) ||
      executableBefore !== executableAfter ||
      !commandBefore.equals(commandAfter) ||
      (environmentBefore !== null && !environmentBefore.equals(environmentAfter))
    ) {
      fail("Owned process evidence changed while it was classified.");
    }

    let classification;
    if (isRoot) {
      if (
        before.parentPid !== launchReceipt.supervisor.pid ||
        before.processGroupId !== launchReceipt.editorRoot.processGroupId ||
        before.sessionId !== launchReceipt.editorRoot.sessionId
      ) {
        fail("The editor root no longer matches the supervisor launch receipt.");
      }
      // Hash the executable once, during the mandatory launch classification.
      // Rehashing it on every PSS sample would change the benchmark we are
      // trying to observe.
      if (editorExecutablePath !== undefined && !rootObserved) {
        pinRunningEditorExecutable(`${processRoot}/exe`, editorExecutablePath, editorExecutableSha256, {
          readProcLink,
          realpath
        });
      }
      classification = Object.freeze({ category: "editor-main", kernel: null });
      rootObserved = true;
    } else {
      classification = classifyArguments({
        arguments_,
        executable: executableBefore,
        pinnedPython,
        product,
        extensionHost
      });
    }
    if (!PROCESS_CATEGORIES.includes(classification.category)) {
      fail("Owned process category is invalid.");
    }
    const evidenceSha256 = createHash("sha256")
      .update(executableBefore, "utf8")
      .update("\0", "utf8")
      .update(commandBefore)
      .update("\0", "utf8")
      .update(extensionHost ? "extension-host" : "not-extension-host", "utf8")
      .digest("hex");
    if (
      retained !== undefined &&
      (retained.category !== classification.category || retained.evidenceSha256 !== evidenceSha256)
    ) {
      fail("An owned process changed classification evidence during the trial.");
    }

    if (classification.category === "configured-kernel") {
      if (
        expectedConnectionFileTokenSha256 !== undefined &&
        classification.kernel.tokenSha256 !== expectedConnectionFileTokenSha256
      ) {
        fail("The configured-kernel connection token does not match the trial binding.");
      }
      if (
        configuredKernel !== null &&
        (configuredKernel.pid !== pid || configuredKernel.startTimeTicks !== startTimeTicks)
      ) {
        fail("More than one configured kernel was observed in the owned process tree.");
      }
      configuredKernel = Object.freeze({
        pid,
        startTimeTicks,
        kernelIdSha256: classification.kernel.kernelIdSha256
      });
    }
    if (classification.category === "open-wrangler-runtime") {
      if (runtime !== null && (runtime.pid !== pid || runtime.startTimeTicks !== startTimeTicks)) {
        fail("More than one Open Wrangler runtime was observed in the owned process tree.");
      }
      runtime = Object.freeze({ pid, startTimeTicks });
    }
    identities.set(pid, Object.freeze({ startTimeTicks, category: classification.category, evidenceSha256 }));
    return classification.category;
  };

  const snapshotProcessProofs = ({ selectedKernel } = {}) => {
    const selected = validateKernelBinding(selectedKernel);
    if (!sameSelectedKernel(selected, kernelBinding)) {
      fail("The configured-kernel process proof does not match the notebook-selected kernel.");
    }
    if (!rootObserved) fail("The editor root was not observed before the measured action.");
    if (configuredKernel === null) fail("The configured kernel was not observed before the measured action.");
    return frozenProofs(launchReceipt.editorRoot, configuredKernel, runtime, product, pythonExecutableSha256);
  };

  // Pin the editor root immediately. A failure can happen before the notebook
  // starts its kernel, but a launched trial still needs proof of which editor
  // process owned the isolated tree.
  classify({
    pid: launchReceipt.editorRoot.pid,
    startTimeTicks: launchReceipt.editorRoot.startTimeTicks,
    rootPid: launchReceipt.editorRoot.pid,
    rootStartTimeTicks: launchReceipt.editorRoot.startTimeTicks
  });

  const snapshotLaunchProcessProofs = () => {
    if (!rootObserved) fail("The editor root was not observed at launch.");
    return frozenProofs(launchReceipt.editorRoot, null, null, product, pythonExecutableSha256);
  };

  const snapshotPreActionProcessProofs = ({ selectedKernel } = {}) => {
    const selected = validateKernelBinding(selectedKernel);
    if (!sameSelectedKernel(selected, kernelBinding)) {
      fail("The pre-action process proof does not match the notebook-selected kernel.");
    }
    if (!rootObserved) fail("The editor root was not observed at launch.");
    return frozenProofs(launchReceipt.editorRoot, configuredKernel, runtime, product, pythonExecutableSha256);
  };

  return Object.freeze({
    classify,
    snapshotLaunchProcessProofs,
    snapshotPreActionProcessProofs,
    snapshotProcessProofs
  });
}
