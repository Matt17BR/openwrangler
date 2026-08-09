import { randomBytes } from "node:crypto";
import {
  accessSync,
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
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
const R_ACCEPTANCE_PRIMARY_SNAPSHOT = "2026-03-10";
const R_ACCEPTANCE_SUPPLEMENTAL_SNAPSHOT = "2026-06-01";
export const R_ACCEPTANCE_REPOSITORY = `https://p3m.dev/cran/__linux__/noble/${R_ACCEPTANCE_PRIMARY_SNAPSHOT}`;
export const R_ACCEPTANCE_SUPPLEMENTAL_REPOSITORY = `https://p3m.dev/cran/__linux__/noble/${R_ACCEPTANCE_SUPPLEMENTAL_SNAPSHOT}`;
export const R_ACCEPTANCE_PACKAGE_VERSIONS = Object.freeze({
  IRkernel: "1.3.2",
  jsonlite: "2.0.0",
  rlang: "1.1.7",
  languageserver: "0.3.17",
  rmarkdown: "2.30",
  knitr: "1.51",
  tibble: "3.3.1",
  "data.table": "1.18.2.1",
  collapse: "2.1.7",
  nanoparquet: "0.5.1"
});
const R_ACCEPTANCE_PACKAGES = Object.freeze(Object.keys(R_ACCEPTANCE_PACKAGE_VERSIONS));
const R_ACCEPTANCE_PACKAGE_RECORD = Object.entries(R_ACCEPTANCE_PACKAGE_VERSIONS)
  .map(([packageName, version]) => `${packageName}=${version}`)
  .join("\n");
const R_ACCEPTANCE_EXPECTED_VERSIONS = Object.entries(R_ACCEPTANCE_PACKAGE_VERSIONS)
  .map(([packageName, version]) => `${JSON.stringify(packageName)} = ${JSON.stringify(version)}`)
  .join(", ");
const R_ACCEPTANCE_KERNEL_ID = "openwrangler-r-acceptance";
const R_ACCEPTANCE_KERNEL_DISPLAY_NAME = "R (Open Wrangler)";
const R_ACCEPTANCE_EXECUTABLE_PROBE_TIMEOUT_MS = 300_000;
const R_ACCEPTANCE_EXECUTABLE_PROBE = [
  '.ow_r <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "R.exe" else "R")',
  'cat(normalizePath(.ow_r, winslash = "/", mustWork = TRUE), sep = "")'
].join("\n");
const R_ACCEPTANCE_PROBE = [
  `.ow_expected <- c(${R_ACCEPTANCE_EXPECTED_VERSIONS})`,
  ".ow_packages <- names(.ow_expected)",
  '.ow_library <- normalizePath(Sys.getenv("R_LIBS_USER"), winslash = "/", mustWork = TRUE)',
  ".ow_locations <- vapply(.ow_packages, function(.ow_package) {",
  "  .ow_location <- find.package(.ow_package, lib.loc = .ow_library, quiet = TRUE)",
  '  if (length(.ow_location) == 1L) .ow_location else ""',
  "}, character(1L), USE.NAMES = FALSE)",
  'if (any(!nzchar(.ow_locations))) quit(save = "no", status = 10L)',
  ".ow_versions <- vapply(.ow_packages, function(.ow_package) {",
  "  as.character(utils::packageVersion(.ow_package, lib.loc = .ow_library))",
  "}, character(1L), USE.NAMES = FALSE)",
  'if (!identical(.ow_versions, unname(.ow_expected))) quit(save = "no", status = 11L)',
  ".ow_loadable <- vapply(.ow_packages, function(.ow_package) {",
  "  tryCatch({",
  "    loadNamespace(.ow_package, lib.loc = .ow_library)",
  "    TRUE",
  "  }, error = function(...) FALSE)",
  "}, logical(1L), USE.NAMES = FALSE)",
  'if (any(!.ow_loadable)) quit(save = "no", status = 12L)',
  ".ow_collapse_input <- data.frame(group = c('A', 'B'), value = c(1, 2), stringsAsFactors = FALSE)",
  ".ow_collapse_stage <- function(.ow_stage) {",
  "  cat('OPEN_WRANGLER_R_COLLAPSE_PROBE:', .ow_stage, '\\n', sep = '', file = stderr())",
  "  flush(stderr())",
  "}",
  ".ow_collapse_stage('qDF')",
  ".ow_qdf <- tryCatch(",
  "  suppressMessages(suppressWarnings(collapse::qDF(.ow_collapse_input))),",
  "  error = function(...) NULL",
  ")",
  'if (!inherits(.ow_qdf, "data.frame")) quit(save = "no", status = 13L)',
  ".ow_collapse_stage('qTBL')",
  ".ow_qtbl <- tryCatch(",
  "  suppressMessages(suppressWarnings(collapse::qTBL(.ow_collapse_input))),",
  "  error = function(...) NULL",
  ")",
  'if (!inherits(.ow_qtbl, "tbl_df")) quit(save = "no", status = 14L)',
  ".ow_collapse_stage('qDT')",
  ".ow_qdt <- tryCatch(",
  "  suppressMessages(suppressWarnings(collapse::qDT(.ow_collapse_input))),",
  "  error = function(...) NULL",
  ")",
  'if (!inherits(.ow_qdt, "data.table")) quit(save = "no", status = 15L)',
  'cat(paste(.ow_packages, .ow_versions, sep = "=", collapse = "\\n"), sep = "")'
].join("\n");
export function rAcceptanceRepositories(platform = process.platform) {
  if (platform === "linux") {
    return Object.freeze({
      repository: R_ACCEPTANCE_REPOSITORY,
      supplementalRepository: R_ACCEPTANCE_SUPPLEMENTAL_REPOSITORY
    });
  }
  if (platform === "darwin" || platform === "win32") {
    return Object.freeze({
      repository: `https://p3m.dev/cran/${R_ACCEPTANCE_PRIMARY_SNAPSHOT}`,
      supplementalRepository: `https://p3m.dev/cran/${R_ACCEPTANCE_SUPPLEMENTAL_SNAPSHOT}`
    });
  }
  throw new Error(`Released-Jupyter R acceptance does not support ${JSON.stringify(platform)}.`);
}

function rAcceptanceInstall({ repository, supplementalRepository }, platform) {
  const nativeCollapseInstall =
    platform === "darwin" || platform === "win32"
      ? [
          "utils::install.packages(",
          '  "collapse",',
          "  lib = .ow_library,",
          `  repos = ${JSON.stringify(supplementalRepository)},`,
          '  type = "source",',
          "  dependencies = NA,",
          "  quiet = TRUE",
          ")"
        ]
      : [];
  return [
    'Sys.setenv(MAKEFLAGS = "-s")',
    `.ow_packages <- c(${R_ACCEPTANCE_PACKAGES.map((packageName) => JSON.stringify(packageName)).join(", ")})`,
    '.ow_supplemental_packages <- c("collapse", "nanoparquet")',
    platform === "darwin" || platform === "win32"
      ? '.ow_binary_supplemental_packages <- "nanoparquet"'
      : ".ow_binary_supplemental_packages <- .ow_supplemental_packages",
    ".ow_core_packages <- setdiff(.ow_packages, .ow_supplemental_packages)",
    '.ow_library <- normalizePath(Sys.getenv("R_LIBS_USER"), winslash = "/", mustWork = TRUE)',
    "utils::install.packages(",
    "  .ow_core_packages,",
    "  lib = .ow_library,",
    `  repos = ${JSON.stringify(repository)},`,
    "  dependencies = NA,",
    "  quiet = TRUE",
    ")",
    "utils::install.packages(",
    "  .ow_binary_supplemental_packages,",
    "  lib = .ow_library,",
    `  repos = ${JSON.stringify(supplementalRepository)},`,
    "  dependencies = NA,",
    "  quiet = TRUE",
    ")",
    ...nativeCollapseInstall
  ].join("\n");
}

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

export async function prepareJupyterAcceptanceREnvironment(
  directory,
  rscript,
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
    typeof rscript !== "string" ||
    !isAbsolute(rscript) ||
    /[\0\r\n]/u.test(rscript) ||
    !existsSync(rscript) ||
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    typeof runCommand !== "function"
  ) {
    throw new Error(
      "Released-Jupyter R acceptance requires a new contained private environment and an existing absolute Rscript executable."
    );
  }

  const repositories = rAcceptanceRepositories(platform);
  const canonicalRscript = validateRExecutable(rscript, "Rscript");
  const root = validateNewContainedRDirectory(directory, containedBy);
  const rExecutable = await resolveJupyterAcceptanceRExecutable(canonicalRscript, {
    environment: Object.freeze(rIndependentCommandEnvironment(environment)),
    runCommand
  });
  mkdirSync(root, { recursive: false, mode: 0o700 });
  const directoryReceipt = createEditorAcceptancePrivateRootReceipt(root, { containedBy });
  const libraryDir = resolve(root, "l");
  const homeDir = resolve(root, "h");
  const tempDir = resolve(root, "t");
  const dataDir = resolve(root, "d");
  const runtimeDir = resolve(root, "r");
  const configDir = resolve(root, "c");
  const pathDir = resolve(root, "p");
  const kernelDirectory = resolve(dataDir, "kernels", R_ACCEPTANCE_KERNEL_ID);
  for (const path of [libraryDir, homeDir, tempDir, dataDir, runtimeDir, configDir, pathDir, kernelDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);

  const kernelSpecPath = resolve(kernelDirectory, "kernel.json");
  writeFileSync(
    kernelSpecPath,
    `${JSON.stringify(
      {
        argv: [rExecutable, "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"],
        display_name: R_ACCEPTANCE_KERNEL_DISPLAY_NAME,
        language: "R",
        env: { R_LIBS_USER: libraryDir }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);

  const commandEnvironment = privateRCommandEnvironment(environment, {
    homeDir,
    libraryDir,
    tempDir
  });
  const dependencyProbe = freezeRCommandInvocation(
    {
      executable: canonicalRscript,
      args: ["--vanilla", "-e", R_ACCEPTANCE_PROBE],
      environment: commandEnvironment,
      label: "Released-Jupyter private R dependency probe"
    },
    30_000
  );
  const dependencyInstall = freezeRCommandInvocation(
    {
      executable: canonicalRscript,
      args: ["--vanilla", "-e", rAcceptanceInstall(repositories, platform)],
      environment: commandEnvironment,
      label: "Released-Jupyter private R dependency installation"
    },
    600_000
  );

  return Object.freeze({
    root,
    libraryDir,
    kernelId: R_ACCEPTANCE_KERNEL_ID,
    kernelDisplayName: R_ACCEPTANCE_KERNEL_DISPLAY_NAME,
    rExecutable,
    kernelSpecPath,
    packages: R_ACCEPTANCE_PACKAGES,
    packageVersions: R_ACCEPTANCE_PACKAGE_VERSIONS,
    packageRecord: R_ACCEPTANCE_PACKAGE_RECORD,
    repository: repositories.repository,
    supplementalRepository: repositories.supplementalRepository,
    jupyterEnvironment: Object.freeze({
      dataDir,
      runtimeDir,
      configDir,
      path: pathDir,
      rscriptPath: canonicalRscript,
      rLibraryDir: libraryDir
    }),
    dependencyProbe,
    dependencyInstall
  });
}

async function resolveJupyterAcceptanceRExecutable(rscript, { environment, runCommand }) {
  let result;
  try {
    result = await runCommand(
      {
        executable: rscript,
        args: ["--vanilla", "-e", R_ACCEPTANCE_EXECUTABLE_PROBE],
        environment,
        label: "Released-Jupyter matching R executable probe"
      },
      { timeoutMs: R_ACCEPTANCE_EXECUTABLE_PROBE_TIMEOUT_MS }
    );
  } catch (error) {
    throw new Error("Released-Jupyter R acceptance could not resolve the R executable matching Rscript.", {
      cause: error
    });
  }
  const stdout = result?.stdout;
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > 4_096 ||
    stdout.length === 0 ||
    /[\0\r\n]/u.test(stdout) ||
    !isAbsolute(stdout)
  ) {
    throw new Error("Released-Jupyter R acceptance received an invalid matching R executable path.");
  }
  const resolved = validateRExecutable(stdout, "R");
  if (resolved === rscript) {
    throw new Error("Released-Jupyter R acceptance resolved Rscript instead of the matching R executable.");
  }
  return resolved;
}

function validateRExecutable(executable, name) {
  try {
    const canonical = realpathSync(executable);
    if (!lstatSync(canonical).isFile()) {
      throw new Error("not a file");
    }
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    throw new Error(`Released-Jupyter R acceptance requires ${name} to be an executable file.`);
  }
}

function validateNewContainedRDirectory(directory, containedBy) {
  const root = resolve(directory);
  let canonicalContainer;
  let canonicalParent;
  try {
    canonicalContainer = realpathSync(resolve(containedBy));
    canonicalParent = realpathSync(dirname(root));
  } catch {
    throw new Error("Released-Jupyter R acceptance requires an existing caller-owned parent directory.");
  }
  const parentWithinContainer = relative(canonicalContainer, canonicalParent);
  if (
    parentWithinContainer === ".." ||
    parentWithinContainer.startsWith(`..${sep}`) ||
    isAbsolute(parentWithinContainer)
  ) {
    throw new Error("Released-Jupyter R acceptance environment must stay inside its caller-owned root.");
  }
  return root;
}

function privateRCommandEnvironment(environment, { homeDir, libraryDir, tempDir }) {
  const isolated = rIndependentCommandEnvironment(environment);
  Object.assign(isolated, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    R_USER: homeDir,
    R_LIBS_USER: libraryDir
  });
  return Object.freeze(isolated);
}

function rIndependentCommandEnvironment(environment) {
  const isolated = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || /[\0\r\n]/u.test(key) || /[\0]/u.test(value)) {
      throw new Error("Released-Jupyter R acceptance received an invalid command environment.");
    }
    if (/^R_/iu.test(key)) continue;
    isolated[key] = value;
  }
  return isolated;
}

function freezeRCommandInvocation(input, timeoutMs) {
  return Object.freeze({
    input: Object.freeze({
      ...input,
      args: Object.freeze([...input.args])
    }),
    options: Object.freeze({ timeoutMs })
  });
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
