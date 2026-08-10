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
import {
  createEditorAcceptanceEnvironment,
  readBoundedAcceptanceText,
  runBoundedEditorCommand
} from "./editor-acceptance.mjs";
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
  Rcpp: "1.1.1",
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
const R_ACCEPTANCE_KERNEL_EXPRESSION = "IRkernel::main()";
const R_ACCEPTANCE_PROFILE_MARKER = "OPEN_WRANGLER_R_PROFILE_READY\n";
const R_ACCEPTANCE_PROFILE = String.raw`local({
  .ow_library <- Sys.getenv("R_LIBS_USER", unset = NA_character_)
  .ow_stage <- Sys.getenv("OPEN_WRANGLER_R_PROFILE_STAGE", unset = NA_character_)
  if (is.na(.ow_library) || !dir.exists(.ow_library) || is.na(.ow_stage)) {
    stop("Open Wrangler R acceptance profile is incomplete.")
  }
  .ow_library <- normalizePath(.ow_library, winslash = "/", mustWork = TRUE)
  .libPaths(unique(c(.ow_library, .libPaths())))
  if (!identical(normalizePath(.libPaths()[[1L]], winslash = "/", mustWork = TRUE), .ow_library)) {
    stop("Open Wrangler R acceptance library is not first.")
  }
  .ow_connection <- file(.ow_stage, open = "ab")
  tryCatch(
    writeChar("OPEN_WRANGLER_R_PROFILE_READY\n", .ow_connection, eos = NULL, useBytes = TRUE),
    finally = close(.ow_connection)
  )
})
`;
const R_ACCEPTANCE_EXECUTABLE_PROBE_TIMEOUT_MS = 300_000;
const rAcceptanceProfileReceipts = new WeakMap();
const R_ACCEPTANCE_KERNEL_PROBE = String.raw`
import subprocess, sys, time
stage, manager, client, result = "start", None, None, None
try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpecManager
    kernel_id, kernel_dir, connection_file, private_cwd = sys.argv[1:]
    specs = KernelSpecManager(kernel_dirs=[kernel_dir], ensure_native_kernel=False, allowed_kernelspecs={kernel_id})
    manager = KernelManager(kernel_name=kernel_id, kernel_spec_manager=specs, connection_file=connection_file)
    manager.start_kernel(cwd=private_cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stage = "ready"
    client = manager.blocking_client(); client.start_channels(); client.wait_for_ready(timeout=12)
    stage = "execute"
    request = client.execute("cat(\"__OW_RELEASED_R_KERNEL__\", as.character(getRversion()), '\\n', sep = '')", store_history=False, allow_stdin=False, stop_on_error=True)
    deadline, marker = time.monotonic() + 8, False
    while time.monotonic() < deadline:
        message = client.get_iopub_msg(timeout=max(0.01, deadline - time.monotonic()))
        if message.get("parent_header", {}).get("msg_id") != request: continue
        kind, content = message.get("header", {}).get("msg_type"), message.get("content", {})
        if kind == "stream" and content.get("name") == "stdout":
            marker = content.get("text", "").startswith("__OW_RELEASED_R_KERNEL__")
        elif kind == "error": raise RuntimeError("kernel error")
        elif kind == "status" and content.get("execution_state") == "idle":
            if not marker: raise RuntimeError("missing marker")
            result = "ready"; break
except BaseException: result = stage
finally:
    try:
        if client is not None: client.stop_channels()
        if manager is not None and manager.has_kernel: manager.shutdown_kernel(now=True)
    except BaseException: result = "cleanup"
sys.stdout.write("OPEN_WRANGLER_R_KERNEL_" + ("READY" if result == "ready" else "FAILED:" + (result or stage)) + "\n")
`.trimStart();
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
  ".ow_row_count <- 1205L",
  ".ow_collapse_input <- data.frame(",
  "  row_id = seq_len(.ow_row_count),",
  "  group = c(rep('A', 602L), rep('B', .ow_row_count - 602L)),",
  "  score = as.numeric(seq_len(.ow_row_count)),",
  "  label = sprintf('row-%04d', seq_len(.ow_row_count)),",
  "  fractional_score = ifelse(seq_len(.ow_row_count) %% 2L == 0L, -as.numeric(seq_len(.ow_row_count)) - 0.25, as.numeric(seq_len(.ow_row_count)) + 0.25),",
  "  check.names = FALSE,",
  "  stringsAsFactors = FALSE",
  ")",
  "for (.ow_column_index in seq_len(20L)) {",
  "  .ow_collapse_input[[sprintf('extra_%02d', .ow_column_index)]] <- sprintf('value-%02d-%04d', .ow_column_index, seq_len(.ow_row_count))",
  "}",
  ".ow_collapse_input$extra_20[1L] <- NA_character_",
  ".ow_collapse_input$fractional_score[603L] <- NA_real_",
  "row.names(.ow_collapse_input) <- sprintf('case-%04d', seq_len(.ow_row_count))",
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
  ".ow_collapse_stage('fgroup_by')",
  ".ow_grouped <- tryCatch(",
  "  suppressMessages(suppressWarnings(collapse::fgroup_by(.ow_qdf, group))),",
  "  error = function(...) NULL",
  ")",
  'if (!inherits(.ow_grouped, "grouped_df")) quit(save = "no", status = 16L)',
  ".ow_collapse_stage('findex_by')",
  ".ow_indexed <- tryCatch(",
  "  suppressMessages(suppressWarnings(collapse::findex_by(.ow_qdf, group, row_id))),",
  "  error = function(...) NULL",
  ")",
  'if (!inherits(.ow_indexed, "indexed_frame")) quit(save = "no", status = 17L)',
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
    platform === "darwin"
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
    platform === "darwin"
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
  const profilePath = resolve(root, "profile.R");
  const profileStagePath = resolve(root, "profile-stage");
  const kernelDirectory = resolve(dataDir, "kernels", R_ACCEPTANCE_KERNEL_ID);
  for (const path of [libraryDir, homeDir, tempDir, dataDir, runtimeDir, configDir, pathDir, kernelDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);

  const commandEnvironment = privateRCommandEnvironment(environment, {
    homeDir,
    libraryDir,
    tempDir
  });
  writeFileSync(profilePath, R_ACCEPTANCE_PROFILE, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(profileStagePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const profileIdentity = ownedRProfileFileIdentity(profilePath, "profile");
  const profileStageIdentity = ownedRProfileFileIdentity(profileStagePath, "startup marker");
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  const kernelEnvironment = {
    HOME: commandEnvironment.HOME,
    USERPROFILE: commandEnvironment.USERPROFILE,
    TMPDIR: commandEnvironment.TMPDIR,
    TMP: commandEnvironment.TMP,
    TEMP: commandEnvironment.TEMP,
    R_USER: commandEnvironment.R_USER,
    R_LIBS_USER: commandEnvironment.R_LIBS_USER,
    R_PROFILE_USER: profilePath,
    OPEN_WRANGLER_R_PROFILE_STAGE: profileStagePath
  };

  const kernelSpecPath = resolve(kernelDirectory, "kernel.json");
  writeFileSync(
    kernelSpecPath,
    `${JSON.stringify(
      {
        argv: [rExecutable, "--slave", "-e", R_ACCEPTANCE_KERNEL_EXPRESSION, "--args", "{connection_file}"],
        display_name: R_ACCEPTANCE_KERNEL_DISPLAY_NAME,
        language: "R",
        env: kernelEnvironment
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);

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

  const prepared = Object.freeze({
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
  rAcceptanceProfileReceipts.set(prepared, {
    directoryReceipt,
    profilePath,
    profileIdentity,
    profileStagePath,
    profileStageIdentity,
    readinessMarkerCount: undefined
  });
  return prepared;
}

export async function probeJupyterAcceptanceRKernel(python, prepared, { runCommand = runBoundedEditorCommand } = {}) {
  if (
    typeof python !== "string" ||
    !isAbsolute(python) ||
    /[\0\r\n]/u.test(python) ||
    !existsSync(python) ||
    prepared?.kernelId !== R_ACCEPTANCE_KERNEL_ID ||
    typeof prepared.root !== "string" ||
    !isAbsolute(prepared.root) ||
    typeof prepared.kernelSpecPath !== "string" ||
    !isAbsolute(prepared.kernelSpecPath) ||
    typeof prepared.jupyterEnvironment?.runtimeDir !== "string" ||
    !isAbsolute(prepared.jupyterEnvironment.runtimeDir) ||
    typeof prepared.dependencyProbe?.input?.environment !== "object" ||
    typeof runCommand !== "function"
  ) {
    throw new Error("Released-Jupyter R kernel readiness requires one exact prepared private environment.");
  }

  const homeDir = resolve(prepared.root, "h");
  const result = await runCommand(
    {
      executable: python,
      args: [
        "-I",
        "-c",
        R_ACCEPTANCE_KERNEL_PROBE,
        prepared.kernelId,
        dirname(dirname(prepared.kernelSpecPath)),
        resolve(prepared.jupyterEnvironment.runtimeDir, "kernel-readiness.json"),
        homeDir
      ],
      environment: prepared.dependencyProbe.input.environment,
      label: "Released-Jupyter private R kernel readiness probe"
    },
    { timeoutMs: 30_000, maxOutputBytes: 1_024 }
  );
  if (result?.stderr !== "") {
    throw new Error("Released-Jupyter R kernel readiness probe returned a malformed fixed result.");
  }
  if (/^OPEN_WRANGLER_R_KERNEL_READY\r?\n$/u.test(result.stdout)) {
    const receipt = rAcceptanceProfileReceipt(prepared);
    const markerCount = readRProfileMarkerCount(receipt);
    if (markerCount !== 1) {
      throw new Error("Released-Jupyter R kernel readiness did not load the private R profile exactly once.");
    }
    receipt.readinessMarkerCount = markerCount;
    return;
  }
  const failure = /^OPEN_WRANGLER_R_KERNEL_FAILED:(start|ready|execute|cleanup)\r?\n$/u.exec(result.stdout);
  if (failure) throw new Error(`Released-Jupyter R kernel readiness failed during ${failure[1]}.`);
  throw new Error("Released-Jupyter R kernel readiness probe returned a malformed fixed result.");
}

export function jupyterAcceptanceRProfileStartupStage(prepared) {
  const receipt = rAcceptanceProfileReceipt(prepared);
  if (receipt.readinessMarkerCount !== 1) {
    throw new Error("Released-Jupyter R profile startup stage requires a completed readiness baseline.");
  }
  return readRProfileMarkerCount(receipt) > receipt.readinessMarkerCount ? "profile-loaded" : "profile-not-loaded";
}

export function appendJupyterAcceptanceRProfileStartupStage(error, stage) {
  if (stage !== "profile-loaded" && stage !== "profile-not-loaded") {
    throw new Error("Released-Jupyter R profile startup received an invalid fixed stage.");
  }
  const suffix = `Released-Jupyter R profile startup: ${stage}.`;
  if (error instanceof Error) {
    try {
      error.message = `${error.message}\n${suffix}`;
      return error;
    } catch {
      // Keep the original classified failure as a leaf if it cannot be annotated in place.
    }
  }
  return new AggregateError([error], suffix);
}

function rAcceptanceProfileReceipt(prepared) {
  const receipt = rAcceptanceProfileReceipts.get(prepared);
  if (!receipt) throw new Error("Released-Jupyter R profile startup requires its exact prepared environment.");
  assertEditorAcceptancePrivateRootReceipt(receipt.directoryReceipt);
  assertOwnedRProfileFileIdentity(receipt.profilePath, receipt.profileIdentity, "profile");
  return receipt;
}

function readRProfileMarkerCount(receipt) {
  const snapshot = assertOwnedRProfileFileIdentity(
    receipt.profileStagePath,
    receipt.profileStageIdentity,
    "startup marker"
  );
  const contents = readBoundedAcceptanceText(
    receipt.profileStagePath,
    1_024,
    "Released-Jupyter R profile startup marker",
    { expectedPathSnapshot: snapshot }
  );
  if (contents.length === 0) return 0;
  if (contents.replaceAll(R_ACCEPTANCE_PROFILE_MARKER, "").length !== 0) {
    throw new Error("Released-Jupyter R profile startup marker contained an invalid fixed value.");
  }
  return contents.length / R_ACCEPTANCE_PROFILE_MARKER.length;
}

function ownedRProfileFileIdentity(path, description) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`Released-Jupyter R ${description} must be one owned regular file.`);
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function assertOwnedRProfileFileIdentity(path, expected, description) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino
  ) {
    throw new Error(`Released-Jupyter R ${description} lost its owned file identity.`);
  }
  return metadata;
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
