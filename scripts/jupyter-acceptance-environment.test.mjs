import assert from "node:assert/strict";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { chmod, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { editorProcessTreeMayBeLive, runBoundedEditorCommand } from "./editor-acceptance.mjs";
import {
  R_ACCEPTANCE_PACKAGE_VERSIONS,
  acceptancePythonForPhase,
  addJupyterAcceptancePythonKernel,
  appendJupyterAcceptanceRKernelBootstrapStage,
  createJupyterAcceptanceCoreKernelPython,
  createRemoteJupyterAcceptanceToken,
  createJupyterAcceptanceKernelPython,
  jupyterAcceptanceRKernelBootstrapStage,
  prepareJupyterAcceptanceREnvironment,
  probeJupyterAcceptanceQuartoPythonKernel,
  probeJupyterAcceptanceRKernel,
  probeJupyterAcceptanceJava,
  probeJupyterAcceptancePython,
  rAcceptanceRepositories,
  writeJupyterAcceptanceEnvironment,
  writeRemoteJupyterAcceptanceDescriptor,
  writeRemoteJupyterAcceptanceEnvironment
} from "./jupyter-acceptance-environment.mjs";

const dependencyReport = (openwranglerRuntimePresent, overrides = {}) => ({
  ipykernel: "6.30.1",
  "jupyter-client": "8.9.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  duckdb: "1.5.4",
  fsspec: "2026.7.0",
  pyspark: "4.2.0",
  openwranglerRuntimePresent,
  ...overrides
});
const javaReport = (specificationVersion = "17", version = "17.0.19") => ({
  stdout: "",
  stderr:
    `Property settings:\n    java.specification.version = ${specificationVersion}\n` +
    `    java.version = ${version}\nopenjdk version "${version}"\n`
});
const coreDependencyReport = (openwranglerRuntimePresent, overrides = {}) => ({
  ipykernel: "6.30.1",
  "jupyter-client": "8.9.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  duckdb: "1.5.4",
  fsspec: "2026.7.0",
  openwranglerRuntimePresent,
  ...overrides
});

async function createTestQuartoCoreKernel(
  directory,
  { finalReport = coreDependencyReport(false), commands = [] } = {}
) {
  const basePython = join(directory, "base-python");
  const environmentDirectory = join(directory, "private-core-kernel");
  await writeFile(basePython, "test interpreter placeholder\n");
  const python = await createJupyterAcceptanceCoreKernelPython(environmentDirectory, basePython, {
    containedBy: directory,
    environment: Object.freeze({ PATH: "/bounded-core-path" }),
    platform: "linux",
    async runCommand(input, options) {
      commands.push({ input, options });
      if (input.label === "Quarto Python base dependency version probe") {
        return { stdout: JSON.stringify(coreDependencyReport(true, { pandas: "3.0.5" })) };
      }
      if (input.label === "Quarto Python private kernel environment creation") {
        mkdirSync(join(input.args.at(-1), "bin"), { recursive: true });
        writeFileSync(join(input.args.at(-1), "bin", "python"), "private interpreter placeholder\n");
        return { stdout: "" };
      }
      if (input.label === "Quarto Python private kernel dependency installation") return { stdout: "" };
      if (input.label === "Quarto Python private kernel dependency probe") {
        return { stdout: JSON.stringify(finalReport) };
      }
      assert.fail(`Unexpected Quarto core command: ${input.label}`);
    }
  });
  return { basePython, environmentDirectory, python };
}

function assertOwnedDirectKernelLauncher(script) {
  assert.match(script, /jupyter_client_version != "8\.9\.1"/u);
  assert.match(script, /from jupyter_client\.blocking\.client import BlockingKernelClient/u);
  assert.match(script, /from jupyter_client\.connect import write_connection_file/u);
  assert.match(script, /command\[1:\] != \["-I", "-m", "ipykernel_launcher", "-f", connection_file\]/u);
  assert.match(script, /os\.path\.samefile\(command\[0\], sys\.executable\)/u);
  assert.match(script, /connection_key = os\.urandom\(32\)\.hex\(\)\.encode\("ascii"\)/u);
  assert.match(
    script,
    /write_connection_file\([\s\S]+fname=connection_file, ip="127\.0\.0\.1", key=connection_key, kernel_name=kernel_id/u
  );
  assert.match(script, /not stat\.S_ISREG\(connection_stat\.st_mode\) or connection_stat\.st_nlink != 1/u);
  assert.match(script, /if os\.name == "posix" and connection_stat\.st_mode & 0o777 != 0o600/u);
  assert.match(
    script,
    /process = subprocess\.Popen\([\s\S]+stdin=subprocess\.DEVNULL,[\s\S]+close_fds=True,[\s\S]+start_new_session=False,[\s\S]+creationflags=0/u,
    "The direct kernel must remain inside the outer process group or Windows Job Object."
  );
  assert.match(script, /os\.getpgid\(process\.pid\) != os\.getpgrp\(\)/u);
  assert.match(script, /BlockingKernelClient\(\); client\.load_connection_info\(connection_info\)/u);
  assert.match(script, /process\.terminate\(\)/u);
  assert.match(script, /process\.wait\(timeout=2\)/u);
  assert.match(script, /process\.kill\(\); process\.wait\(timeout=2\)/u);
  assert.match(script, /current_identity != connection_identity/u);
  assert.match(script, /os\.unlink\(connection_file\)/u);
  assert.match(script, /if cleanup_failed:[\s\S]+stage, succeeded = "cleanup", False/u);
  assert.doesNotMatch(script, /start_new_session=True|CREATE_BREAKAWAY_FROM_JOB/u);
  assert.doesNotMatch(script, /KernelManager|LocalProvisioner|shutdown_kernel|killpg|os\.kill\(/u);
}

test("released-Jupyter R setup selects dated repositories for each supported platform", () => {
  assert.deepEqual(rAcceptanceRepositories("linux"), {
    repository: "https://p3m.dev/cran/__linux__/noble/2026-03-10",
    supplementalRepository: "https://p3m.dev/cran/__linux__/noble/2026-06-01"
  });
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(rAcceptanceRepositories(platform), {
      repository: "https://p3m.dev/cran/2026-03-10",
      supplementalRepository: "https://p3m.dev/cran/2026-06-01"
    });
  }
  assert.throws(() => rAcceptanceRepositories("freebsd"), /does not support "freebsd"/u);
});

test("remote Jupyter tokens use one fixed redaction-friendly high-entropy shape", () => {
  const requested = [];
  const token = createRemoteJupyterAcceptanceToken((length) => {
    requested.push(length);
    return Buffer.alloc(length, 0xab);
  });
  assert.deepEqual(requested, [30]);
  assert.match(token, /^owr_[A-Za-z0-9_-]{39}$/u);
  assert.equal(token.length, 43);
  assert.throws(() => createRemoteJupyterAcceptanceToken(() => Buffer.alloc(29)), /exact private-token entropy/u);
});

test("released-Jupyter PySpark Java probing reports supported versions and rejects older or malformed runtimes", async () => {
  const environment = Object.freeze({ PATH: "/bounded-java-path" });
  const supported = await probeJupyterAcceptanceJava({
    environment,
    async runCommand(input, options) {
      assert.equal(input.executable, "java");
      assert.deepEqual(input.args, ["-XshowSettings:properties", "-version"]);
      assert.equal(input.environment, environment);
      assert.deepEqual(options, { timeoutMs: 30_000 });
      return javaReport("21", "21.0.7+6");
    }
  });
  assert.deepEqual(supported, { major: 21, version: "21.0.7+6" });

  await assert.rejects(
    probeJupyterAcceptanceJava({
      environment,
      async runCommand() {
        return javaReport("11", "11.0.31");
      }
    }),
    /requires Java 17 or newer; detected Java 11\.0\.31 \(major 11\)/u
  );
  await assert.rejects(
    probeJupyterAcceptanceJava({
      environment,
      async runCommand() {
        return { stdout: "", stderr: 'openjdk version "17.0.19"\n' };
      }
    }),
    /did not report one java\.specification\.version property/u
  );
  await assert.rejects(
    probeJupyterAcceptanceJava({
      environment,
      async runCommand() {
        throw new Error("private command detail");
      }
    }),
    /requires Java 17 or newer, but the Java compatibility probe failed/u
  );
});

test("released-Jupyter phases alone receive the dedicated kernel interpreter", () => {
  const normalPython = join(tmpdir(), "normal-python");
  const kernelPython = join(tmpdir(), "released-jupyter-python");

  assert.equal(acceptancePythonForPhase("restricted", normalPython, kernelPython), normalPython);
  assert.equal(acceptancePythonForPhase("python-environment", normalPython, kernelPython), normalPython);
  assert.equal(acceptancePythonForPhase("seed", normalPython, kernelPython), normalPython);
  assert.equal(acceptancePythonForPhase("verify", normalPython, kernelPython), normalPython);
  assert.equal(acceptancePythonForPhase("jupyter-deny", normalPython, kernelPython), kernelPython);
  assert.equal(acceptancePythonForPhase("jupyter-allow", normalPython, kernelPython), kernelPython);
  assert.equal(acceptancePythonForPhase("jupyter-pyspark", normalPython, kernelPython), kernelPython);
  for (const phase of [
    "jupyter-coexist-open-select",
    "jupyter-coexist-open-restart",
    "jupyter-coexist-data-select",
    "jupyter-coexist-data-restart"
  ]) {
    assert.equal(acceptancePythonForPhase(phase, normalPython, kernelPython), kernelPython);
  }
  assert.equal(acceptancePythonForPhase("jupyter-remote", normalPython, kernelPython), normalPython);
  assert.equal(acceptancePythonForPhase("jupyter-r", normalPython, kernelPython), normalPython);
  assert.equal(acceptancePythonForPhase("jupyter-r-remote", normalPython, kernelPython), normalPython);
  assert.throws(
    () => acceptancePythonForPhase("jupyter-allow", normalPython, undefined),
    /dedicated private kernel interpreter/u
  );
});

test("released-Jupyter R setup stays private and returns immutable probe and install commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-"));
  const rscript = join(directory, "exact Rscript");
  const rExecutable = join(directory, "exact R");
  const privateRoot = join(directory, "private-r");
  const inheritedEnvironment = Object.freeze({
    PATH: "/bounded-r-path",
    LANG: "C.UTF-8",
    R_HOME: "/global/r-home",
    R_LIBS_USER: "/global/r-library",
    R_PROFILE_USER: "/global/r-profile"
  });
  const previousRLibrary = process.env.R_LIBS_USER;
  const selectedRepositories = rAcceptanceRepositories("darwin");
  try {
    await writeFile(rscript, "fake Rscript executable\n");
    await writeFile(rExecutable, "fake R executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    const matchingRProbes = [];
    const prepared = await prepareJupyterAcceptanceREnvironment(privateRoot, rscript, {
      containedBy: directory,
      environment: inheritedEnvironment,
      platform: "darwin",
      async runCommand(input, options) {
        assert.equal(existsSync(privateRoot), false);
        matchingRProbes.push({ input, options });
        return { stdout: rExecutable, stderr: "" };
      }
    });

    assert.equal(prepared.root, privateRoot);
    assert.equal(prepared.libraryDir, join(privateRoot, "l"));
    assert.equal(prepared.kernelId, "openwrangler-r-acceptance");
    assert.equal(prepared.kernelDisplayName, "R (Open Wrangler)");
    assert.equal(prepared.rExecutable, rExecutable);
    assert.equal(prepared.kernelProbeWorkingDirectory, join(privateRoot, "Notebook workspace"));
    assert.equal(prepared.kernelBootstrapStagePath, join(privateRoot, "kernel-bootstrap-stage"));
    assert.deepEqual(prepared.packages, [
      "IRkernel",
      "jsonlite",
      "rlang",
      "Rcpp",
      "languageserver",
      "rmarkdown",
      "knitr",
      "tibble",
      "data.table",
      "collapse",
      "nanoparquet"
    ]);
    assert.deepEqual(prepared.packageVersions, R_ACCEPTANCE_PACKAGE_VERSIONS);
    assert.equal(prepared.repository, selectedRepositories.repository);
    assert.equal(prepared.supplementalRepository, selectedRepositories.supplementalRepository);
    assert.equal(
      prepared.packageRecord,
      "IRkernel=1.3.2\njsonlite=2.0.0\nrlang=1.1.7\nRcpp=1.1.1\nlanguageserver=0.3.17\nrmarkdown=2.30\nknitr=1.51\ntibble=3.3.1\ndata.table=1.18.2.1\ncollapse=2.1.7\nnanoparquet=0.5.1"
    );
    assert.deepEqual(prepared.jupyterEnvironment, {
      dataDir: join(privateRoot, "d"),
      runtimeDir: join(privateRoot, "r"),
      configDir: join(privateRoot, "c"),
      path: join(privateRoot, "p"),
      rscriptPath: rscript,
      rLibraryDir: join(privateRoot, "l")
    });
    for (const path of [
      prepared.root,
      prepared.libraryDir,
      prepared.jupyterEnvironment.dataDir,
      prepared.jupyterEnvironment.runtimeDir,
      prepared.jupyterEnvironment.configDir,
      prepared.jupyterEnvironment.path,
      prepared.jupyterEnvironment.rLibraryDir,
      prepared.kernelProbeWorkingDirectory,
      join(privateRoot, "h"),
      join(privateRoot, "t")
    ]) {
      assert.equal(existsSync(path), true);
      assert.equal(statSync(path).isDirectory(), true);
      assert.equal(statSync(path).mode & 0o777, 0o700);
    }
    const bootstrap = await readFile(prepared.kernelBootstrapPath, "utf8");
    assert.match(bootstrap, /\.libPaths\(unique\(c\(\.ow_library, \.libPaths\(\)\)\)\)/u);
    assert.match(bootstrap, /identical\(normalizePath\(\.libPaths\(\)\[\[1L\]\]/u);
    assert.match(bootstrap, /loadNamespace\("IRkernel", lib\.loc = \.ow_library\)/u);
    assert.match(bootstrap, /get\("main", envir = \.ow_namespace, inherits = FALSE\)\(\)/u);
    for (const stage of [
      "entered",
      "library-ready",
      "irkernel-loaded",
      "main-entered",
      "main-error",
      "main-returned"
    ]) {
      assert.match(bootstrap, new RegExp(`\\.ow_stage\\("${stage}"\\)`, "u"));
    }
    assert.equal(statSync(prepared.kernelBootstrapPath).mode & 0o777, 0o600);
    assert.equal(await readFile(prepared.kernelBootstrapStagePath, "utf8"), "");
    assert.equal(statSync(prepared.kernelBootstrapStagePath).mode & 0o777, 0o600);

    const kernelSpec = JSON.parse(await readFile(prepared.kernelSpecPath, "utf8"));
    assert.deepEqual(kernelSpec, {
      argv: [rscript, "--vanilla", prepared.kernelBootstrapPath, "{connection_file}"],
      display_name: "R (Open Wrangler)",
      language: "R",
      env: {
        HOME: join(privateRoot, "h"),
        USERPROFILE: join(privateRoot, "h"),
        TMPDIR: join(privateRoot, "t"),
        TMP: join(privateRoot, "t"),
        TEMP: join(privateRoot, "t"),
        R_USER: join(privateRoot, "h"),
        R_LIBS_USER: prepared.libraryDir
      }
    });
    assert.equal(kernelSpec.argv.at(-1), "{connection_file}");
    assert.equal(kernelSpec.argv.filter((value) => value === "{connection_file}").length, 1);
    assert.equal(kernelSpec.argv[0], rscript);
    assert.equal(kernelSpec.argv.includes("--vanilla"), true);
    assert.equal(kernelSpec.argv.includes("--no-init-file"), false);
    assert.equal(kernelSpec.argv.includes("--args"), false);
    assert.equal(statSync(prepared.kernelSpecPath).mode & 0o777, 0o600);

    assert.equal(matchingRProbes.length, 1);
    assert.equal(matchingRProbes[0].input.executable, rscript);
    assert.deepEqual(matchingRProbes[0].input.args.slice(0, 2), ["--vanilla", "-e"]);
    assert.match(matchingRProbes[0].input.args.at(-1), /R\.home\("bin"\)/u);
    assert.doesNotMatch(matchingRProbes[0].input.args.at(-1), /IRkernel::main/u);
    assert.equal(matchingRProbes[0].input.environment.PATH, inheritedEnvironment.PATH);
    assert.equal(matchingRProbes[0].input.environment.LANG, inheritedEnvironment.LANG);
    assert.equal(matchingRProbes[0].input.environment.R_HOME, undefined);
    assert.equal(matchingRProbes[0].input.environment.R_LIBS_USER, undefined);
    assert.equal(matchingRProbes[0].input.environment.R_PROFILE_USER, undefined);
    assert.deepEqual(matchingRProbes[0].options, { timeoutMs: 300_000 });

    for (const invocation of [prepared.dependencyProbe, prepared.dependencyInstall]) {
      assert.equal(invocation.input.executable, rscript);
      assert.deepEqual(invocation.input.args.slice(0, 2), ["--vanilla", "-e"]);
      assert.equal(invocation.input.environment.PATH, inheritedEnvironment.PATH);
      assert.equal(invocation.input.environment.LANG, inheritedEnvironment.LANG);
      assert.equal(invocation.input.environment.R_HOME, undefined);
      assert.equal(invocation.input.environment.R_PROFILE_USER, undefined);
      assert.equal(invocation.input.environment.R_LIBS_USER, prepared.libraryDir);
      assert.equal(invocation.input.environment.R_USER, join(privateRoot, "h"));
      assert.equal(invocation.input.environment.HOME, join(privateRoot, "h"));
      assert.equal(invocation.input.environment.USERPROFILE, join(privateRoot, "h"));
      assert.equal(invocation.input.environment.TMPDIR, join(privateRoot, "t"));
      assert.equal(invocation.input.environment.TMP, join(privateRoot, "t"));
      assert.equal(invocation.input.environment.TEMP, join(privateRoot, "t"));
      assert.equal(Object.isFrozen(invocation), true);
      assert.equal(Object.isFrozen(invocation.input), true);
      assert.equal(Object.isFrozen(invocation.input.args), true);
      assert.equal(Object.isFrozen(invocation.input.environment), true);
      assert.equal(Object.isFrozen(invocation.options), true);
      for (const packageName of prepared.packages) {
        assert.match(invocation.input.args.at(-1), new RegExp(`"${packageName.replace(".", "\\.")}"`, "u"));
      }
    }
    assert.match(prepared.dependencyProbe.input.args.at(-1), /find\.package\(.+lib\.loc = \.ow_library/su);
    assert.match(prepared.dependencyProbe.input.args.at(-1), /packageVersion\(.+lib\.loc = \.ow_library/su);
    assert.match(prepared.dependencyProbe.input.args.at(-1), /loadNamespace\(.+lib\.loc = \.ow_library/su);
    for (const [packageName, version] of Object.entries(R_ACCEPTANCE_PACKAGE_VERSIONS)) {
      assert.match(
        prepared.dependencyProbe.input.args.at(-1),
        new RegExp(`"${packageName.replace(".", "\\.")}" = "${version.replaceAll(".", "\\.")}"`, "u")
      );
    }
    assert.match(prepared.dependencyProbe.input.args.at(-1), /status = 11L/u);
    assert.match(prepared.dependencyProbe.input.args.at(-1), /status = 12L/u);
    assert.match(prepared.dependencyProbe.input.args.at(-1), /OPEN_WRANGLER_R_COLLAPSE_PROBE:/u);
    assert.match(prepared.dependencyProbe.input.args.at(-1), /\.ow_row_count <- 1205L/u);
    assert.match(prepared.dependencyProbe.input.args.at(-1), /seq_len\(20L\)/u);
    for (const [constructor, status] of [
      ["qDF", 13],
      ["qTBL", 14],
      ["qDT", 15],
      ["fgroup_by", 16],
      ["findex_by", 17]
    ]) {
      assert.match(prepared.dependencyProbe.input.args.at(-1), new RegExp(`collapse::${constructor}\\(`, "u"));
      assert.match(prepared.dependencyProbe.input.args.at(-1), new RegExp(`status = ${status}L`, "u"));
    }
    assert.equal(
      (prepared.dependencyProbe.input.args.at(-1).match(/suppressMessages\(suppressWarnings\(/gu) ?? []).length,
      5
    );
    assert.equal(
      (prepared.dependencyProbe.input.args.at(-1).match(/error = function\(\.\.\.\) NULL/gu) ?? []).length,
      5
    );
    assert.equal(
      prepared.dependencyProbe.input.args
        .at(-1)
        .endsWith('cat(paste(.ow_packages, .ow_versions, sep = "=", collapse = "\\n"), sep = "")'),
      true
    );
    assert.deepEqual(prepared.dependencyProbe.options, { timeoutMs: 30_000 });
    assert.equal(prepared.dependencyInstall.input.args.at(-1).includes(selectedRepositories.repository), true);
    assert.equal(
      prepared.dependencyInstall.input.args.at(-1).includes(selectedRepositories.supplementalRepository),
      true
    );
    assert.equal(prepared.dependencyInstall.input.args.at(-1).includes("/__linux__/"), false);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /c\("collapse", "nanoparquet"\)/u);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /setdiff\(\.ow_packages, \.ow_supplemental_packages\)/u);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /"Rcpp"/u);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /\.ow_binary_supplemental_packages <- "nanoparquet"/u);
    assert.match(
      prepared.dependencyInstall.input.args.at(-1),
      /install\.packages\(\n {2}"collapse",\n {2}lib = \.ow_library,[\s\S]+type = "source"/u
    );
    assert.match(prepared.dependencyInstall.input.args.at(-1), /repos = "[^"]+2026-06-01"/u);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /lib = \.ow_library/u);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /dependencies = NA/u);
    assert.match(prepared.dependencyInstall.input.args.at(-1), /MAKEFLAGS = "-s"/u);
    assert.equal((prepared.dependencyInstall.input.args.at(-1).match(/quiet = TRUE/gu) ?? []).length, 3);
    assert.deepEqual(prepared.dependencyInstall.options, { timeoutMs: 1_200_000 });
    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(Object.isFrozen(prepared.packages), true);
    assert.equal(Object.isFrozen(prepared.packageVersions), true);
    assert.equal(Object.isFrozen(prepared.jupyterEnvironment), true);
    assert.equal(process.env.R_LIBS_USER, previousRLibrary);
    assert.deepEqual(inheritedEnvironment, {
      PATH: "/bounded-r-path",
      LANG: "C.UTF-8",
      R_HOME: "/global/r-home",
      R_LIBS_USER: "/global/r-library",
      R_PROFILE_USER: "/global/r-profile"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quarto Python acceptance adds one private kernelspec to the prepared R environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-quarto-python-"));
  const python = join(directory, "python");
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    for (const executable of [python, rscript, rExecutable]) {
      await writeFile(executable, "fake executable\n");
      await chmod(executable, 0o700);
    }
    const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, "r"), rscript, {
      containedBy: directory,
      environment: Object.freeze({ PATH: "/safe" }),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });

    const added = addJupyterAcceptancePythonKernel(prepared, python);
    assert.deepEqual(added, {
      id: "python3",
      displayName: "Python (Open Wrangler Quarto)",
      kernelSpecPath: join(prepared.jupyterEnvironment.dataDir, "kernels", "python3", "kernel.json"),
      ipythonDir: join(prepared.jupyterEnvironment.dataDir, "python-ipython")
    });
    assert.equal(Object.isFrozen(added), true);
    assert.equal(statSync(added.ipythonDir).mode & 0o777, 0o700);
    const kernelSpec = await open(added.kernelSpecPath, "r");
    try {
      assert.equal((await kernelSpec.stat()).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await kernelSpec.readFile("utf8")), {
        argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name: "Python (Open Wrangler Quarto)",
        language: "python",
        metadata: { debugger: false },
        env: { IPYTHONDIR: added.ipythonDir }
      });
    } finally {
      await kernelSpec.close();
    }
    assert.equal(existsSync(prepared.kernelSpecPath), true, "Adding Python must retain the exact R kernelspec.");
    assert.throws(
      () => addJupyterAcceptancePythonKernel(prepared, python),
      /EEXIST/u,
      "The prepared environment must accept the Python kernelspec only once."
    );
    assert.throws(() => addJupyterAcceptancePythonKernel({ ...prepared }, python), /exact prepared environment/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "Quarto Python acceptance preserves a virtual-environment interpreter symlink",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-quarto-venv-"));
    const resolvedPython = join(directory, "python-real");
    const venvBin = join(directory, "venv", "bin");
    const python = join(venvBin, "python");
    const rscript = join(directory, "Rscript");
    const rExecutable = join(directory, "R");
    try {
      mkdirSync(venvBin, { recursive: true, mode: 0o700 });
      for (const executable of [resolvedPython, rscript, rExecutable]) {
        await writeFile(executable, "fake executable\n");
        await chmod(executable, 0o700);
      }
      await symlink(resolvedPython, python);
      const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, "r"), rscript, {
        containedBy: directory,
        environment: Object.freeze({ PATH: "/safe" }),
        async runCommand() {
          return { stdout: rExecutable, stderr: "" };
        }
      });

      const added = addJupyterAcceptancePythonKernel(prepared, python);
      const kernel = JSON.parse(await readFile(added.kernelSpecPath, "utf8"));
      assert.equal(kernel.argv[0], python, "The kernelspec must invoke the virtual-environment entry point.");
      assert.notEqual(kernel.argv[0], resolvedPython, "The kernelspec must not discard virtual-environment semantics.");

      const invalidPython = join(venvBin, "python-directory");
      await symlink(directory, invalidPython);
      assert.throws(
        () => addJupyterAcceptancePythonKernel(prepared, invalidPython),
        /existing regular-file interpreter/u,
        "The invocation path may be a symlink, but its resolved target must still be a regular file."
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("Quarto Python readiness launches the exact private core kernelspec and fixed dataframe marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-quarto-ready-"));
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    await writeFile(rscript, "fake executable\n");
    await writeFile(rExecutable, "fake executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    const { python } = await createTestQuartoCoreKernel(directory);
    const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, "r"), rscript, {
      containedBy: directory,
      environment: Object.freeze({ PATH: "/safe" }),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });
    const added = addJupyterAcceptancePythonKernel(prepared, python);

    let invocation;
    const result = await probeJupyterAcceptanceQuartoPythonKernel(prepared, added, {
      async runCommand(input, options) {
        invocation = { input, options };
        assert.equal(input.beforeSpawnCheck(), undefined);
        return { stdout: "OPEN_WRANGLER_QUARTO_PYTHON_KERNEL_READY\r\n", stderr: "" };
      }
    });
    assert.equal(result, undefined);
    const { input, options } = invocation;
    assert.equal(input.executable, python);
    const script = input.args[2];
    assertOwnedDirectKernelLauncher(script);
    assert.deepEqual(input.args, [
      "-I",
      "-c",
      script,
      added.id,
      added.kernelSpecPath,
      join(prepared.jupyterEnvironment.runtimeDir, "python-kernel-readiness.json"),
      prepared.kernelProbeWorkingDirectory
    ]);
    assert.match(
      script,
      /KernelSpec\.from_resource_dir\(os\.path\.dirname\(kernel_spec_path\)\)[\s\S]+write_connection_file\([\s\S]+BlockingKernelClient\(\)/u
    );
    assert.match(script, /client\.wait_for_ready\(timeout=12\)/u);
    assert.match(script, /import pandas as pd/u);
    assert.match(script, /DataFrame\(\{'city': \['Berlin', 'Oslo'\], 'value': \[1, 2\]\}\)/u);
    assert.match(script, /__OW_QUARTO_PYTHON_KERNEL__:2:city,value/u);
    assert.match(script, /message\.get\("parent_header", \{\}\)\.get\("msg_id"\) != request/u);
    assert.match(script, /execution_state"\) == "idle"/u);
    assert.match(script, /client\.stop_channels\(\)/u);
    assert.match(script, /process\.terminate\(\)/u);
    assert.match(script, /stage, succeeded = "cleanup", False/u);
    assert.doesNotMatch(script, /setTimeout|threading\.Timer/u);
    assert.deepEqual(options, { timeoutMs: 30_000, maxOutputBytes: 1_024 });
    assert.equal(input.environment.JUPYTER_DATA_DIR, prepared.jupyterEnvironment.dataDir);
    assert.equal(input.environment.JUPYTER_RUNTIME_DIR, prepared.jupyterEnvironment.runtimeDir);
    assert.equal(input.environment.JUPYTER_CONFIG_DIR, prepared.jupyterEnvironment.configDir);
    assert.equal(input.environment.JUPYTER_PATH, prepared.jupyterEnvironment.path);
    assert.equal(typeof input.beforeSpawnCheck, "function");
    const kernelSpec = JSON.parse(await readFile(added.kernelSpecPath, "utf8"));
    assert.deepEqual(kernelSpec.argv, [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quarto Python readiness classifies fixed start, execute, and cleanup failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-quarto-failures-"));
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    await writeFile(rscript, "fake executable\n");
    await writeFile(rExecutable, "fake executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    const { python } = await createTestQuartoCoreKernel(directory);
    const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, "r"), rscript, {
      containedBy: directory,
      environment: Object.freeze({}),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });
    const added = addJupyterAcceptancePythonKernel(prepared, python);
    for (const stage of ["start", "execute", "cleanup"]) {
      await assert.rejects(
        probeJupyterAcceptanceQuartoPythonKernel(prepared, added, {
          async runCommand(input) {
            input.beforeSpawnCheck();
            return { stdout: `OPEN_WRANGLER_QUARTO_PYTHON_KERNEL_FAILED:${stage}\n`, stderr: "" };
          }
        }),
        new RegExp(`readiness failed during ${stage}`, "u")
      );
    }
    await assert.rejects(
      probeJupyterAcceptanceQuartoPythonKernel(prepared, added, {
        async runCommand() {
          return { stdout: "OPEN_WRANGLER_QUARTO_PYTHON_KERNEL_READY\n", stderr: "private detail" };
        }
      }),
      /malformed fixed result/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "Quarto Python direct-probe timeout attests that its POSIX kernel and descendant are gone",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-quarto-owned-timeout-"));
    const venvDirectory = join(directory, "v");
    const basePython = process.env.OPEN_WRANGLER_TEST_PYTHON ?? "python3";
    const commandEnvironment = Object.freeze({ ...process.env });
    try {
      await runBoundedEditorCommand(
        {
          executable: basePython,
          args: ["-I", "-m", "venv", venvDirectory],
          environment: commandEnvironment,
          label: "Quarto ownership-test environment creation"
        },
        { timeoutMs: 15_000 }
      );
      const python = join(venvDirectory, "bin", "python");
      const { stdout: siteOutput, stderr: siteError } = await runBoundedEditorCommand(
        {
          executable: python,
          args: ["-I", "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
          environment: commandEnvironment,
          label: "Quarto ownership-test site-packages discovery"
        },
        { timeoutMs: 5_000, maxOutputBytes: 4_096 }
      );
      assert.equal(siteError, "");
      assert.match(siteOutput, /^\/[^\0\r\n]+\n$/u);
      const sitePackages = siteOutput.slice(0, -1);
      const blockingDirectory = join(sitePackages, "jupyter_client", "blocking");
      mkdirSync(blockingDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(sitePackages, "jupyter_client", "__init__.py"), '__version__ = "8.9.1"\n');
      writeFileSync(join(blockingDirectory, "__init__.py"), "");
      writeFileSync(
        join(blockingDirectory, "client.py"),
        [
          "import time",
          "class BlockingKernelClient:",
          "    def load_connection_info(self, info): pass",
          "    def start_channels(self): pass",
          "    def wait_for_ready(self, timeout): time.sleep(300)",
          "    def stop_channels(self): pass"
        ].join("\n") + "\n"
      );
      writeFileSync(
        join(sitePackages, "jupyter_client", "connect.py"),
        [
          "import json, os",
          "def write_connection_file(fname, **kwargs):",
          "    descriptor = os.open(fname, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)",
          "    with os.fdopen(descriptor, 'w', encoding='utf8') as target: json.dump({}, target)",
          "    return fname, {}"
        ].join("\n") + "\n"
      );
      writeFileSync(
        join(sitePackages, "jupyter_client", "kernelspec.py"),
        [
          "import json, os, types",
          "class KernelSpec:",
          "    @classmethod",
          "    def from_resource_dir(cls, directory):",
          "        with open(os.path.join(directory, 'kernel.json'), encoding='utf8') as source: value = json.load(source)",
          "        return types.SimpleNamespace(argv=value['argv'], env=value.get('env', {}))"
        ].join("\n") + "\n"
      );

      const runtimeDirectory = join(directory, "runtime");
      const workspaceDirectory = join(directory, "workspace");
      const kernelDirectory = join(directory, "data", "kernels", "python3");
      for (const path of [runtimeDirectory, workspaceDirectory, kernelDirectory]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      }
      writeFileSync(
        join(sitePackages, "ipykernel_launcher.py"),
        [
          "import os, subprocess, sys, time",
          `root = ${JSON.stringify(runtimeDirectory)}`,
          "with open(os.path.join(root, 'kernel.pid'), 'w', encoding='ascii') as target: target.write(str(os.getpid()))",
          "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=False)",
          "with open(os.path.join(root, 'descendant.pid'), 'w', encoding='ascii') as target: target.write(str(child.pid))",
          "while True: time.sleep(60)"
        ].join("\n") + "\n"
      );
      const kernelSpecPath = join(kernelDirectory, "kernel.json");
      writeFileSync(
        kernelSpecPath,
        `${JSON.stringify(
          {
            argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            display_name: "Python (Open Wrangler Quarto)",
            language: "python",
            metadata: { debugger: false },
            env: {}
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
      const source = await readFile(new URL("./jupyter-acceptance-environment.mjs", import.meta.url), "utf8");
      const probePrefix = "const QUARTO_PYTHON_ACCEPTANCE_KERNEL_PROBE = String.raw`";
      const probeStart = source.indexOf(probePrefix) + probePrefix.length;
      const probeEnd = source.indexOf("`.trimStart();", probeStart);
      assert.ok(probeStart >= probePrefix.length && probeEnd > probeStart);
      const probe = source.slice(probeStart, probeEnd);
      const connectionFile = join(runtimeDirectory, "kernel.json");

      let timeoutError;
      try {
        await runBoundedEditorCommand(
          {
            executable: python,
            args: ["-I", "-c", probe, "python3", kernelSpecPath, connectionFile, workspaceDirectory],
            environment: commandEnvironment,
            label: "Quarto owned-timeout descendant proof"
          },
          { timeoutMs: 1_500, terminationGraceMs: 500, killGraceMs: 1_000 }
        );
      } catch (error) {
        timeoutError = error;
      }
      assert.ok(timeoutError instanceof Error);
      assert.match(timeoutError.message, /timed out after 1500 ms/u);
      assert.equal(editorProcessTreeMayBeLive(timeoutError), false);

      const kernelPid = Number(await readFile(join(runtimeDirectory, "kernel.pid"), "ascii"));
      const descendantPid = Number(await readFile(join(runtimeDirectory, "descendant.pid"), "ascii"));
      assert.equal(Number.isSafeInteger(kernelPid) && kernelPid > 1, true);
      assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 1, true);
      assert.notEqual(kernelPid, descendantPid);
      for (const pid of [kernelPid, descendantPid]) {
        assert.throws(
          () => process.kill(pid, 0),
          (error) => error?.code === "ESRCH",
          `PID ${pid} must not survive the bounded direct-probe timeout.`
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("Quarto Python readiness rejects unregistered, replaced, or mutated private identities before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-quarto-identity-"));
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  const hostPython = join(directory, "host-python");
  try {
    for (const executable of [rscript, rExecutable, hostPython]) {
      await writeFile(executable, "fake executable\n");
      await chmod(executable, 0o700);
    }
    const preparedHost = await prepareJupyterAcceptanceREnvironment(join(directory, "r-host"), rscript, {
      containedBy: directory,
      environment: Object.freeze({}),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });
    const hostAdded = addJupyterAcceptancePythonKernel(preparedHost, hostPython);
    await assert.rejects(
      probeJupyterAcceptanceQuartoPythonKernel(preparedHost, hostAdded, {
        async runCommand() {
          assert.fail("An unregistered interpreter must fail before launch.");
        }
      }),
      /dedicated private core interpreter/u
    );

    const { environmentDirectory, python } = await createTestQuartoCoreKernel(directory);
    const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, "r-core"), rscript, {
      containedBy: directory,
      environment: Object.freeze({}),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });
    const added = addJupyterAcceptancePythonKernel(prepared, python);
    appendFileSync(added.kernelSpecPath, " ");
    await assert.rejects(
      probeJupyterAcceptanceQuartoPythonKernel(prepared, added, {
        async runCommand() {
          assert.fail("A changed kernelspec must fail before launch.");
        }
      }),
      /kernelspec lost its owned file identity/u
    );

    const displaced = join(directory, "displaced-core-kernel");
    renameSync(environmentDirectory, displaced);
    mkdirSync(environmentDirectory, { mode: 0o700 });
    await assert.rejects(
      probeJupyterAcceptanceQuartoPythonKernel(prepared, added, {
        async runCommand() {
          assert.fail("A replaced private root must fail before launch.");
        }
      }),
      (error) => error?.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter R readiness launches only the exact private kernelspec and fixed base-R marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-ready-"));
  const python = join(directory, "python");
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    await writeFile(python, "fake executable\n");
    await writeFile(rscript, "fake executable\n");
    await writeFile(rExecutable, "fake executable\n");
    await chmod(python, 0o700);
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    const root = join(directory, "r");
    const prepared = await prepareJupyterAcceptanceREnvironment(root, rscript, {
      containedBy: directory,
      environment: Object.freeze({ PATH: "/safe" }),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });

    let invocation;
    await probeJupyterAcceptanceRKernel(python, prepared, {
      async runCommand(input, options) {
        invocation = { input, options };
        appendFileSync(
          prepared.kernelBootstrapStagePath,
          "entered\r\nlibrary-ready\r\nirkernel-loaded\r\nmain-entered\r\n"
        );
        return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\r\n", stderr: "" };
      }
    });
    const { input, options } = invocation;
    assert.equal(input.executable, python);
    const script = input.args[2];
    assert.deepEqual(input.args, [
      "-I",
      "-c",
      script,
      prepared.kernelId,
      prepared.kernelSpecPath,
      join(prepared.jupyterEnvironment.runtimeDir, "kernel-readiness.json"),
      prepared.kernelProbeWorkingDirectory
    ]);
    assert.match(
      script,
      /class ExactKernelSpecManager\(KernelSpecManager\):[\s\S]+return self\._exact_spec[\s\S]+KernelSpec\.from_resource_dir\(os\.path\.dirname\(kernel_spec_path\)\)[\s\S]+kernel_spec_manager=specs[\s\S]+client\.wait_for_ready\(timeout=12\)[\s\S]+__OW_RELEASED_R_KERNEL__[\s\S]+manager\.shutdown_kernel\(now=True\)/u
    );
    assert.match(script, /stage, manager, client, succeeded = "start", None, None, False/u);
    assert.match(script, /if not marker: raise RuntimeError\("missing marker"\)\s+succeeded = True; break/u);
    assert.match(script, /stage, succeeded = "cleanup", False/u);
    assert.match(script, /"READY" if succeeded else "FAILED:" \+ stage/u);
    assert.doesNotMatch(script, /result == "ready"/u);
    assert.deepEqual(options, { timeoutMs: 30_000, maxOutputBytes: 1_024 });
    assert.equal(input.environment.R_LIBS_USER, prepared.libraryDir);
    assert.equal(input.environment.R_PROFILE_USER, undefined);
    assert.equal(input.environment.JUPYTER_DATA_DIR, prepared.jupyterEnvironment.dataDir);
    assert.equal(input.environment.JUPYTER_RUNTIME_DIR, prepared.jupyterEnvironment.runtimeDir);
    assert.equal(input.environment.JUPYTER_CONFIG_DIR, prepared.jupyterEnvironment.configDir);
    assert.equal(input.environment.JUPYTER_PATH, prepared.jupyterEnvironment.path);
    assert.equal(input.environment.OPEN_WRANGLER_TEST_RSCRIPT, rscript);
    assert.equal(jupyterAcceptanceRKernelBootstrapStage(prepared), "not-entered");
    appendFileSync(prepared.kernelBootstrapStagePath, "entered\r\nlibrary-ready\r\n");
    assert.equal(jupyterAcceptanceRKernelBootstrapStage(prepared), "library-ready");
    await probeJupyterAcceptanceRKernel(python, prepared, {
      async runCommand() {
        appendFileSync(
          prepared.kernelBootstrapStagePath,
          "entered\r\nlibrary-ready\r\nirkernel-loaded\r\nmain-entered\r\n"
        );
        return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\r\n", stderr: "" };
      }
    });
    assert.equal(jupyterAcceptanceRKernelBootstrapStage(prepared), "not-entered");
    appendFileSync(prepared.kernelBootstrapStagePath, "entered\r\nlibrary-ready\r\nirkernel-loaded\r\n");
    assert.equal(jupyterAcceptanceRKernelBootstrapStage(prepared), "irkernel-loaded");
    const phaseError = new Error("editor failed");
    assert.equal(appendJupyterAcceptanceRKernelBootstrapStage(phaseError, "irkernel-loaded"), phaseError);
    assert.equal(phaseError.message, "editor failed\nReleased-Jupyter R kernel bootstrap: irkernel-loaded.");
    const frozenError = Object.freeze(new Error("classified editor failure"));
    const wrappedError = appendJupyterAcceptanceRKernelBootstrapStage(frozenError, "not-entered");
    assert.equal(wrappedError instanceof AggregateError, true);
    assert.deepEqual(wrappedError.errors, [frozenError]);

    await assert.rejects(
      probeJupyterAcceptanceRKernel(python, prepared, {
        async runCommand() {
          return { stdout: "OPEN_WRANGLER_R_KERNEL_FAILED:ready\r\n", stderr: "" };
        }
      }),
      /readiness failed during ready/u
    );

    await assert.rejects(
      probeJupyterAcceptanceRKernel(python, prepared, {
        async runCommand() {
          return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\r\nextra", stderr: "" };
        }
      }),
      /malformed fixed result/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter R bootstrap stage rejects a replaced owned marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-stage-"));
  const python = join(directory, "python");
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    for (const executable of [python, rscript, rExecutable]) {
      await writeFile(executable, "fake executable\n");
      await chmod(executable, 0o700);
    }
    const root = join(directory, "r");
    const prepared = await prepareJupyterAcceptanceREnvironment(root, rscript, {
      containedBy: directory,
      environment: Object.freeze({ PATH: "/safe" }),
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });
    await assert.rejects(
      probeJupyterAcceptanceRKernel(python, prepared, {
        async runCommand() {
          return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\n", stderr: "" };
        }
      }),
      /did not reach the private IRkernel bootstrap \(last stage: not-entered\)/u
    );
    await probeJupyterAcceptanceRKernel(python, prepared, {
      async runCommand() {
        appendFileSync(prepared.kernelBootstrapStagePath, "entered\nlibrary-ready\nirkernel-loaded\nmain-entered\n");
        return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\n", stderr: "" };
      }
    });
    renameSync(prepared.kernelBootstrapStagePath, join(root, "old-kernel-bootstrap-stage"));
    writeFileSync(prepared.kernelBootstrapStagePath, "entered\n", { mode: 0o600 });
    assert.throws(() => jupyterAcceptanceRKernelBootstrapStage(prepared), /lost its owned file identity/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter R setup builds collapse from source on macOS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-binary-"));
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    await writeFile(rscript, "fake Rscript executable\n");
    await writeFile(rExecutable, "fake R executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, "darwin"), rscript, {
      containedBy: directory,
      environment: Object.freeze({}),
      platform: "darwin",
      async runCommand() {
        return { stdout: rExecutable, stderr: "" };
      }
    });
    const install = prepared.dependencyInstall.input.args.at(-1);
    assert.match(install, /\.ow_binary_supplemental_packages <- "nanoparquet"/u);
    assert.match(install, /install\.packages\(\n {2}"collapse",[\s\S]+type = "source"/u);
    assert.equal((install.match(/quiet = TRUE/gu) ?? []).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter R setup keeps collapse on the Linux and Windows binary paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-linux-binary-"));
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    await writeFile(rscript, "fake Rscript executable\n");
    await writeFile(rExecutable, "fake R executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    for (const platform of ["linux", "win32"]) {
      const prepared = await prepareJupyterAcceptanceREnvironment(join(directory, platform), rscript, {
        containedBy: directory,
        environment: Object.freeze({}),
        platform,
        async runCommand() {
          return { stdout: rExecutable, stderr: "" };
        }
      });
      const install = prepared.dependencyInstall.input.args.at(-1);
      assert.match(install, /\.ow_binary_supplemental_packages <- \.ow_supplemental_packages/u);
      assert.match(install, /"Rcpp"/u);
      assert.match(install, /repos = "[^"]+2026-06-01"/u);
      assert.doesNotMatch(install, /type = "source"/u);
      assert.equal((install.match(/quiet = TRUE/gu) ?? []).length, 2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter R setup rejects escaped or reused roots before writing to them", async () => {
  const containedBy = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-contained-"));
  const outside = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-outside-"));
  const rscript = join(containedBy, "Rscript");
  const rExecutable = join(containedBy, "R");
  const escapedRoot = join(outside, "must-not-exist");
  try {
    await writeFile(rscript, "fake Rscript executable\n");
    await writeFile(rExecutable, "fake R executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);
    const matchingRProbe = async () => ({ stdout: rExecutable, stderr: "" });
    await assert.rejects(
      async () =>
        prepareJupyterAcceptanceREnvironment(escapedRoot, rscript, {
          containedBy,
          environment: Object.freeze({}),
          runCommand: matchingRProbe
        }),
      /must stay inside its caller-owned root/u
    );
    assert.equal(existsSync(escapedRoot), false);

    const existingRoot = join(containedBy, "existing");
    mkdirSync(existingRoot);
    await assert.rejects(
      async () =>
        prepareJupyterAcceptanceREnvironment(existingRoot, rscript, {
          containedBy,
          environment: Object.freeze({}),
          runCommand: matchingRProbe
        }),
      /new contained private environment/u
    );
    await assert.rejects(
      async () =>
        prepareJupyterAcceptanceREnvironment(join(containedBy, "relative-rscript"), "Rscript", {
          containedBy,
          environment: Object.freeze({}),
          runCommand: matchingRProbe
        }),
      /existing absolute Rscript executable/u
    );
  } finally {
    await rm(containedBy, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("released-Jupyter R setup rejects an ambiguous or Rscript-valued launcher before creating its root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-launcher-"));
  const rscript = join(directory, "Rscript");
  const rExecutable = join(directory, "R");
  try {
    await writeFile(rscript, "fake Rscript executable\n");
    await writeFile(rExecutable, "fake R executable\n");
    await chmod(rscript, 0o700);
    await chmod(rExecutable, 0o700);

    for (const [name, stdout, message] of [
      ["ambiguous", `${rExecutable}\n${rExecutable}`, /invalid matching R executable path/u],
      ["rscript", rscript, /resolved Rscript instead of the matching R executable/u]
    ]) {
      const privateRoot = join(directory, `private-${name}`);
      await assert.rejects(
        prepareJupyterAcceptanceREnvironment(privateRoot, rscript, {
          containedBy: directory,
          environment: Object.freeze({}),
          async runCommand() {
            return { stdout, stderr: "" };
          }
        }),
        message
      );
      assert.equal(existsSync(privateRoot), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter R setup preserves probe ownership uncertainty through its cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-ownership-"));
  const rscript = join(directory, "Rscript");
  const privateRoot = join(directory, "private-r");
  try {
    await writeFile(rscript, "fake Rscript executable\n");
    await chmod(rscript, 0o700);
    const ownershipError = new Error("probe cleanup could not be verified");
    ownershipError.details = { treeVerifiedStopped: false };

    await assert.rejects(
      prepareJupyterAcceptanceREnvironment(privateRoot, rscript, {
        containedBy: directory,
        environment: Object.freeze({}),
        async runCommand() {
          throw ownershipError;
        }
      }),
      (error) => {
        assert.equal(error.cause, ownershipError);
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.match(error.message, /could not resolve the R executable matching Rscript/u);
        return true;
      }
    );
    assert.equal(existsSync(privateRoot), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged-editor R acceptance wires the private R environment to local editors and one VS Code remote phase", async () => {
  const source = await readFile(new URL("./run-packaged-editor-tests.mjs", import.meta.url), "utf8");
  assert.match(source, /const rJourneySelector = process\.env\.OPEN_WRANGLER_PACKAGED_R_JOURNEY/u);
  assert.match(source, /const rJupyterSelection = resolvePackagedRJourneySelection\(\{/u);
  assert.match(source, /selector: rJourneySelector/u);
  assert.match(source, /remoteJupyterEnabled,/u);
  assert.match(source, /platform: process\.platform/u);
  const modeStart = source.indexOf('if (acceptanceMode === "r-jupyter")');
  const supportedEditors = source.indexOf("const supportedEditorKeys", modeStart);
  assert.ok(modeStart >= 0 && supportedEditors > modeStart);
  assert.doesNotMatch(source.slice(modeStart, supportedEditors), /process\.env\.CI/u);
  assert.match(source, /remoteRJupyterEnabled = rJupyterSelection\.remote && editor\.key === "vscode"/u);
  assert.match(source, /for \(const phase of Object\.keys\(resultPaths\)\) userDataForPhase\(phase\)/u);
  assert.match(source, /logRoot: resolve\(userDataForPhase\(activePhase\), "logs"\)/u);
  assert.doesNotMatch(source, /userDataByPhase\.get\(activePhase\)\s*\?\?/u);
  const pythonProfile = source.indexOf("const pythonPreflightProfile = packagedEditorPythonPreflightProfile({");
  const pythonPreflight = source.indexOf("const testPython = resolveAndPreflightAcceptancePython({", pythonProfile);
  const editorDiscovery = source.indexOf("let candidates = [", pythonPreflight);
  const editorDownload = source.indexOf("await downloadEditorWithRetry(", editorDiscovery);
  assert.ok(
    pythonProfile >= 0 &&
      pythonPreflight > pythonProfile &&
      editorDiscovery > pythonPreflight &&
      editorDownload > editorDiscovery,
    "Every packaged mode must classify Python prerequisites before editor discovery or download."
  );
  assert.match(
    source.slice(pythonProfile, pythonPreflight),
    /acceptanceMode,[\s\S]*jupyterExtensionEnabled: Boolean\(jupyterExtensionInstallTarget\),[\s\S]*remoteOnly: remoteRJourneyOnly,[\s\S]*literateDocuments: rJupyterSelection\.literateDocuments/u
  );
  assert.doesNotMatch(source, /process\.platform === "win32"\s*\?\s*"python"\s*:\s*"python3"/u);

  const setup = source.indexOf("rAcceptanceEnvironment = await prepareJupyterAcceptanceREnvironment(");
  const display = source.indexOf("editorDisplay = await startIsolatedEditorDisplay()");
  assert.ok(setup >= 0 && display > setup, "The private R library must be ready before an editor can start.");
  assert.match(
    source.slice(setup, display),
    /dependencyProbeResult\.stdout !== rAcceptanceEnvironment\.packageRecord/u
  );
  const readinessCheckpoint = source.indexOf('"setup:probe-r-kernel-readiness"', setup);
  const readinessProbe = source.indexOf(
    "await probeJupyterAcceptanceRKernel(testPython, rAcceptanceEnvironment)",
    setup
  );
  const quartoPythonKernel = source.indexOf(
    "addJupyterAcceptancePythonKernel(rAcceptanceEnvironment, quartoKernelPython)",
    readinessProbe
  );
  const quartoPythonKernelGuard = source.lastIndexOf("if (rJupyterSelection.literateDocuments)", quartoPythonKernel);
  assert.ok(
    readinessCheckpoint > setup && readinessProbe > readinessCheckpoint && readinessProbe < display,
    "The exact private R kernel must answer its base-R marker before an editor can start."
  );
  assert.ok(
    quartoPythonKernelGuard > readinessProbe &&
      quartoPythonKernel > quartoPythonKernelGuard &&
      quartoPythonKernel < display,
    "Only the focused literate phase may add its Python kernelspec before an editor starts."
  );

  const phaseBranch = source.indexOf('if (jupyterExtensionInstallTarget && acceptanceMode === "r-jupyter")');
  const otherJupyterBranch = source.indexOf("} else if (jupyterExtensionInstallTarget", phaseBranch);
  assert.ok(phaseBranch >= 0 && otherJupyterBranch > phaseBranch);
  const rPhase = source.slice(phaseBranch, otherJupyterBranch);
  assert.match(rPhase, /phase: "jupyter-r"/u);
  assert.match(rPhase, /testSelector: rJourneySelector/u);
  assert.match(rPhase, /editor: "jupyter-r-remote"/u);
  assert.match(rPhase, /baseBuild: "jupyter-r-remote-base-build"/u);
  assert.match(rPhase, /runtimeBuild: "jupyter-r-remote-runtime-build"/u);
  assert.match(rPhase, /setup: "jupyter-r-remote-setup"/u);
  assert.match(rPhase, /fixtureKind: "r"/u);
  assert.match(rPhase, /if \(editorProcessTreeMayBeLive\(error\)\) throw error/u);
  assert.match(rPhase, /jupyterAcceptanceRKernelBootstrapStage\(rAcceptanceEnvironment\)/u);
  assert.match(rPhase, /appendJupyterAcceptanceRKernelBootstrapStage/u);
  assert.match(rPhase, /\[error, bootstrapStageError\]/u);
  assert.doesNotMatch(rPhase, /RProfileStartupStage|profileStageError/u);
  assert.equal((source.match(/await runRemoteJupyterPhase\(\{/gu) ?? []).length, 2);
});

test("packaged-editor candidate Python Jupyter resolves one owner before editor discovery and scopes every phase", async () => {
  const source = await readFile(new URL("./run-packaged-editor-tests.mjs", import.meta.url), "utf8");
  const profile = source.indexOf("const pythonJupyterProfile = resolvePackagedPythonJupyterProfile({");
  const preflight = source.indexOf("const pythonPreflightProfile = packagedEditorPythonPreflightProfile({", profile);
  const editorDiscovery = source.indexOf("let candidates = [", preflight);
  assert.ok(
    profile >= 0 && preflight > profile && editorDiscovery > preflight,
    "The candidate Python-Jupyter contract must reject misuse before dependency checks or editor discovery."
  );
  assert.match(
    source.slice(profile, preflight),
    /value: process\.env\[PACKAGED_PYTHON_JUPYTER_PROFILE_ENV\],[\s\S]*acceptanceMode,[\s\S]*jupyterExtensionEnabled: Boolean\(jupyterExtensionInstallTarget\),[\s\S]*dataWranglerCoexistenceEnabled: Boolean\(dataWranglerExtensionInstallTarget\),[\s\S]*remoteJupyterEnabled,[\s\S]*requestedEditors: requested/u
  );
  assert.match(
    source,
    /const pythonJupyterPlan = packagedPythonJupyterEditorPlan\(\s*pythonJupyterProfile,\s*editor\.key,\s*remoteJupyterEnabled\s*\)/u
  );
  assert.match(source, /const genericPackagedPhasesEnabled = !pythonJupyterPlan\.integrationOnly/u);
  assert.match(
    source,
    /acceptanceMode === "full" && genericPackagedPhasesEnabled[\s\S]*restricted: resolve\(profile, "restricted-result\.json"\),[\s\S]*seed: resolve\(profile, "seed-result\.json"\),[\s\S]*verify: resolve\(profile, "verify-result\.json"\)/u
  );
  assert.match(
    source,
    /acceptanceMode === "full" && pythonExtensionInstallTarget && genericPackagedPhasesEnabled[\s\S]*phase: "python-environment"/u
  );
  assert.match(
    source,
    /if \(genericPackagedPhasesEnabled\) \{[\s\S]*"setup:install-extension"[\s\S]*"setup:install-acceptance-harness"/u
  );
  assert.match(
    source,
    /if \(acceptanceMode === "full" && genericPackagedPhasesEnabled\) \{\s*for \(const phase of \["seed", "verify"\]\)/u
  );
  assert.match(source, /for \(const phase of pythonJupyterPlan\.phases\)/u);
  assert.match(source, /testSelector: phase === "jupyter-allow" \? pythonJupyterPlan\.allowSelector : undefined/u);
  assert.match(source, /if \(pythonJupyterPlan\.remote\) \{[\s\S]*fixtureKind: "python"/u);
  assert.doesNotMatch(source, /for \(const phase of \["jupyter-deny", "jupyter-allow", "jupyter-pyspark"\]\)/u);
});

test("the remote-only R selector bypasses every local runtime owner while retaining the five remote phases", async () => {
  const source = await readFile(new URL("./run-packaged-editor-tests.mjs", import.meta.url), "utf8");
  const sourceFile = ts.createSourceFile(
    "run-packaged-editor-tests.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  assert.equal(sourceFile.parseDiagnostics.length, 0);
  const descendants = (root, predicate) => {
    const matches = [];
    const visit = (node) => {
      if (predicate(node)) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
  };
  const callsNamed = (root, name) =>
    descendants(
      root,
      (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
    );
  const selection = source.indexOf("const rJupyterSelection = resolvePackagedRJourneySelection({");
  assert.equal(callsNamed(sourceFile, "resolvePackagedRJourneySelection").length, 1);
  const localSetup = source.indexOf("if (rJupyterSelection.local) {", selection);
  const genericPython = source.indexOf(
    '} else if (acceptanceMode !== "r-jupyter" && jupyterExtensionInstallTarget) {',
    localSetup
  );
  const display = source.indexOf("editorDisplay = await startIsolatedEditorDisplay()", genericPython);
  assert.ok(selection >= 0 && localSetup > selection && genericPython > localSetup && display > genericPython);
  const localSetupSource = source.slice(localSetup, genericPython);
  const localSetupBranches = descendants(
    sourceFile,
    (node) => ts.isIfStatement(node) && node.expression.getText(sourceFile) === "rJupyterSelection.local"
  );
  assert.equal(localSetupBranches.length, 1, "The helper-owned local selection must guard one setup branch.");
  const localSetupBranch = localSetupBranches[0];
  assert.ok(ts.isBlock(localSetupBranch.thenStatement));
  assert.ok(ts.isIfStatement(localSetupBranch.elseStatement));
  assert.equal(
    localSetupBranch.elseStatement.expression.getText(sourceFile),
    'acceptanceMode !== "r-jupyter" && jupyterExtensionInstallTarget',
    "The generic kernel branch must be the exact else branch of helper-owned local setup."
  );
  for (const owner of [
    "prepareJupyterAcceptanceREnvironment",
    "probeJupyterAcceptanceRKernel",
    "createJupyterAcceptanceCoreKernelPython",
    "prepareREditorAcceptanceTooling"
  ]) {
    assert.equal(callsNamed(sourceFile, owner).length, 1, `${owner} must have one local-only owner.`);
    assert.equal(
      callsNamed(localSetupBranch.thenStatement, owner).length,
      1,
      `${owner} must remain inside the helper-owned local setup branch.`
    );
    assert.match(localSetupSource, new RegExp(`${owner}\\(`, "u"));
  }
  assert.equal(callsNamed(sourceFile, "createJupyterAcceptanceKernelPython").length, 1);
  assert.equal(callsNamed(localSetupBranch.elseStatement, "createJupyterAcceptanceKernelPython").length, 1);
  assert.match(
    source.slice(genericPython, display),
    /createJupyterAcceptanceKernelPython\(/u,
    "Only non-R acceptance may create the generic private Python kernel."
  );

  assert.match(source, /const localRJupyterEnabled = rJupyterSelection\.local/u);
  assert.match(source, /const remoteRJupyterEnabled = rJupyterSelection\.remote && editor\.key === "vscode"/u);
  assert.equal(
    (source.match(/rJupyterSelection\.literateDocuments/gu) ?? []).length,
    3,
    "Literate selection must choose its Python profile, prepare its kernel, and forward that kernel to the phase."
  );
  assert.equal(
    (source.match(/rJupyterSelection\.nativeEditorTooling/gu) ?? []).length,
    4,
    "Only the focused native-editor selectors may prepare, configure, install, and verify R/Quarto tooling."
  );
  assert.match(
    localSetupSource,
    /if \(rJupyterSelection\.nativeEditorTooling\) \{[\s\S]*rEditorTooling = await prepareREditorAcceptanceTooling\(/u
  );
  assert.doesNotMatch(source, /rJourneySelector\s*===\s*"literate-documents"/u);
  assert.doesNotMatch(source, /rJourneySelector\s*===\s*"interactive-terminal"/u);
  assert.match(source, /\.\.\.\(localRJupyterEnabled \? \{ "jupyter-r": resolve/u);
  assert.match(source, /\.\.\.\(localRJupyterEnabled \? \{ "jupyter-r": randomUUID\(\) \} : \{\}\)/u);
  assert.match(source, /\.\.\.\(localRJupyterEnabled \? \[jupyterRWorkspace\] : \[\]\)/u);
  assert.match(source, /\.\.\.\(localRJupyterEnabled \? \[jupyterRUserData\] : \[\]\)/u);
  assert.equal((source.match(/"jupyter-r": resolve\(/gu) ?? []).length, 1);
  assert.equal((source.match(/"jupyter-r": randomUUID\(\)/gu) ?? []).length, 1);
  assert.equal((source.match(/\[jupyterRWorkspace\]/gu) ?? []).length, 1);
  assert.equal((source.match(/\[jupyterRUserData\]/gu) ?? []).length, 1);
  assert.match(source, /if \(localRJupyterEnabled\) \{\s*activePhase = "jupyter-r"/u);
  assert.match(
    source,
    /rJupyterSelection\.requiresHostR &&\s*\(typeof rscript !== "string" \|\| !isAbsolute\(rscript\) \|\| !existsSync\(rscript\)\)/u
  );
  assert.equal((source.match(/phase: "jupyter-r",/gu) ?? []).length, 1);
  const localEditorEnvironmentAssignment = "jupyterREnvironment = rAcceptanceEnvironment.jupyterEnvironment;";
  assert.equal(source.split(localEditorEnvironmentAssignment).length - 1, 1);
  const environmentAssignments = descendants(
    sourceFile,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sourceFile) === "jupyterREnvironment" &&
      node.right.getText(sourceFile) === "rAcceptanceEnvironment.jupyterEnvironment"
  );
  assert.equal(environmentAssignments.length, 1);
  const environmentStatement = environmentAssignments[0].parent;
  const environmentBlock = environmentStatement.parent;
  const environmentGuard = environmentBlock.parent;
  assert.ok(ts.isExpressionStatement(environmentStatement));
  assert.ok(ts.isBlock(environmentBlock));
  assert.equal(environmentBlock.statements.length, 1);
  assert.ok(ts.isIfStatement(environmentGuard));
  assert.equal(environmentGuard.expression.getText(sourceFile), "localRJupyterEnabled");
  assert.equal(environmentGuard.thenStatement, environmentBlock);
  assert.equal(environmentGuard.elseStatement, undefined);
  assert.match(source, /if \(remoteRJupyterEnabled\) \{\s*await runRemoteJupyterPhase\(\{/u);
  assert.match(
    source,
    /remoteRJourneyOnly\s*\? jupyterRemoteRUserData\s*:\s*jupyterRUserData/u,
    "Remote-only extension installation and inventory must use the remote profile."
  );
  assert.equal((source.match(/remoteRJourneyOnly\s*\? jupyterRemoteRUserData/gu) ?? []).length, 2);

  for (const phase of [
    "jupyter-r-remote-base-build",
    "jupyter-r-remote-runtime-build",
    "jupyter-r-remote-setup",
    "jupyter-r-remote",
    "jupyter-r-remote-cleanup"
  ]) {
    assert.match(source, new RegExp(`"${phase}": resolve\\(`, "u"));
    assert.match(source, new RegExp(`"${phase}": randomUUID\\(\\)`, "u"));
    assert.match(source, new RegExp(`\\["${phase}", jupyterRemoteRUserData\\]`, "u"));
  }
});

test("remote Jupyter phases receive empty private client roots without a host kernelspec", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-remote-jupyter-environment-"));
  try {
    const environment = writeRemoteJupyterAcceptanceEnvironment(join(directory, "client"));
    assert.deepEqual(Object.keys(environment).sort(), ["configDir", "dataDir", "path", "runtimeDir"]);
    for (const candidate of Object.values(environment)) {
      assert.equal(await readFile(join(candidate, "kernel.json"), "utf8").catch(() => undefined), undefined);
    }
    assert.throws(() => writeRemoteJupyterAcceptanceEnvironment("relative"), /absolute private environment directory/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote Jupyter descriptors are exclusive, private, and correlated", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Remote Jupyter container acceptance is Linux-only.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-remote-jupyter-descriptor-"));
  const descriptorDirectory = join(directory, "descriptor");
  const runId = "abcdef12-3456-4789-8abc-def012345678";
  const token = `owr_${"A".repeat(39)}`;
  try {
    mkdirSync(descriptorDirectory, { mode: 0o700 });
    const descriptorPath = writeRemoteJupyterAcceptanceDescriptor(
      descriptorDirectory,
      {
        baseUrl: "http://127.0.0.1:49153",
        token,
        runId,
        hostname: "owr-abcdef123456"
      },
      { containedBy: directory }
    );
    assert.equal(descriptorPath, join(descriptorDirectory, "remote-jupyter.json"));
    const descriptor = openSync(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor, { bigint: true });
      assert.equal(before.isFile(), true);
      assert.equal(before.nlink, 1n);
      assert.equal(before.mode & 0o777n, 0o400n);
      assert.deepEqual(JSON.parse(readFileSync(descriptor, "utf8")), {
        protocol: "openwrangler-remote-jupyter-v1",
        baseUrl: "http://127.0.0.1:49153",
        token,
        runId,
        hostname: "owr-abcdef123456"
      });
      const after = fstatSync(descriptor, { bigint: true });
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
      assert.equal(after.nlink, before.nlink);
      assert.equal(after.mode, before.mode);
      assert.equal(after.size, before.size);
    } finally {
      closeSync(descriptor);
    }
    assert.equal(descriptorPath.includes(token), false);
    assert.throws(
      () =>
        writeRemoteJupyterAcceptanceDescriptor(
          descriptorDirectory,
          {
            baseUrl: "http://127.0.0.1:49153",
            token,
            runId,
            hostname: "owr-abcdef123456"
          },
          { containedBy: directory }
        ),
      /EEXIST|file already exists/iu
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote Jupyter descriptor validation rejects unredactable secrets and non-loopback origins", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Remote Jupyter container acceptance is Linux-only.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-remote-jupyter-invalid-descriptor-"));
  const runId = "abcdef12-3456-4789-8abc-def012345678";
  try {
    const cases = [
      [{ token: "A".repeat(43) }, /bounded opaque private token/u],
      [{ baseUrl: "http://example.com:49153" }, /IPv4-loopback HTTP origin/u],
      [{ baseUrl: "http://127.0.0.1:49153/path" }, /IPv4-loopback HTTP origin/u],
      [{ hostname: "owr-unrelated" }, /run-derived container hostname/u]
    ];
    for (const [index, [overrides, pattern]] of cases.entries()) {
      const descriptorDirectory = join(directory, `case-${index}`);
      mkdirSync(descriptorDirectory, { mode: 0o700 });
      assert.throws(
        () =>
          writeRemoteJupyterAcceptanceDescriptor(
            descriptorDirectory,
            {
              baseUrl: "http://127.0.0.1:49153",
              token: `owr_${"A".repeat(39)}`,
              runId,
              hostname: "owr-abcdef123456",
              ...overrides
            },
            { containedBy: directory }
          ),
        pattern
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quarto provisions only the exact core compatibility dependencies in a private kernel environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-core-kernel-"));
  const commands = [];
  try {
    const { basePython, environmentDirectory, python } = await createTestQuartoCoreKernel(directory, { commands });

    assert.equal(python, join(environmentDirectory, "v", "bin", "python"));
    assert.notEqual(python, basePython);
    assert.equal(commands.length, 4);
    assert.equal(commands[0].input.label, "Quarto Python base dependency version probe");
    assert.equal(commands[0].input.executable, basePython);
    assert.match(commands[0].input.args.at(-1), /import ipykernel/u);
    assert.doesNotMatch(commands[0].input.args.at(-1), /pyspark|java/iu);
    assert.deepEqual(commands[0].options, { timeoutMs: 30_000 });
    assert.deepEqual(commands[1].input.args.slice(0, 3), ["-I", "-m", "venv"]);
    assert.deepEqual(commands[1].options, { timeoutMs: 60_000 });
    assert.equal(commands[2].input.label, "Quarto Python private kernel dependency installation");
    assert.deepEqual(commands[2].input.args.slice(-6), [
      "ipykernel==6.30.1",
      "jupyter-client==8.9.1",
      "pandas==2.3.3",
      "polars==1.35.2",
      "duckdb==1.5.4",
      "fsspec==2026.7.0"
    ]);
    assert.deepEqual(commands[2].input.args.slice(0, 11), [
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
      "ipykernel==6.30.1"
    ]);
    assert.deepEqual(commands[2].options, { timeoutMs: 240_000 });
    assert.equal(commands[3].input.label, "Quarto Python private kernel dependency probe");
    assert.equal(commands[3].input.executable, python);
    assert.match(commands[3].input.args.at(-1), /import pandas/u);
    assert.doesNotMatch(commands[3].input.args.at(-1), /pyspark|java/iu);
    assert.deepEqual(commands[3].options, { timeoutMs: 30_000 });
    assert.equal(
      commands.some(({ input }) => input.executable === "java" || /PySpark|pyspark/u.test(input.label)),
      false
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quarto core provisioning rejects a compatibility-version mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-core-version-"));
  try {
    await assert.rejects(
      createTestQuartoCoreKernel(directory, {
        finalReport: coreDependencyReport(false, { pandas: "3.0.5" })
      }),
      /Quarto Python private kernel did not retain the pandas compatibility version/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter installs its released compatibility versions into a clean run-owned kernel environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-kernel-"));
  const basePython = join(directory, "base-python");
  const environmentDirectory = join(directory, "private-kernel");
  const commandEnvironment = Object.freeze({ PATH: "/bounded-test-path" });
  const commands = [];
  const previousTestPython = process.env.OPEN_WRANGLER_TEST_PYTHON;
  try {
    await writeFile(basePython, "test interpreter placeholder\n");
    const kernelPython = await createJupyterAcceptanceKernelPython(environmentDirectory, basePython, {
      containedBy: directory,
      environment: commandEnvironment,
      platform: "linux",
      async runCommand(input, options) {
        commands.push({ input, options });
        if (input.label === "Released-Jupyter PySpark Java compatibility probe") {
          return javaReport();
        }
        if (input.label === "Released-Jupyter private kernel environment creation") {
          const venvDirectory = input.args.at(-1);
          mkdirSync(join(venvDirectory, "bin"), { recursive: true });
          writeFileSync(join(venvDirectory, "bin", "python"), "private interpreter placeholder\n");
        }
        if (input.label === "Released-Jupyter base dependency version probe") {
          return {
            stdout: JSON.stringify(
              dependencyReport(true, {
                ipykernel: "7.3.0",
                pandas: "3.0.5",
                polars: "1.43.0"
              })
            )
          };
        }
        if (input.label === "Released-Jupyter private kernel dependency probe") {
          return { stdout: JSON.stringify(dependencyReport(false)) };
        }
        return { stdout: "" };
      }
    });

    assert.equal(process.env.OPEN_WRANGLER_TEST_PYTHON, previousTestPython);
    assert.notEqual(kernelPython, basePython);
    assert.equal(kernelPython, join(environmentDirectory, "v", "bin", "python"));
    assert.equal(commands.length, 6);
    assert.equal(commands[0].input.executable, "java");
    assert.deepEqual(commands[0].input.args, ["-XshowSettings:properties", "-version"]);
    assert.equal(commands[1].input.executable, basePython);
    assert.match(commands[1].input.args.at(-1), /find_spec\("openwrangler_runtime"\)/u);
    assert.equal(commands[2].input.executable, basePython);
    assert.deepEqual(commands[2].input.args.slice(0, 3), ["-I", "-m", "venv"]);
    assert.equal(commands[3].input.executable, kernelPython);
    assert.deepEqual(commands[3].input.args.slice(0, 5), ["-I", "-m", "pip", "--isolated", "install"]);
    assert.equal(commands[3].input.args.filter((value) => value === "--no-cache-dir").length, 1);
    assert.ok(commands[3].input.args.includes("--only-binary=:all:"));
    assert.deepEqual(commands[3].input.args.slice(-12), [
      "ipykernel==6.30.1",
      "pandas==2.3.3",
      "polars==1.35.2",
      "duckdb==1.5.4",
      "fsspec==2026.7.0",
      "py4j==0.10.9.9",
      "pyarrow==25.0.0",
      "grpcio==1.83.0",
      "grpcio-status==1.83.0",
      "googleapis-common-protos==1.75.0",
      "protobuf==7.35.1",
      "zstandard==0.25.0"
    ]);
    assert.equal(
      commands[3].input.args.some((value) => /openwrangler.runtime/iu.test(value)),
      false
    );
    assert.equal(commands[4].input.label, "Released-Jupyter private kernel PySpark installation");
    assert.equal(commands[4].input.executable, kernelPython);
    assert.equal(commands[4].input.args.filter((value) => value === "--no-cache-dir").length, 1);
    assert.ok(commands[4].input.args.includes("--no-deps"));
    assert.match(commands[4].input.args.at(-1), /^pyspark @ https:\/\/files\.pythonhosted\.org\/.+#sha256=/u);
    assert.equal(commands[5].input.executable, kernelPython);
    assert.match(commands[5].input.args.at(-1), /find_spec\("openwrangler_runtime"\)/u);
    assert.match(commands[5].input.args.at(-1), /import pyspark/u);
    assert.equal(
      commands.every(({ input }) => input.environment === commandEnvironment),
      true
    );

    const jupyterEnvironment = writeJupyterAcceptanceEnvironment(join(directory, "jupyter-profile"), kernelPython);
    const kernelSpec = JSON.parse(
      await readFile(join(jupyterEnvironment.dataDir, "kernels", "openwrangler-acceptance", "kernel.json"), "utf8")
    );
    assert.equal(kernelSpec.argv[0], kernelPython);
    assert.notEqual(kernelSpec.argv[0], basePython);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter rejects a private environment that does not retain its compatibility versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-version-mismatch-"));
  const basePython = join(directory, "base-python");
  const environmentDirectory = join(directory, "private-kernel");
  try {
    await writeFile(basePython, "test interpreter placeholder\n");
    await assert.rejects(
      createJupyterAcceptanceKernelPython(environmentDirectory, basePython, {
        containedBy: directory,
        environment: Object.freeze({}),
        platform: "linux",
        async runCommand(input) {
          if (input.label === "Released-Jupyter PySpark Java compatibility probe") {
            return javaReport();
          }
          if (input.label === "Released-Jupyter base dependency version probe") {
            return {
              stdout: JSON.stringify(
                dependencyReport(true, {
                  ipykernel: "7.3.0",
                  pandas: "3.0.5",
                  polars: "1.43.0"
                })
              )
            };
          }
          if (input.label === "Released-Jupyter private kernel environment creation") {
            const venvDirectory = input.args.at(-1);
            mkdirSync(join(venvDirectory, "bin"), { recursive: true });
            writeFileSync(join(venvDirectory, "bin", "python"), "private interpreter placeholder\n");
            return { stdout: "" };
          }
          if (input.label === "Released-Jupyter private kernel binary dependency installation") {
            return { stdout: "" };
          }
          if (input.label === "Released-Jupyter private kernel PySpark installation") {
            return { stdout: "" };
          }
          if (input.label === "Released-Jupyter private kernel dependency probe") {
            return { stdout: JSON.stringify(dependencyReport(false, { ipykernel: "7.3.0" })) };
          }
          assert.fail(`Unexpected released-Jupyter command: ${input.label}`);
        }
      }),
      /did not retain the ipykernel compatibility version/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter rejects unsafe dependency versions before creating its private venv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-version-"));
  const basePython = join(directory, "base-python");
  let calls = 0;
  try {
    await writeFile(basePython, "test interpreter placeholder\n");
    await assert.rejects(
      createJupyterAcceptanceKernelPython(join(directory, "private-kernel"), basePython, {
        containedBy: directory,
        environment: Object.freeze({}),
        async runCommand(input) {
          calls += 1;
          if (input.label === "Released-Jupyter PySpark Java compatibility probe") {
            return javaReport();
          }
          return {
            stdout: JSON.stringify(dependencyReport(true, { pandas: "2.3.3; openwrangler-runtime" }))
          };
        }
      }),
      /safe pandas version/u
    );
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter propagates private-root identity loss to the runner boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-identity-"));
  const basePython = join(directory, "base-python");
  const environmentDirectory = join(directory, "private-kernel");
  const displacedDirectory = join(directory, "displaced-kernel");
  try {
    await writeFile(basePython, "test interpreter placeholder\n");
    await assert.rejects(
      createJupyterAcceptanceKernelPython(environmentDirectory, basePython, {
        containedBy: directory,
        environment: Object.freeze({}),
        async runCommand(input) {
          if (input.label === "Released-Jupyter PySpark Java compatibility probe") {
            return javaReport();
          }
          if (input.label === "Released-Jupyter base dependency version probe") {
            return { stdout: JSON.stringify(dependencyReport(true)) };
          }
          if (input.label === "Released-Jupyter private kernel environment creation") {
            renameSync(environmentDirectory, displacedDirectory);
            mkdirSync(environmentDirectory);
            return { stdout: "" };
          }
          assert.fail(`Unexpected command after private-root replacement: ${input.label}`);
        }
      }),
      (error) => error?.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released-Jupyter kernel probing fails closed when runtime visibility is true or missing", async () => {
  const kernelPython = join(tmpdir(), "released-jupyter-python");
  for (const runtimeVisibility of [true, undefined]) {
    await assert.rejects(
      probeJupyterAcceptancePython(kernelPython, {
        environment: Object.freeze({}),
        async runCommand(input) {
          assert.equal(input.executable, kernelPython);
          assert.match(input.args.at(-1), /find_spec\("openwrangler_runtime"\)/u);
          const report = dependencyReport(false);
          if (runtimeVisibility === undefined) delete report.openwranglerRuntimePresent;
          else report.openwranglerRuntimePresent = runtimeVisibility;
          return { stdout: JSON.stringify(report) };
        }
      }),
      runtimeVisibility === undefined ? /did not report runtime visibility/u : /exposes openwrangler_runtime/u
    );
  }
});
