import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";
import {
  assertEditorAcceptancePrivateRootReceipt,
  createEditorAcceptancePrivateRootReceipt
} from "./packaged-editor-orchestration.mjs";

const DEPENDENCIES = Object.freeze(["ipykernel", "pandas", "polars", "duckdb", "pyspark"]);
const BINARY_DEPENDENCIES = Object.freeze([
  "ipykernel",
  "pandas",
  "polars",
  "duckdb",
  "py4j",
  "pyarrow",
  "grpcio",
  "grpcio-status",
  "googleapis-common-protos",
  "protobuf",
  "zstandard"
]);
const RELEASED_JUPYTER_COMPATIBILITY_VERSIONS = Object.freeze({
  ipykernel: "6.30.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  duckdb: "1.5.4",
  pyspark: "4.2.0",
  py4j: "0.10.9.9",
  pyarrow: "25.0.0",
  grpcio: "1.83.0",
  "grpcio-status": "1.83.0",
  "googleapis-common-protos": "1.75.0",
  protobuf: "7.35.1",
  zstandard: "0.25.0"
});
const PYSPARK_SOURCE_REQUIREMENT =
  "pyspark @ https://files.pythonhosted.org/packages/c3/33/c987434f5d50aa802779a004ca0fd45ee4350caab50554ad7283d5a22b50/pyspark-4.2.0.tar.gz#sha256=5ad689d53570ee1674193fd4f9bda065f0db3be9363a27d2a3406cc457b70b61";
const BOUNDED_PYTHON_VERSION =
  /^(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:(?:\.post|\.dev)[0-9]+)*(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/iu;
const BOUNDED_JAVA_VERSION = /^[0-9][0-9A-Za-z._+-]{0,127}$/u;
const MINIMUM_PYSPARK_JAVA_MAJOR = 17;
const REMOTE_JUPYTER_DESCRIPTOR_PROTOCOL = "openwrangler-remote-jupyter-v1";
const REMOTE_JUPYTER_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REMOTE_JUPYTER_TOKEN = /^owr_[A-Za-z0-9_-]{39}$/u;
const REMOTE_JUPYTER_DESCRIPTOR_MAX_BYTES = 2_048;

export function createRemoteJupyterAcceptanceToken(randomBytesImpl = randomBytes) {
  if (typeof randomBytesImpl !== "function") {
    throw new TypeError("Remote Jupyter acceptance requires one cryptographic random source.");
  }
  const entropy = randomBytesImpl(30);
  if (!Buffer.isBuffer(entropy) || entropy.length !== 30) {
    throw new Error("Remote Jupyter acceptance did not receive its exact private-token entropy.");
  }
  const token = `owr_${entropy.toString("base64url").slice(0, 39)}`;
  if (!REMOTE_JUPYTER_TOKEN.test(token)) {
    throw new Error("Remote Jupyter acceptance could not create its bounded private token.");
  }
  return token;
}

export function acceptancePythonForPhase(phase, testPython, jupyterKernelPython) {
  if (
    phase === "jupyter-deny" ||
    phase === "jupyter-allow" ||
    phase === "jupyter-pyspark" ||
    phase === "jupyter-coexist-open-select" ||
    phase === "jupyter-coexist-open-restart" ||
    phase === "jupyter-coexist-data-select" ||
    phase === "jupyter-coexist-data-restart"
  ) {
    if (
      typeof jupyterKernelPython !== "string" ||
      !isAbsolute(jupyterKernelPython) ||
      /[\0\r\n]/u.test(jupyterKernelPython)
    ) {
      throw new Error("Released-Jupyter acceptance requires its dedicated private kernel interpreter.");
    }
    return jupyterKernelPython;
  }
  return testPython;
}

export async function createJupyterAcceptanceKernelPython(
  directory,
  basePython,
  {
    containedBy,
    environment = createEditorAcceptanceEnvironment(),
    platform = process.platform,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/u.test(directory) ||
    existsSync(directory) ||
    typeof containedBy !== "string" ||
    !isAbsolute(containedBy) ||
    /[\0\r\n]/u.test(containedBy) ||
    typeof basePython !== "string" ||
    !isAbsolute(basePython) ||
    /[\0\r\n]/u.test(basePython) ||
    !existsSync(basePython) ||
    typeof runCommand !== "function"
  ) {
    throw new Error(
      "Released-Jupyter acceptance requires a new contained private environment and an existing absolute base interpreter."
    );
  }

  const java = await probeJupyterAcceptanceJava({
    environment,
    runCommand
  });
  console.log(`Released-Jupyter PySpark Java preflight passed: Java ${java.version} (major ${java.major}).`);
  await probeJupyterAcceptancePython(basePython, {
    environment,
    requirePySpark: false,
    label: "Released-Jupyter base dependency version probe",
    requireRuntimeAbsent: false,
    runCommand
  });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const directoryReceipt = createEditorAcceptancePrivateRootReceipt(directory, { containedBy });
  const venvDirectory = resolve(directory, "v");
  await runCommand(
    {
      executable: basePython,
      args: ["-I", "-m", "venv", venvDirectory],
      environment,
      label: "Released-Jupyter private kernel environment creation"
    },
    { timeoutMs: 60_000 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  const kernelPython =
    platform === "win32" ? resolve(venvDirectory, "Scripts", "python.exe") : resolve(venvDirectory, "bin", "python");
  if (!existsSync(kernelPython)) {
    throw new Error("Released-Jupyter private kernel environment did not create its interpreter.");
  }
  await runCommand(
    {
      executable: kernelPython,
      args: [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-warn-script-location",
        "--no-cache-dir",
        "--only-binary=:all:",
        ...BINARY_DEPENDENCIES.map(
          (dependency) => `${dependency}==${RELEASED_JUPYTER_COMPATIBILITY_VERSIONS[dependency]}`
        )
      ],
      environment,
      label: "Released-Jupyter private kernel binary dependency installation"
    },
    { timeoutMs: 240_000 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  await runCommand(
    {
      executable: kernelPython,
      args: [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-warn-script-location",
        "--no-cache-dir",
        "--no-deps",
        PYSPARK_SOURCE_REQUIREMENT
      ],
      environment,
      label: "Released-Jupyter private kernel PySpark installation"
    },
    { timeoutMs: 240_000 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  const installedVersions = await probeJupyterAcceptancePython(kernelPython, {
    environment,
    label: "Released-Jupyter private kernel dependency probe",
    requireRuntimeAbsent: true,
    runCommand
  });
  for (const dependency of DEPENDENCIES) {
    if (installedVersions[dependency] !== RELEASED_JUPYTER_COMPATIBILITY_VERSIONS[dependency]) {
      throw new Error(`Released-Jupyter private kernel did not retain the ${dependency} compatibility version.`);
    }
  }
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  return kernelPython;
}

export async function probeJupyterAcceptanceJava({
  environment = createEditorAcceptanceEnvironment(),
  runCommand = runBoundedEditorCommand
} = {}) {
  let result;
  try {
    result = await runCommand(
      {
        executable: "java",
        args: ["-XshowSettings:properties", "-version"],
        environment,
        label: "Released-Jupyter PySpark Java compatibility probe"
      },
      { timeoutMs: 30_000 }
    );
  } catch {
    throw new Error(
      "Released-Jupyter PySpark acceptance requires Java 17 or newer, but the Java compatibility probe failed."
    );
  }
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const specificationVersion = singleJavaProperty(output, "java.specification.version");
  const version = singleJavaProperty(output, "java.version");
  if (!BOUNDED_JAVA_VERSION.test(version)) {
    throw new Error("Released-Jupyter PySpark Java compatibility probe returned an unsafe Java version.");
  }
  const major = javaSpecificationMajor(specificationVersion);
  if (major < MINIMUM_PYSPARK_JAVA_MAJOR) {
    throw new Error(
      `Released-Jupyter PySpark acceptance requires Java ${MINIMUM_PYSPARK_JAVA_MAJOR} or newer; ` +
        `detected Java ${version} (major ${major}).`
    );
  }
  return { major, version };
}

function singleJavaProperty(output, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [
    ...output.matchAll(
      new RegExp(`^[^\\S\\r\\n]*${escapedProperty}[^\\S\\r\\n]*=[^\\S\\r\\n]*(\\S+)[^\\S\\r\\n]*$`, "gmu")
    )
  ];
  if (matches.length !== 1 || typeof matches[0]?.[1] !== "string") {
    throw new Error(`Released-Jupyter PySpark Java compatibility probe did not report one ${property} property.`);
  }
  return matches[0][1];
}

function javaSpecificationMajor(specificationVersion) {
  if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(specificationVersion)) {
    throw new Error("Released-Jupyter PySpark Java compatibility probe returned an unsafe specification version.");
  }
  const parts = specificationVersion.split(".").map(Number);
  const major = parts[0] === 1 && parts.length === 2 ? parts[1] : parts[0];
  if (!Number.isSafeInteger(major) || major <= 0) {
    throw new Error("Released-Jupyter PySpark Java compatibility probe returned an invalid specification version.");
  }
  return major;
}

export function writeJupyterAcceptanceEnvironment(directory, python) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/u.test(directory) ||
    typeof python !== "string" ||
    !isAbsolute(python) ||
    /[\0\r\n]/u.test(python) ||
    !existsSync(python)
  ) {
    throw new Error("Released-Jupyter acceptance requires absolute private directories and an existing interpreter.");
  }
  const dataDir = resolve(directory, "d");
  const runtimeDir = resolve(directory, "r");
  const configDir = resolve(directory, "c");
  const pathDir = resolve(directory, "p");
  const ipythonDir = resolve(directory, "i");
  const kernelDirectory = resolve(dataDir, "kernels", "openwrangler-acceptance");
  for (const path of [dataDir, runtimeDir, configDir, pathDir, ipythonDir, kernelDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    resolve(kernelDirectory, "kernel.json"),
    `${JSON.stringify(
      {
        argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name: "Python 3.12 (Open Wrangler)",
        language: "python",
        metadata: { debugger: false },
        env: { IPYTHONDIR: ipythonDir }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  return { dataDir, runtimeDir, configDir, path: pathDir };
}

export function writeRemoteJupyterAcceptanceEnvironment(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory) || /[\0\r\n]/u.test(directory)) {
    throw new Error("Remote Jupyter acceptance requires one absolute private environment directory.");
  }
  const dataDir = resolve(directory, "d");
  const runtimeDir = resolve(directory, "r");
  const configDir = resolve(directory, "c");
  const pathDir = resolve(directory, "p");
  for (const path of [dataDir, runtimeDir, configDir, pathDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return { dataDir, runtimeDir, configDir, path: pathDir };
}

export function writeRemoteJupyterAcceptanceDescriptor(
  directory,
  { baseUrl, token, runId, hostname },
  { containedBy, platform = process.platform } = {}
) {
  if (platform !== "linux") {
    throw new Error("Remote Jupyter acceptance descriptors are supported only on Linux.");
  }
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/u.test(directory) ||
    typeof containedBy !== "string" ||
    !isAbsolute(containedBy) ||
    /[\0\r\n]/u.test(containedBy)
  ) {
    throw new Error("Remote Jupyter acceptance requires one contained absolute descriptor directory.");
  }
  const directoryReceipt = createEditorAcceptancePrivateRootReceipt(directory, { containedBy });
  if (!REMOTE_JUPYTER_RUN_ID.test(runId ?? "")) {
    throw new Error("Remote Jupyter acceptance requires one correlated UUID run ID.");
  }
  const expectedHostname = `owr-${runId.replaceAll("-", "").slice(0, 12).toLowerCase()}`;
  if (hostname !== expectedHostname) {
    throw new Error("Remote Jupyter acceptance requires its run-derived container hostname.");
  }
  if (!REMOTE_JUPYTER_TOKEN.test(token ?? "")) {
    throw new Error("Remote Jupyter acceptance requires one bounded opaque private token.");
  }
  const canonicalBaseUrl = validateRemoteJupyterBaseUrl(baseUrl);
  const contents = Buffer.from(
    `${JSON.stringify({
      protocol: REMOTE_JUPYTER_DESCRIPTOR_PROTOCOL,
      baseUrl: canonicalBaseUrl,
      token,
      runId,
      hostname
    })}\n`,
    "utf8"
  );
  if (contents.length === 0 || contents.length > REMOTE_JUPYTER_DESCRIPTOR_MAX_BYTES) {
    throw new Error("Remote Jupyter acceptance descriptor exceeds its fixed byte bound.");
  }

  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  const descriptorPath = resolve(directory, "remote-jupyter.json");
  let descriptor;
  try {
    descriptor = openSync(
      descriptorPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o400
    );
    const opened = fstatSync(descriptor, { bigint: true });
    assertRemoteJupyterDescriptorIdentity(opened, 0n);
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(descriptor, contents, offset, contents.length - offset, offset);
      if (written <= 0) throw new Error("Remote Jupyter acceptance descriptor write made no progress.");
      offset += written;
    }
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    assertSameRemoteJupyterDescriptor(opened, completed);
    assertRemoteJupyterDescriptorIdentity(completed, BigInt(contents.length));
    closeSync(descriptor);
    descriptor = undefined;

    const atPath = lstatSync(descriptorPath, { bigint: true });
    assertSameRemoteJupyterDescriptor(completed, atPath);
    assertRemoteJupyterDescriptorIdentity(atPath, BigInt(contents.length));
    if (realpathSync(descriptorPath) !== descriptorPath) {
      throw new Error("Remote Jupyter acceptance descriptor did not retain its exact path.");
    }
    assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
    return descriptorPath;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateRemoteJupyterBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 64 || /[\0\r\n]/u.test(baseUrl)) {
    throw new Error("Remote Jupyter acceptance requires one bounded loopback origin.");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Remote Jupyter acceptance requires one bounded loopback origin.");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !/^(?:[1-9][0-9]{0,4})$/u.test(parsed.port) ||
    Number(parsed.port) > 65_535 ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== baseUrl
  ) {
    throw new Error("Remote Jupyter acceptance requires one canonical IPv4-loopback HTTP origin.");
  }
  return baseUrl;
}

function assertRemoteJupyterDescriptorIdentity(metadata, expectedSize) {
  const currentUser = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size !== expectedSize ||
    (metadata.mode & 0o777n) !== 0o400n ||
    (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new Error("Remote Jupyter acceptance descriptor lost its owned mode-0400 file identity.");
  }
}

function assertSameRemoteJupyterDescriptor(expected, actual) {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mode !== expected.mode ||
    actual.nlink !== expected.nlink ||
    actual.uid !== expected.uid ||
    actual.gid !== expected.gid
  ) {
    throw new Error("Remote Jupyter acceptance descriptor identity changed.");
  }
}

export async function probeJupyterAcceptancePython(
  python,
  {
    environment = createEditorAcceptanceEnvironment(),
    label = "Released-Jupyter Python dependency probe",
    requirePySpark = true,
    requireRuntimeAbsent = true,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (typeof requirePySpark !== "boolean" || typeof requireRuntimeAbsent !== "boolean") {
    throw new Error(
      "Released-Jupyter Python dependency probing requires explicit PySpark and runtime-absence policies."
    );
  }
  const dependencies = requirePySpark ? DEPENDENCIES : DEPENDENCIES.filter((dependency) => dependency !== "pyspark");
  const probe = [
    "import importlib.metadata",
    "import importlib.util",
    "import json",
    "import ipykernel",
    "import pandas",
    "import polars",
    "import duckdb",
    ...(requirePySpark ? ["import pyspark"] : []),
    "print(json.dumps({",
    '  "ipykernel": importlib.metadata.version("ipykernel"),',
    '  "pandas": importlib.metadata.version("pandas"),',
    '  "polars": importlib.metadata.version("polars"),',
    '  "duckdb": importlib.metadata.version("duckdb"),',
    ...(requirePySpark ? ['  "pyspark": importlib.metadata.version("pyspark"),'] : []),
    '  "openwranglerRuntimePresent": importlib.util.find_spec("openwrangler_runtime") is not None,',
    "}, sort_keys=True))"
  ].join("\n");
  const { stdout } = await runCommand(
    {
      executable: python,
      args: ["-I", "-c", probe],
      environment,
      label
    },
    { timeoutMs: 30_000 }
  );
  let versions;
  try {
    versions = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Released-Jupyter Python dependency probe did not return its bounded JSON version report.");
  }
  for (const dependency of dependencies) {
    const version = versions?.[dependency];
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      version.length > 128 ||
      !BOUNDED_PYTHON_VERSION.test(version)
    ) {
      throw new Error(`Released-Jupyter Python dependency probe did not report a safe ${dependency} version.`);
    }
  }
  if (typeof versions?.openwranglerRuntimePresent !== "boolean") {
    throw new Error("Released-Jupyter Python dependency probe did not report runtime visibility.");
  }
  if (requireRuntimeAbsent && versions.openwranglerRuntimePresent) {
    throw new Error("Released-Jupyter private kernel environment exposes openwrangler_runtime.");
  }
  return versions;
}
