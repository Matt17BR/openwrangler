import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
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

const CORE_DEPENDENCIES = Object.freeze(["ipykernel", "jupyter-client", "pandas", "polars", "duckdb", "fsspec"]);
const DEPENDENCIES = Object.freeze(["ipykernel", "pandas", "polars", "duckdb", "fsspec", "pyspark"]);
const BINARY_DEPENDENCIES = Object.freeze([
  "ipykernel",
  "pandas",
  "polars",
  "duckdb",
  "fsspec",
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
  "jupyter-client": "8.9.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  duckdb: "1.5.4",
  fsspec: "2026.7.0",
  pyspark: "4.2.0",
  py4j: "0.10.9.9",
  pyarrow: "25.0.0",
  grpcio: "1.83.0",
  "grpcio-status": "1.83.0",
  "googleapis-common-protos": "1.75.0",
  protobuf: "7.35.1",
  zstandard: "0.25.0"
});
const RELEASED_PYSPARK_STABLE_DISTRIBUTION = validatePySparkArtifactReceipt({
  filename: "pyspark-4.2.0.tar.gz",
  mode: "stable-qualification",
  package: "pyspark",
  schemaVersion: 1,
  sha256: "5ad689d53570ee1674193fd4f9bda065f0db3be9363a27d2a3406cc457b70b61",
  size: 450129423,
  url: "https://files.pythonhosted.org/packages/c3/33/c987434f5d50aa802779a004ca0fd45ee4350caab50554ad7283d5a22b50/pyspark-4.2.0.tar.gz",
  version: RELEASED_JUPYTER_COMPATIBILITY_VERSIONS.pyspark
});
export const RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION = validatePySparkArtifactReceipt(
  JSON.parse(readFileSync(new URL("../fixtures/pyspark-prerelease-distribution.json", import.meta.url), "utf8"))
);
export const RELEASED_PYSPARK_PRERELEASE_DENIAL_VERSION = RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION.version;
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
const QUARTO_PYTHON_ACCEPTANCE_KERNEL_ID = "python3";
const QUARTO_PYTHON_ACCEPTANCE_KERNEL_DISPLAY_NAME = "Python (Open Wrangler Quarto)";
const R_ACCEPTANCE_BOOTSTRAP_STAGES = Object.freeze([
  "entered",
  "library-ready",
  "irkernel-loaded",
  "main-entered",
  "main-error",
  "main-returned"
]);
const rAcceptanceBootstrapReceipts = new WeakMap();
const R_ACCEPTANCE_EXECUTABLE_PROBE_TIMEOUT_MS = 300_000;
const R_ACCEPTANCE_KERNEL_PROBE = String.raw`
import os, subprocess, sys, time
stage, manager, client, succeeded = "start", None, None, False
try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import KernelSpec, KernelSpecManager, NoSuchKernel
    class ExactKernelSpecManager(KernelSpecManager):
        def __init__(self, exact_name, exact_spec):
            super().__init__(ensure_native_kernel=False, allowed_kernelspecs={exact_name})
            self._exact_name, self._exact_spec = exact_name, exact_spec
        def get_kernel_spec(self, kernel_name):
            if kernel_name != self._exact_name: raise NoSuchKernel(kernel_name)
            return self._exact_spec
    kernel_id, kernel_spec_path, connection_file, private_cwd = sys.argv[1:]
    kernel_spec = KernelSpec.from_resource_dir(os.path.dirname(kernel_spec_path))
    specs = ExactKernelSpecManager(kernel_id, kernel_spec)
    manager = KernelManager(kernel_name=kernel_id, kernel_spec_manager=specs, connection_file=connection_file)
    if manager.kernel_spec is not kernel_spec: raise RuntimeError("kernel spec mismatch")
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
            succeeded = True; break
except BaseException: pass
finally:
    try:
        if client is not None: client.stop_channels()
        if manager is not None and manager.has_kernel: manager.shutdown_kernel(now=True)
    except BaseException:
        stage, succeeded = "cleanup", False
sys.stdout.write("OPEN_WRANGLER_R_KERNEL_" + ("READY" if succeeded else "FAILED:" + stage) + "\n")
`.trimStart();
const QUARTO_PYTHON_ACCEPTANCE_KERNEL_PROBE = String.raw`
import os, stat, subprocess, sys, time
stage, process, client, connection_identity, succeeded = "start", None, None, None, False
try:
    from jupyter_client import __version__ as jupyter_client_version
    from jupyter_client.blocking.client import BlockingKernelClient
    from jupyter_client.connect import write_connection_file
    from jupyter_client.kernelspec import KernelSpec
    if jupyter_client_version != "8.9.1": raise RuntimeError("jupyter-client version mismatch")
    kernel_id, kernel_spec_path, connection_file, private_cwd = sys.argv[1:]
    kernel_spec = KernelSpec.from_resource_dir(os.path.dirname(kernel_spec_path))
    if kernel_id != "python3": raise RuntimeError("kernel id mismatch")
    if sum(value.count("{connection_file}") for value in kernel_spec.argv) != 1: raise RuntimeError("connection placeholder mismatch")
    command = [value.replace("{connection_file}", connection_file) for value in kernel_spec.argv]
    if command[1:] != ["-I", "-m", "ipykernel_launcher", "-f", connection_file]: raise RuntimeError("kernel argv mismatch")
    if not os.path.samefile(command[0], sys.executable): raise RuntimeError("kernel interpreter mismatch")
    connection_key = os.urandom(32).hex().encode("ascii")
    _, connection_info = write_connection_file(
        fname=connection_file, ip="127.0.0.1", key=connection_key, kernel_name=kernel_id
    )
    connection_stat = os.lstat(connection_file)
    if not stat.S_ISREG(connection_stat.st_mode) or connection_stat.st_nlink != 1:
        raise RuntimeError("connection file identity invalid")
    if os.name == "posix" and connection_stat.st_mode & 0o777 != 0o600:
        raise RuntimeError("connection file mode invalid")
    connection_identity = (connection_stat.st_dev, connection_stat.st_ino, connection_stat.st_mode, connection_stat.st_nlink, connection_stat.st_size, connection_stat.st_mtime_ns, connection_stat.st_ctime_ns)
    kernel_environment = os.environ.copy(); kernel_environment.update(kernel_spec.env or {})
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=private_cwd,
        env=kernel_environment,
        close_fds=True,
        start_new_session=False,
        creationflags=0,
    )
    if process.poll() is not None: raise RuntimeError("kernel exited during launch")
    if os.name == "posix" and os.getpgid(process.pid) != os.getpgrp(): raise RuntimeError("kernel escaped owned process group")
    client = BlockingKernelClient(); client.load_connection_info(connection_info); client.start_channels(); client.wait_for_ready(timeout=12)
    stage = "execute"
    code = "import pandas as pd\nframe = pd.DataFrame({'city': ['Berlin', 'Oslo'], 'value': [1, 2]})\nassert frame.shape == (2, 2) and list(frame.columns) == ['city', 'value']\nprint('__OW_QUARTO_PYTHON_KERNEL__:2:city,value')"
    request = client.execute(code, store_history=False, allow_stdin=False, stop_on_error=True)
    deadline, output = time.monotonic() + 8, ""
    while time.monotonic() < deadline:
        message = client.get_iopub_msg(timeout=max(0.01, deadline - time.monotonic()))
        if message.get("parent_header", {}).get("msg_id") != request: continue
        kind, content = message.get("header", {}).get("msg_type"), message.get("content", {})
        if kind == "stream" and content.get("name") == "stdout":
            output += content.get("text", "")
            if len(output) > 128: raise RuntimeError("oversized marker")
        elif kind == "error": raise RuntimeError("kernel error")
        elif kind == "status" and content.get("execution_state") == "idle":
            if output != "__OW_QUARTO_PYTHON_KERNEL__:2:city,value\n": raise RuntimeError("missing marker")
            succeeded = True; break
except BaseException: pass
finally:
    cleanup_failed = False
    try:
        if client is not None: client.stop_channels()
    except BaseException:
        cleanup_failed = True
    try:
        if process is not None and process.poll() is None:
            process.terminate()
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=2)
        if process is not None and process.poll() is None: raise RuntimeError("kernel process survived cleanup")
    except BaseException:
        cleanup_failed = True
    try:
        if connection_identity is None:
            if os.path.lexists(connection_file): raise RuntimeError("unowned connection file")
        else:
            connection_stat = os.lstat(connection_file)
            current_identity = (connection_stat.st_dev, connection_stat.st_ino, connection_stat.st_mode, connection_stat.st_nlink, connection_stat.st_size, connection_stat.st_mtime_ns, connection_stat.st_ctime_ns)
            if current_identity != connection_identity: raise RuntimeError("connection file identity changed")
            os.unlink(connection_file)
            if os.path.lexists(connection_file): raise RuntimeError("connection file survived cleanup")
    except BaseException:
        cleanup_failed = True
    if cleanup_failed:
        stage, succeeded = "cleanup", False
sys.stdout.write("OPEN_WRANGLER_QUARTO_PYTHON_KERNEL_" + ("READY" if succeeded else "FAILED:" + stage) + "\n")
`.trimStart();
const jupyterAcceptanceKernelPythonReceipts = new Map();
const quartoPythonKernelReceipts = new WeakMap();

function rAcceptanceKernelBootstrap(libraryDir, stagePath) {
  const libraryLiteral = JSON.stringify(libraryDir.replaceAll("\\", "/"));
  const stageLiteral = JSON.stringify(stagePath.replaceAll("\\", "/"));
  return `local({
  .ow_stage_path <- ${stageLiteral}
  .ow_stage <- function(value) cat(value, "\\n", file = .ow_stage_path, append = TRUE, sep = "")
  .ow_stage("entered")
  .ow_library <- normalizePath(${libraryLiteral}, winslash = "/", mustWork = TRUE)
  .libPaths(unique(c(.ow_library, .libPaths())))
  if (!identical(normalizePath(.libPaths()[[1L]], winslash = "/", mustWork = TRUE), .ow_library)) {
    stop("Open Wrangler R acceptance library is not first.")
  }
  .ow_stage("library-ready")
  .ow_namespace <- loadNamespace("IRkernel", lib.loc = .ow_library)
  .ow_stage("irkernel-loaded")
  .ow_stage("main-entered")
  tryCatch(
    get("main", envir = .ow_namespace, inherits = FALSE)(),
    error = function(error) {
      .ow_stage("main-error")
      stop(error)
    }
  )
  .ow_stage("main-returned")
})
`;
}
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
    pysparkDistribution = RELEASED_PYSPARK_STABLE_DISTRIBUTION,
    acquirePySparkArtifact = acquireVerifiedPySparkArtifact,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  validateJupyterAcceptanceKernelPythonInput(directory, basePython, containedBy, runCommand, acquirePySparkArtifact);
  const exactPySparkDistribution = validateReleasedPySparkDistribution(pysparkDistribution);
  const java = await probeJupyterAcceptanceJava({
    environment,
    runCommand
  });
  console.log(`Released-Jupyter PySpark Java preflight passed: Java ${java.version} (major ${java.major}).`);
  return createJupyterAcceptanceKernelPythonEnvironment(directory, basePython, {
    containedBy,
    environment,
    platform,
    acquirePySparkArtifact,
    pysparkDistribution: exactPySparkDistribution,
    runCommand,
    includePySpark: true,
    labels: Object.freeze({
      baseProbe: "Released-Jupyter base dependency version probe",
      create: "Released-Jupyter private kernel environment creation",
      install: "Released-Jupyter private kernel binary dependency installation",
      pysparkInstall: "Released-Jupyter private kernel PySpark installation",
      finalProbe: "Released-Jupyter private kernel dependency probe",
      compatibility: "Released-Jupyter private kernel"
    })
  });
}

export async function createJupyterAcceptanceCoreKernelPython(
  directory,
  basePython,
  {
    containedBy,
    environment = createEditorAcceptanceEnvironment(),
    platform = process.platform,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  validateJupyterAcceptanceKernelPythonInput(directory, basePython, containedBy, runCommand);
  return createJupyterAcceptanceKernelPythonEnvironment(directory, basePython, {
    containedBy,
    environment,
    platform,
    runCommand,
    includePySpark: false,
    labels: Object.freeze({
      baseProbe: "Quarto Python base dependency version probe",
      create: "Quarto Python private kernel environment creation",
      install: "Quarto Python private kernel dependency installation",
      finalProbe: "Quarto Python private kernel dependency probe",
      compatibility: "Quarto Python private kernel"
    })
  });
}

function validateJupyterAcceptanceKernelPythonInput(
  directory,
  basePython,
  containedBy,
  runCommand,
  acquirePySparkArtifact
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
    typeof runCommand !== "function" ||
    (acquirePySparkArtifact !== undefined && typeof acquirePySparkArtifact !== "function")
  ) {
    throw new Error(
      "Released-Jupyter acceptance requires a new contained private environment and an existing absolute base interpreter."
    );
  }
}

async function createJupyterAcceptanceKernelPythonEnvironment(
  directory,
  basePython,
  {
    containedBy,
    environment,
    platform,
    runCommand,
    includePySpark,
    labels,
    pysparkDistribution,
    acquirePySparkArtifact
  }
) {
  await probeJupyterAcceptancePython(basePython, {
    environment,
    requirePySpark: false,
    requireJupyterClient: false,
    label: labels.baseProbe,
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
      label: labels.create
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
        ...(includePySpark ? BINARY_DEPENDENCIES : CORE_DEPENDENCIES).map(
          (dependency) => `${dependency}==${RELEASED_JUPYTER_COMPATIBILITY_VERSIONS[dependency]}`
        )
      ],
      environment,
      label: labels.install
    },
    { timeoutMs: 240_000 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  if (includePySpark) {
    let acquiredArtifact;
    let artifact;
    let installFailure;
    try {
      acquiredArtifact = await acquirePySparkArtifact(directory, pysparkDistribution);
      artifact = validateAcquiredPySparkArtifact(directory, acquiredArtifact, pysparkDistribution);
      assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
      const pipArguments = [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-warn-script-location",
        "--no-cache-dir",
        "--no-deps"
      ];
      await runCommand(
        {
          executable: kernelPython,
          args: pipArguments,
          environment,
          label: labels.pysparkInstall,
          beforeSpawn() {
            assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
            return artifact.preparePipLaunch(pipArguments, platform);
          }
        },
        { timeoutMs: 240_000 }
      );
      assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
    } catch (error) {
      installFailure = error;
    } finally {
      if (acquiredArtifact !== undefined) {
        try {
          await disposeAcquiredPySparkArtifact(acquiredArtifact);
        } catch (cleanupError) {
          if (installFailure !== undefined) {
            installFailure = new AggregateError(
              [installFailure, cleanupError],
              "Released-Jupyter PySpark installation and artifact cleanup both failed."
            );
          } else {
            installFailure = cleanupError;
          }
        }
      }
    }
    if (installFailure !== undefined) throw installFailure;
    assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  }
  const installedVersions = await probeJupyterAcceptancePython(kernelPython, {
    environment,
    label: labels.finalProbe,
    requirePySpark: includePySpark,
    requireJupyterClient: !includePySpark,
    requireRuntimeAbsent: true,
    runCommand
  });
  for (const dependency of includePySpark ? DEPENDENCIES : CORE_DEPENDENCIES) {
    const expectedVersion =
      dependency === "pyspark" ? pysparkDistribution.version : RELEASED_JUPYTER_COMPATIBILITY_VERSIONS[dependency];
    if (installedVersions[dependency] !== expectedVersion) {
      throw new Error(`${labels.compatibility} did not retain the ${dependency} compatibility version.`);
    }
  }
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  if (!includePySpark) {
    jupyterAcceptanceKernelPythonReceipts.set(
      kernelPython,
      Object.freeze({
        directoryReceipt,
        identity: captureKernelPythonIdentity(kernelPython, directoryReceipt)
      })
    );
  }
  return kernelPython;
}

async function disposeAcquiredPySparkArtifact(artifact) {
  if (typeof artifact?.dispose !== "function") {
    throw new Error("Released-Jupyter PySpark acquisition did not expose exact artifact disposal.");
  }
  await artifact.dispose();
}

function validateReleasedPySparkDistribution(value) {
  const receipt = validatePySparkArtifactReceipt(value);
  const expected =
    receipt.mode === "stable-qualification"
      ? RELEASED_PYSPARK_STABLE_DISTRIBUTION
      : receipt.mode === "prerelease-denial"
        ? RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION
        : undefined;
  if (expected === undefined || Object.keys(expected).some((key) => receipt[key] !== expected[key])) {
    throw new Error("Released-Jupyter PySpark provisioning requires one exact bounded distribution receipt.");
  }
  return receipt;
}

function validatePySparkArtifactReceipt(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "filename\0mode\0package\0schemaVersion\0sha256\0size\0url\0version" ||
    value.schemaVersion !== 1 ||
    !["stable-qualification", "prerelease-denial"].includes(value.mode) ||
    value.package !== "pyspark" ||
    typeof value.version !== "string" ||
    !/^[0-9A-Za-z.+-]{1,64}$/u.test(value.version) ||
    value.filename !== `pyspark-${value.version}.tar.gz` ||
    typeof value.url !== "string" ||
    value.url.length > 2_048 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > 512 * 1024 * 1024
  ) {
    throw new Error("Released-Jupyter PySpark provisioning requires one exact bounded distribution receipt.");
  }
  let distributionUrl;
  try {
    distributionUrl = new URL(value.url);
  } catch {
    throw new Error("Released-Jupyter PySpark provisioning requires one valid source-distribution URL.");
  }
  if (
    distributionUrl.protocol !== "https:" ||
    distributionUrl.hostname !== "files.pythonhosted.org" ||
    distributionUrl.port !== "" ||
    distributionUrl.username !== "" ||
    distributionUrl.password !== "" ||
    distributionUrl.search !== "" ||
    distributionUrl.hash !== "" ||
    !distributionUrl.pathname.startsWith("/packages/") ||
    !distributionUrl.pathname.endsWith(`/${value.filename}`)
  ) {
    throw new Error("Released-Jupyter PySpark provisioning requires one exact PyPI source distribution.");
  }
  return Object.freeze({
    filename: value.filename,
    mode: value.mode,
    package: value.package,
    schemaVersion: value.schemaVersion,
    sha256: value.sha256,
    size: value.size,
    url: value.url,
    version: value.version
  });
}

export async function acquireVerifiedPySparkArtifact(
  directory,
  distribution,
  { beforeCleanupLink, fetchImpl = globalThis.fetch, randomBytesImpl = randomBytes, timeoutMs = 300_000 } = {}
) {
  const receipt = validatePySparkArtifactReceipt(distribution);
  const resolvedDirectory = resolve(directory);
  let directoryMetadata;
  try {
    directoryMetadata = lstatSync(resolvedDirectory, { bigint: true });
  } catch {
    throw new Error("Released-Jupyter PySpark download requires one existing private directory.");
  }
  if (
    !isAbsolute(directory) ||
    realpathSync(resolvedDirectory) !== resolvedDirectory ||
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    typeof fetchImpl !== "function" ||
    typeof randomBytesImpl !== "function" ||
    (beforeCleanupLink !== undefined && typeof beforeCleanupLink !== "function") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new Error("Released-Jupyter PySpark download requires one bounded private acquisition context.");
  }
  const artifactEntropy = pySparkArtifactEntropy(randomBytesImpl);
  const cleanupEntropy = pySparkArtifactEntropy(randomBytesImpl);
  const artifactPath = resolve(resolvedDirectory, `${artifactEntropy}-${receipt.filename}`);
  const cleanupDirectory = resolve(resolvedDirectory, `.ow-pyspark-cleanup-${cleanupEntropy}`);
  mkdirSync(cleanupDirectory, { recursive: false, mode: 0o700 });
  const cleanupDirectoryMetadata = lstatSync(cleanupDirectory, { bigint: true });
  if (!cleanupDirectoryMetadata.isDirectory() || cleanupDirectoryMetadata.isSymbolicLink()) {
    throw new Error("Released-Jupyter PySpark cleanup quarantine is not one private directory.");
  }
  const cleanupDirectoryIdentity = downloadedArtifactIdentity(cleanupDirectoryMetadata);
  const cleanupTarget = resolve(cleanupDirectory, `${cleanupEntropy}.artifact`);
  const abortController = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let descriptor;
  let identity;
  let reader;
  try {
    descriptor = openSync(
      artifactPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const opened = fstatSync(descriptor, { bigint: true });
    identity = downloadedArtifactIdentity(opened);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n || opened.size !== 0n) {
      throw new Error("Released-Jupyter PySpark download temporary is not one new regular file.");
    }
    const response = await settlePySparkArtifactStep(
      () =>
        fetchImpl(receipt.url, {
          method: "GET",
          redirect: "error",
          headers: Object.freeze({ Accept: "application/octet-stream", "Accept-Encoding": "identity" }),
          signal: abortController.signal
        }),
      deadline,
      abortController,
      "fetch"
    );
    const declaredLength = response?.headers?.get?.("content-length");
    const contentEncoding = response?.headers?.get?.("content-encoding");
    reader = typeof response?.body?.getReader === "function" ? response.body.getReader() : undefined;
    if (
      response?.status !== 200 ||
      response?.redirected !== false ||
      declaredLength !== String(receipt.size) ||
      (contentEncoding !== null && contentEncoding !== "identity") ||
      reader === undefined
    ) {
      throw new Error("Released-Jupyter PySpark download response did not match the exact artifact receipt.");
    }
    const digest = createHash("sha256");
    let downloaded = 0;
    while (true) {
      const chunk = await settlePySparkArtifactStep(() => reader.read(), deadline, abortController, "stream read");
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) {
        throw new Error("Released-Jupyter PySpark download returned an invalid stream chunk.");
      }
      downloaded += chunk.value.byteLength;
      if (downloaded > receipt.size) {
        throw new Error("Released-Jupyter PySpark download exceeded its exact byte allowance.");
      }
      digest.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const written = writeSync(descriptor, chunk.value, offset, chunk.value.byteLength - offset);
        if (written <= 0) throw new Error("Released-Jupyter PySpark download could not persist its next stream chunk.");
        offset += written;
      }
    }
    await settlePySparkArtifactStep(() => reader.closed, deadline, abortController, "stream settlement");
    if (downloaded !== receipt.size || digest.digest("hex") !== receipt.sha256) {
      throw new Error("Released-Jupyter PySpark download did not match its exact size and SHA-256 receipt.");
    }
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(completed)) ||
      completed.size !== BigInt(receipt.size)
    ) {
      throw new Error("Released-Jupyter PySpark download temporary changed while it was written.");
    }
    const named = lstatSync(artifactPath, { bigint: true });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      named.size !== BigInt(receipt.size) ||
      !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(named))
    ) {
      throw new Error("Released-Jupyter PySpark download path changed after verification.");
    }
    let disposed = false;
    return Object.freeze({
      preparePipLaunch(args, platform) {
        if (disposed || descriptor === undefined) {
          throw new Error("Released-Jupyter PySpark artifact is not available for a new pip launch.");
        }
        if (
          !Array.isArray(args) ||
          args.length === 0 ||
          args.length > 64 ||
          !args.every((argument) => typeof argument === "string" && !/[\0\r\n]/u.test(argument)) ||
          (platform !== "linux" && platform !== "darwin")
        ) {
          throw new Error("Released-Jupyter PySpark pip launch requires one bounded POSIX invocation.");
        }
        const descriptorPath = platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
        let launchDescriptor;
        try {
          launchDescriptor = openSync(
            artifactPath,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
          );
          assertVerifiedPySparkArtifact(launchDescriptor, artifactPath, identity, receipt);
        } catch (error) {
          if (launchDescriptor !== undefined) {
            try {
              closeSync(launchDescriptor);
            } catch (closeError) {
              throw new AggregateError(
                [
                  new Error("Released-Jupyter PySpark artifact identity changed before pip launch.", {
                    cause: error
                  }),
                  closeError
                ],
                "Released-Jupyter PySpark launch verification and descriptor release both failed."
              );
            }
          }
          throw new Error("Released-Jupyter PySpark artifact identity changed before pip launch.", { cause: error });
        }
        let released = false;
        return Object.freeze({
          args: Object.freeze([...args, `${receipt.package} @ file://${descriptorPath}`]),
          inheritedFileDescriptors: Object.freeze([launchDescriptor]),
          release() {
            if (released) throw new Error("Released-Jupyter PySpark launch descriptor was already released.");
            released = true;
            closeSync(launchDescriptor);
          }
        });
      },
      path: artifactPath,
      sha256: receipt.sha256,
      size: receipt.size,
      async dispose() {
        if (disposed) throw new Error("Released-Jupyter PySpark artifact was already disposed.");
        disposed = true;
        const cleanupFailures = [];
        try {
          scrubIdentifiedPySparkArtifact({
            artifactPath,
            beforeCleanupLink,
            cleanupDirectory,
            cleanupDirectoryIdentity,
            cleanupTarget,
            descriptor,
            identity
          });
        } catch (error) {
          cleanupFailures.push(error);
        }
        const descriptorToClose = descriptor;
        descriptor = undefined;
        try {
          closeSync(descriptorToClose);
        } catch (error) {
          cleanupFailures.push(error);
        }
        if (cleanupFailures.length === 1) throw cleanupFailures[0];
        if (cleanupFailures.length > 1) {
          throw new AggregateError(
            cleanupFailures,
            "Released-Jupyter PySpark artifact cleanup and descriptor release both failed."
          );
        }
      }
    });
  } catch (error) {
    abortController.abort();
    const cleanupFailures = [];
    if (reader !== undefined) {
      try {
        await settlePySparkArtifactStep(() => reader.cancel(), deadline, abortController, "stream cancellation");
      } catch (cancelError) {
        cleanupFailures.push(cancelError);
      }
    }
    if (descriptor !== undefined && identity !== undefined) {
      try {
        scrubIdentifiedPySparkArtifact({
          artifactPath,
          beforeCleanupLink,
          cleanupDirectory,
          cleanupDirectoryIdentity,
          cleanupTarget,
          descriptor,
          identity
        });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      } finally {
        const descriptorToClose = descriptor;
        descriptor = undefined;
        try {
          closeSync(descriptorToClose);
        } catch (closeError) {
          cleanupFailures.push(closeError);
        }
      }
    } else if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
        descriptor = undefined;
      } catch (closeError) {
        cleanupFailures.push(closeError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Released-Jupyter PySpark download failed and bounded stream settlement or exact artifact cleanup did not complete."
      );
    }
    throw error;
  }
}

async function settlePySparkArtifactStep(start, deadline, abortController, stage) {
  const operation = Promise.resolve().then(start);
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) {
    abortController.abort();
    operation.catch(() => {});
    throw new Error(`Released-Jupyter PySpark artifact ${stage} exceeded its shared hard deadline.`);
  }
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error(`Released-Jupyter PySpark artifact ${stage} exceeded its shared hard deadline.`));
        }, remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function pySparkArtifactEntropy(randomBytesImpl) {
  const entropy = randomBytesImpl(16);
  if (!Buffer.isBuffer(entropy) || entropy.length !== 16) {
    throw new Error("Released-Jupyter PySpark download requires exact private-path entropy.");
  }
  return entropy.toString("hex");
}

function validateAcquiredPySparkArtifact(directory, value, distribution) {
  const relativePath = typeof value?.path === "string" ? relative(resolve(directory), value.path) : undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "dispose\0path\0preparePipLaunch\0sha256\0size" ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    /[\0\r\n]/u.test(value.path) ||
    relativePath === undefined ||
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    typeof value.preparePipLaunch !== "function" ||
    typeof value.dispose !== "function" ||
    typeof value.sha256 !== "string" ||
    value.sha256 !== distribution.sha256 ||
    !Number.isSafeInteger(value.size) ||
    value.size !== distribution.size ||
    !value.path.endsWith(`-${distribution.filename}`)
  ) {
    throw new Error("Released-Jupyter PySpark acquisition did not return one bounded local artifact.");
  }
  return value;
}

function downloadedArtifactIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    gid: metadata.gid,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid
  });
}

function sameDownloadedArtifactIdentity(left, right) {
  return sameDownloadedArtifactObject(left, right) && left.nlink === right.nlink;
}

function sameDownloadedArtifactObject(left, right) {
  return (
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function assertVerifiedPySparkArtifact(descriptor, path, identity, receipt) {
  const openedBefore = fstatSync(descriptor, { bigint: true });
  const namedBefore = lstatSync(path, { bigint: true });
  if (
    !openedBefore.isFile() ||
    !namedBefore.isFile() ||
    namedBefore.isSymbolicLink() ||
    openedBefore.nlink !== 1n ||
    namedBefore.nlink !== 1n ||
    openedBefore.size !== BigInt(receipt.size) ||
    namedBefore.size !== BigInt(receipt.size) ||
    !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(openedBefore)) ||
    !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(namedBefore))
  ) {
    throw new Error("Released-Jupyter PySpark artifact identity changed before pip launch.");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, receipt.size));
  let offset = 0;
  while (offset < receipt.size) {
    const requested = Math.min(buffer.length, receipt.size - offset);
    const read = readSync(descriptor, buffer, 0, requested, offset);
    if (read !== requested) {
      throw new Error("Released-Jupyter PySpark artifact ended before its pre-spawn digest completed.");
    }
    digest.update(buffer.subarray(0, read));
    offset += read;
  }
  if (readSync(descriptor, buffer, 0, 1, receipt.size) !== 0 || digest.digest("hex") !== receipt.sha256) {
    throw new Error("Released-Jupyter PySpark artifact bytes changed before pip launch.");
  }
  const openedAfter = fstatSync(descriptor, { bigint: true });
  const namedAfter = lstatSync(path, { bigint: true });
  if (
    openedAfter.size !== BigInt(receipt.size) ||
    namedAfter.size !== BigInt(receipt.size) ||
    !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(openedAfter)) ||
    !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(namedAfter))
  ) {
    throw new Error("Released-Jupyter PySpark artifact changed during its pre-spawn digest.");
  }
}

function scrubIdentifiedPySparkArtifact({
  artifactPath,
  beforeCleanupLink,
  cleanupDirectory,
  cleanupDirectoryIdentity,
  cleanupTarget,
  descriptor,
  identity
}) {
  const opened = fstatSync(descriptor, { bigint: true });
  const current = lstatSync(artifactPath, { bigint: true });
  const quarantine = lstatSync(cleanupDirectory, { bigint: true });
  if (
    !opened.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !quarantine.isDirectory() ||
    quarantine.isSymbolicLink() ||
    opened.nlink !== 1n ||
    current.nlink !== 1n ||
    !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(opened)) ||
    !sameDownloadedArtifactIdentity(identity, downloadedArtifactIdentity(current)) ||
    !sameDownloadedArtifactIdentity(cleanupDirectoryIdentity, downloadedArtifactIdentity(quarantine))
  ) {
    throw new Error("Released-Jupyter PySpark artifact identity changed before cleanup.");
  }
  try {
    lstatSync(cleanupTarget);
    throw new Error("Released-Jupyter PySpark cleanup quarantine target was not absent.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (beforeCleanupLink?.(Object.freeze({ descriptor })) !== undefined) {
    throw new Error("Released-Jupyter PySpark cleanup hook must complete synchronously without a result.");
  }
  linkSync(artifactPath, cleanupTarget);
  const linked = lstatSync(cleanupTarget, { bigint: true });
  const openedLinked = fstatSync(descriptor, { bigint: true });
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    linked.nlink !== 2n ||
    openedLinked.nlink !== 2n ||
    !sameDownloadedArtifactObject(identity, downloadedArtifactIdentity(linked)) ||
    !sameDownloadedArtifactObject(identity, downloadedArtifactIdentity(openedLinked))
  ) {
    throw new Error("Released-Jupyter PySpark cleanup quarantine did not bind the exact artifact.");
  }
  ftruncateSync(descriptor, 0);
  fsyncSync(descriptor);
  const scrubbed = fstatSync(descriptor, { bigint: true });
  const linkedScrubbed = lstatSync(cleanupTarget, { bigint: true });
  if (
    scrubbed.size !== 0n ||
    linkedScrubbed.size !== 0n ||
    scrubbed.nlink !== 2n ||
    linkedScrubbed.nlink !== 2n ||
    !sameDownloadedArtifactObject(identity, downloadedArtifactIdentity(scrubbed)) ||
    !sameDownloadedArtifactObject(identity, downloadedArtifactIdentity(linkedScrubbed))
  ) {
    throw new Error("Released-Jupyter PySpark artifact cleanup could not verify its exact scrubbed inode.");
  }
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
  const kernelProbeWorkingDirectory = resolve(root, "Notebook workspace");
  const kernelBootstrapPath = resolve(root, "kernel-bootstrap.R");
  const kernelBootstrapStagePath = resolve(root, "kernel-bootstrap-stage");
  const kernelDirectory = resolve(dataDir, "kernels", R_ACCEPTANCE_KERNEL_ID);
  for (const path of [
    libraryDir,
    homeDir,
    tempDir,
    dataDir,
    runtimeDir,
    configDir,
    pathDir,
    kernelProbeWorkingDirectory,
    kernelDirectory
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);

  const commandEnvironment = privateRCommandEnvironment(environment, {
    homeDir,
    libraryDir,
    tempDir
  });
  writeFileSync(kernelBootstrapStagePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const kernelBootstrapStageIdentity = ownedRBootstrapStageIdentity(kernelBootstrapStagePath);
  writeFileSync(kernelBootstrapPath, rAcceptanceKernelBootstrap(libraryDir, kernelBootstrapStagePath), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  const kernelEnvironment = {
    HOME: commandEnvironment.HOME,
    USERPROFILE: commandEnvironment.USERPROFILE,
    TMPDIR: commandEnvironment.TMPDIR,
    TMP: commandEnvironment.TMP,
    TEMP: commandEnvironment.TEMP,
    R_USER: commandEnvironment.R_USER,
    R_LIBS_USER: commandEnvironment.R_LIBS_USER
  };

  const kernelSpecPath = resolve(kernelDirectory, "kernel.json");
  writeFileSync(
    kernelSpecPath,
    `${JSON.stringify(
      {
        argv: [canonicalRscript, "--vanilla", kernelBootstrapPath, "{connection_file}"],
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
    1_200_000
  );

  const prepared = Object.freeze({
    root,
    libraryDir,
    kernelId: R_ACCEPTANCE_KERNEL_ID,
    kernelDisplayName: R_ACCEPTANCE_KERNEL_DISPLAY_NAME,
    rExecutable,
    kernelProbeWorkingDirectory,
    kernelBootstrapPath,
    kernelBootstrapStagePath,
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
  rAcceptanceBootstrapReceipts.set(prepared, {
    directoryReceipt,
    stagePath: kernelBootstrapStagePath,
    stageIdentity: kernelBootstrapStageIdentity,
    readinessTokens: undefined
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
    typeof prepared.kernelBootstrapPath !== "string" ||
    !isAbsolute(prepared.kernelBootstrapPath) ||
    typeof prepared.kernelProbeWorkingDirectory !== "string" ||
    !isAbsolute(prepared.kernelProbeWorkingDirectory) ||
    typeof prepared.jupyterEnvironment?.runtimeDir !== "string" ||
    !isAbsolute(prepared.jupyterEnvironment.runtimeDir) ||
    typeof prepared.dependencyProbe?.input?.environment !== "object" ||
    typeof runCommand !== "function"
  ) {
    throw new Error("Released-Jupyter R kernel readiness requires one exact prepared private environment.");
  }
  const receipt = rAcceptanceBootstrapReceipt(prepared);

  const bootstrapMetadata = lstatSync(prepared.kernelBootstrapPath, { bigint: true });
  if (!bootstrapMetadata.isFile() || bootstrapMetadata.isSymbolicLink() || bootstrapMetadata.nlink !== 1n) {
    throw new Error("Released-Jupyter R kernel readiness requires one owned bootstrap file.");
  }
  const canonicalRoot = realpathSync(prepared.root);
  const canonicalBootstrap = realpathSync(prepared.kernelBootstrapPath);
  const bootstrapRelativePath = relative(canonicalRoot, canonicalBootstrap);
  if (
    bootstrapRelativePath.length === 0 ||
    bootstrapRelativePath === ".." ||
    bootstrapRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(bootstrapRelativePath)
  ) {
    throw new Error("Released-Jupyter R kernel bootstrap must stay inside its private environment.");
  }
  const probeWorkingDirectoryMetadata = lstatSync(prepared.kernelProbeWorkingDirectory, { bigint: true });
  if (!probeWorkingDirectoryMetadata.isDirectory() || probeWorkingDirectoryMetadata.isSymbolicLink()) {
    throw new Error("Released-Jupyter R kernel readiness requires one owned probe workspace.");
  }
  const probeEnvironment = Object.freeze({
    ...prepared.dependencyProbe.input.environment,
    JUPYTER_DATA_DIR: prepared.jupyterEnvironment.dataDir,
    JUPYTER_RUNTIME_DIR: prepared.jupyterEnvironment.runtimeDir,
    JUPYTER_CONFIG_DIR: prepared.jupyterEnvironment.configDir,
    JUPYTER_PATH: prepared.jupyterEnvironment.path,
    OPEN_WRANGLER_TEST_RSCRIPT: prepared.jupyterEnvironment.rscriptPath,
    R_LIBS_USER: prepared.jupyterEnvironment.rLibraryDir
  });
  const result = await runCommand(
    {
      executable: python,
      args: [
        "-I",
        "-c",
        R_ACCEPTANCE_KERNEL_PROBE,
        prepared.kernelId,
        prepared.kernelSpecPath,
        resolve(prepared.jupyterEnvironment.runtimeDir, "kernel-readiness.json"),
        prepared.kernelProbeWorkingDirectory
      ],
      environment: probeEnvironment,
      label: "Released-Jupyter private R kernel readiness probe"
    },
    { timeoutMs: 30_000, maxOutputBytes: 1_024 }
  );
  if (result?.stderr !== "") {
    throw new Error("Released-Jupyter R kernel readiness probe returned a malformed fixed result.");
  }
  if (/^OPEN_WRANGLER_R_KERNEL_READY\r?\n$/u.test(result.stdout)) {
    const readinessTokens = readRBootstrapTokens(receipt);
    const requiredPrefix = ["entered", "library-ready", "irkernel-loaded", "main-entered"];
    if (requiredPrefix.some((token, index) => readinessTokens[index] !== token)) {
      const readinessStage = readinessTokens.length === 0 ? "not-entered" : readinessTokens.at(-1);
      throw new Error(
        `Released-Jupyter R kernel readiness did not reach the private IRkernel bootstrap (last stage: ${readinessStage}).`
      );
    }
    receipt.readinessTokens = readinessTokens;
    return;
  }
  const failure = /^OPEN_WRANGLER_R_KERNEL_FAILED:(start|ready|execute|cleanup)\r?\n$/u.exec(result.stdout);
  if (failure) throw new Error(`Released-Jupyter R kernel readiness failed during ${failure[1]}.`);
  throw new Error("Released-Jupyter R kernel readiness probe returned a malformed fixed result.");
}

export function jupyterAcceptanceRKernelBootstrapStage(prepared) {
  const receipt = rAcceptanceBootstrapReceipt(prepared);
  if (!Array.isArray(receipt.readinessTokens)) {
    throw new Error("Released-Jupyter R bootstrap stage requires a completed readiness baseline.");
  }
  const tokens = readRBootstrapTokens(receipt);
  if (
    tokens.length < receipt.readinessTokens.length ||
    receipt.readinessTokens.some((token, index) => tokens[index] !== token)
  ) {
    throw new Error("Released-Jupyter R bootstrap stage no longer matches its readiness baseline.");
  }
  const editorTokens = tokens.slice(receipt.readinessTokens.length);
  return editorTokens.length === 0 ? "not-entered" : editorTokens.at(-1);
}

export function appendJupyterAcceptanceRKernelBootstrapStage(error, stage) {
  if (stage !== "not-entered" && !R_ACCEPTANCE_BOOTSTRAP_STAGES.includes(stage)) {
    throw new Error("Released-Jupyter R bootstrap received an invalid fixed stage.");
  }
  const suffix = `Released-Jupyter R kernel bootstrap: ${stage}.`;
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

function rAcceptanceBootstrapReceipt(prepared) {
  const receipt = rAcceptanceBootstrapReceipts.get(prepared);
  if (!receipt) throw new Error("Released-Jupyter R bootstrap requires its exact prepared environment.");
  assertEditorAcceptancePrivateRootReceipt(receipt.directoryReceipt);
  assertOwnedRBootstrapStageIdentity(receipt.stagePath, receipt.stageIdentity);
  return receipt;
}

function readRBootstrapTokens(receipt) {
  const snapshot = assertOwnedRBootstrapStageIdentity(receipt.stagePath, receipt.stageIdentity);
  const contents = readBoundedAcceptanceText(receipt.stagePath, 1_024, "Released-Jupyter R bootstrap stage", {
    expectedPathSnapshot: snapshot
  });
  if (contents.length === 0) return [];
  const lineEnding = contents.endsWith("\r\n") ? "\r\n" : contents.endsWith("\n") ? "\n" : undefined;
  if (!lineEnding) {
    throw new Error("Released-Jupyter R bootstrap stage contained an invalid fixed value.");
  }
  const withoutLineEndings = contents.replaceAll(lineEnding, "");
  if (withoutLineEndings.includes("\r") || withoutLineEndings.includes("\n")) {
    throw new Error("Released-Jupyter R bootstrap stage contained an invalid fixed value.");
  }
  const tokens = contents.slice(0, -lineEnding.length).split(lineEnding);
  let previous;
  for (const token of tokens) {
    if (!R_ACCEPTANCE_BOOTSTRAP_STAGES.includes(token)) {
      throw new Error("Released-Jupyter R bootstrap stage contained an invalid fixed value.");
    }
    if (token === "entered") {
      previous = token;
      continue;
    }
    const valid =
      (token === "library-ready" && previous === "entered") ||
      (token === "irkernel-loaded" && previous === "library-ready") ||
      (token === "main-entered" && previous === "irkernel-loaded") ||
      ((token === "main-error" || token === "main-returned") && previous === "main-entered");
    if (!valid) throw new Error("Released-Jupyter R bootstrap stage contained an invalid fixed sequence.");
    previous = token;
  }
  return tokens;
}

function ownedRBootstrapStageIdentity(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("Released-Jupyter R bootstrap stage must be one owned regular file.");
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function assertOwnedRBootstrapStageIdentity(path, expected) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino
  ) {
    throw new Error("Released-Jupyter R bootstrap stage lost its owned file identity.");
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

function sameKernelPathSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function captureStandaloneKernelPythonIdentity(python) {
  let invocationSnapshot;
  let canonicalPath;
  let targetSnapshot;
  try {
    invocationSnapshot = lstatSync(python, { bigint: true });
    canonicalPath = realpathSync(python);
    targetSnapshot = lstatSync(canonicalPath, { bigint: true });
  } catch {
    throw new Error("Quarto Python acceptance requires an existing regular-file interpreter.");
  }
  if (
    (!invocationSnapshot.isFile() && !invocationSnapshot.isSymbolicLink()) ||
    !targetSnapshot.isFile() ||
    targetSnapshot.isSymbolicLink()
  ) {
    throw new Error("Quarto Python acceptance requires an existing regular-file interpreter.");
  }
  return Object.freeze({ python, canonicalPath, invocationSnapshot, targetSnapshot });
}

function captureKernelPythonIdentity(python, directoryReceipt) {
  const relativePython = relative(directoryReceipt.path, resolve(python));
  if (
    relativePython.length === 0 ||
    relativePython === ".." ||
    relativePython.startsWith(`..${sep}`) ||
    isAbsolute(relativePython)
  ) {
    throw new Error("A private Jupyter kernel interpreter must stay inside its owned environment path.");
  }
  return captureStandaloneKernelPythonIdentity(python);
}

function assertKernelPythonIdentity(identity) {
  let invocationSnapshot;
  let canonicalPath;
  let targetSnapshot;
  try {
    invocationSnapshot = lstatSync(identity.python, { bigint: true });
    canonicalPath = realpathSync(identity.python);
    targetSnapshot = lstatSync(canonicalPath, { bigint: true });
  } catch {
    throw new Error("Quarto Python private kernel interpreter identity changed.");
  }
  if (
    canonicalPath !== identity.canonicalPath ||
    !sameKernelPathSnapshot(invocationSnapshot, identity.invocationSnapshot) ||
    !sameKernelPathSnapshot(targetSnapshot, identity.targetSnapshot)
  ) {
    throw new Error("Quarto Python private kernel interpreter identity changed.");
  }
}

function captureOwnedFileIdentity(path, description) {
  let snapshot;
  let canonicalPath;
  try {
    snapshot = lstatSync(path, { bigint: true });
    canonicalPath = realpathSync(path);
  } catch {
    throw new Error(`The ${description} lost its owned file identity.`);
  }
  if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.nlink !== 1n) {
    throw new Error(`The ${description} lost its owned file identity.`);
  }
  return Object.freeze({ canonicalPath, snapshot });
}

function assertOwnedFileIdentity(path, identity, description) {
  const current = captureOwnedFileIdentity(path, description);
  if (
    current.canonicalPath !== identity.canonicalPath ||
    !sameKernelPathSnapshot(current.snapshot, identity.snapshot)
  ) {
    throw new Error(`The ${description} lost its owned file identity.`);
  }
}

export function addJupyterAcceptancePythonKernel(prepared, python) {
  if (
    typeof python !== "string" ||
    !isAbsolute(python) ||
    /[\0\r\n]/u.test(python) ||
    prepared?.kernelId !== R_ACCEPTANCE_KERNEL_ID ||
    typeof prepared.root !== "string" ||
    !isAbsolute(prepared.root) ||
    typeof prepared.jupyterEnvironment?.dataDir !== "string" ||
    !isAbsolute(prepared.jupyterEnvironment.dataDir)
  ) {
    throw new Error("Quarto Python acceptance requires one exact prepared private R environment and interpreter.");
  }
  const receipt = rAcceptanceBootstrapReceipt(prepared);
  const privatePythonReceipt = jupyterAcceptanceKernelPythonReceipts.get(python);
  if (privatePythonReceipt) jupyterAcceptanceKernelPythonReceipts.delete(python);
  assertEditorAcceptancePrivateRootReceipt(receipt.directoryReceipt);

  try {
    const resolvedPython = realpathSync(python);
    const pythonMetadata = lstatSync(resolvedPython, { bigint: true });
    if (!pythonMetadata.isFile() || pythonMetadata.isSymbolicLink()) throw new Error("invalid interpreter");
  } catch {
    throw new Error("Quarto Python acceptance requires an existing regular-file interpreter.");
  }

  const canonicalRoot = realpathSync(prepared.root);
  const canonicalDataDir = realpathSync(prepared.jupyterEnvironment.dataDir);
  const dataRelativePath = relative(canonicalRoot, canonicalDataDir);
  if (
    dataRelativePath.length === 0 ||
    dataRelativePath === ".." ||
    dataRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(dataRelativePath)
  ) {
    throw new Error("The Quarto Python kernelspec must stay inside its prepared private R environment.");
  }
  const dataMetadata = lstatSync(canonicalDataDir, { bigint: true });
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) {
    throw new Error("The Quarto Python kernelspec requires one owned Jupyter data directory.");
  }

  const kernelsDirectory = resolve(canonicalDataDir, "kernels");
  const kernelDirectory = resolve(kernelsDirectory, QUARTO_PYTHON_ACCEPTANCE_KERNEL_ID);
  const ipythonDir = resolve(canonicalDataDir, "python-ipython");
  const kernelsMetadata = lstatSync(kernelsDirectory, { bigint: true });
  if (!kernelsMetadata.isDirectory() || kernelsMetadata.isSymbolicLink()) {
    throw new Error("The Quarto Python kernelspec requires one owned kernels directory.");
  }
  mkdirSync(ipythonDir, { recursive: false, mode: 0o700 });
  mkdirSync(kernelDirectory, { recursive: false, mode: 0o700 });
  const kernelSpecPath = resolve(kernelDirectory, "kernel.json");
  writeFileSync(
    kernelSpecPath,
    `${JSON.stringify(
      {
        argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name: QUARTO_PYTHON_ACCEPTANCE_KERNEL_DISPLAY_NAME,
        language: "python",
        metadata: { debugger: false },
        env: { IPYTHONDIR: ipythonDir }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  assertEditorAcceptancePrivateRootReceipt(receipt.directoryReceipt);
  const added = Object.freeze({
    id: QUARTO_PYTHON_ACCEPTANCE_KERNEL_ID,
    displayName: QUARTO_PYTHON_ACCEPTANCE_KERNEL_DISPLAY_NAME,
    kernelSpecPath,
    ipythonDir
  });
  quartoPythonKernelReceipts.set(
    added,
    Object.freeze({
      prepared,
      python,
      pythonIdentity: captureStandaloneKernelPythonIdentity(python),
      privatePythonReceipt,
      kernelSpecIdentity: captureOwnedFileIdentity(kernelSpecPath, "Quarto Python kernelspec")
    })
  );
  return added;
}

export async function probeJupyterAcceptanceQuartoPythonKernel(
  prepared,
  added,
  { runCommand = runBoundedEditorCommand } = {}
) {
  if (
    prepared?.kernelId !== R_ACCEPTANCE_KERNEL_ID ||
    added?.id !== QUARTO_PYTHON_ACCEPTANCE_KERNEL_ID ||
    typeof added.kernelSpecPath !== "string" ||
    !isAbsolute(added.kernelSpecPath) ||
    typeof prepared.kernelProbeWorkingDirectory !== "string" ||
    !isAbsolute(prepared.kernelProbeWorkingDirectory) ||
    typeof prepared.jupyterEnvironment?.runtimeDir !== "string" ||
    !isAbsolute(prepared.jupyterEnvironment.runtimeDir) ||
    typeof prepared.dependencyProbe?.input?.environment !== "object" ||
    typeof runCommand !== "function"
  ) {
    throw new Error("Quarto Python kernel readiness requires one exact prepared private environment and kernelspec.");
  }
  const kernelReceipt = quartoPythonKernelReceipts.get(added);
  if (!kernelReceipt || kernelReceipt.prepared !== prepared) {
    throw new Error("Quarto Python kernel readiness requires the exact returned private kernelspec.");
  }
  if (!kernelReceipt.privatePythonReceipt) {
    throw new Error("Quarto Python kernel readiness requires its dedicated private core interpreter.");
  }
  const connectionFile = resolve(prepared.jupyterEnvironment.runtimeDir, "python-kernel-readiness.json");

  const assertReadinessIdentity = () => {
    rAcceptanceBootstrapReceipt(prepared);
    assertEditorAcceptancePrivateRootReceipt(kernelReceipt.privatePythonReceipt.directoryReceipt);
    assertKernelPythonIdentity(kernelReceipt.privatePythonReceipt.identity);
    assertKernelPythonIdentity(kernelReceipt.pythonIdentity);
    assertOwnedFileIdentity(added.kernelSpecPath, kernelReceipt.kernelSpecIdentity, "Quarto Python kernelspec");
    const expectedKernelSpec = {
      argv: [kernelReceipt.python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
      display_name: QUARTO_PYTHON_ACCEPTANCE_KERNEL_DISPLAY_NAME,
      language: "python",
      metadata: { debugger: false },
      env: { IPYTHONDIR: added.ipythonDir }
    };
    let kernelSpec;
    try {
      kernelSpec = JSON.parse(
        readBoundedAcceptanceText(added.kernelSpecPath, 4_096, "Quarto Python kernelspec", {
          expectedPathSnapshot: kernelReceipt.kernelSpecIdentity.snapshot
        })
      );
    } catch (error) {
      throw new Error("Quarto Python kernel readiness could not validate its exact private kernelspec.", {
        cause: error
      });
    }
    if (JSON.stringify(kernelSpec) !== JSON.stringify(expectedKernelSpec)) {
      throw new Error("Quarto Python kernel readiness requires its unchanged exact private kernelspec.");
    }
  };
  const assertConnectionTargetAbsent = () => {
    try {
      lstatSync(connectionFile);
      throw new Error("Quarto Python kernel readiness requires an absent private connection-file target.");
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  };
  assertReadinessIdentity();
  assertConnectionTargetAbsent();

  const probeEnvironment = Object.freeze({
    ...prepared.dependencyProbe.input.environment,
    JUPYTER_DATA_DIR: prepared.jupyterEnvironment.dataDir,
    JUPYTER_RUNTIME_DIR: prepared.jupyterEnvironment.runtimeDir,
    JUPYTER_CONFIG_DIR: prepared.jupyterEnvironment.configDir,
    JUPYTER_PATH: prepared.jupyterEnvironment.path
  });
  const result = await runCommand(
    {
      executable: kernelReceipt.python,
      args: [
        "-I",
        "-c",
        QUARTO_PYTHON_ACCEPTANCE_KERNEL_PROBE,
        added.id,
        added.kernelSpecPath,
        connectionFile,
        prepared.kernelProbeWorkingDirectory
      ],
      environment: probeEnvironment,
      label: "Quarto Python private kernel readiness probe",
      beforeSpawnCheck() {
        assertReadinessIdentity();
        assertConnectionTargetAbsent();
      }
    },
    { timeoutMs: 30_000, maxOutputBytes: 1_024 }
  );
  assertReadinessIdentity();
  if (result?.stderr !== "") {
    throw new Error("Quarto Python kernel readiness probe returned a malformed fixed result.");
  }
  if (/^OPEN_WRANGLER_QUARTO_PYTHON_KERNEL_READY\r?\n$/u.test(result.stdout)) {
    assertConnectionTargetAbsent();
    return;
  }
  const failure = /^OPEN_WRANGLER_QUARTO_PYTHON_KERNEL_FAILED:(start|execute|cleanup)\r?\n$/u.exec(result.stdout);
  if (failure) {
    if (failure[1] !== "cleanup") assertConnectionTargetAbsent();
    throw new Error(`Quarto Python kernel readiness failed during ${failure[1]}.`);
  }
  throw new Error("Quarto Python kernel readiness probe returned a malformed fixed result.");
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
    requireJupyterClient = false,
    requireRuntimeAbsent = true,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (
    typeof requirePySpark !== "boolean" ||
    typeof requireJupyterClient !== "boolean" ||
    typeof requireRuntimeAbsent !== "boolean"
  ) {
    throw new Error(
      "Released-Jupyter Python dependency probing requires explicit PySpark, Jupyter-client, and runtime-absence policies."
    );
  }
  const dependencies = [
    ...(requirePySpark ? DEPENDENCIES : DEPENDENCIES.filter((dependency) => dependency !== "pyspark")),
    ...(requireJupyterClient ? ["jupyter-client"] : [])
  ];
  const probe = [
    "import importlib.metadata",
    "import importlib.util",
    "import json",
    "import ipykernel",
    ...(requireJupyterClient ? ["import jupyter_client"] : []),
    "import pandas",
    "import polars",
    "import duckdb",
    "import fsspec",
    ...(requirePySpark ? ["import pyspark"] : []),
    "print(json.dumps({",
    '  "ipykernel": importlib.metadata.version("ipykernel"),',
    ...(requireJupyterClient ? ['  "jupyter-client": importlib.metadata.version("jupyter-client"),'] : []),
    '  "pandas": importlib.metadata.version("pandas"),',
    '  "polars": importlib.metadata.version("polars"),',
    '  "duckdb": importlib.metadata.version("duckdb"),',
    '  "fsspec": importlib.metadata.version("fsspec"),',
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
