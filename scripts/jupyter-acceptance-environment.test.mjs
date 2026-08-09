import assert from "node:assert/strict";
import {
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
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editorProcessTreeMayBeLive } from "./editor-acceptance.mjs";
import {
  R_ACCEPTANCE_PACKAGE_VERSIONS,
  acceptancePythonForPhase,
  createRemoteJupyterAcceptanceToken,
  createJupyterAcceptanceKernelPython,
  prepareJupyterAcceptanceREnvironment,
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
  pandas: "2.3.3",
  polars: "1.35.2",
  duckdb: "1.5.4",
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
      join(privateRoot, "h"),
      join(privateRoot, "t")
    ]) {
      assert.equal(existsSync(path), true);
      assert.equal(statSync(path).isDirectory(), true);
      assert.equal(statSync(path).mode & 0o777, 0o700);
    }

    const kernelSpec = JSON.parse(await readFile(prepared.kernelSpecPath, "utf8"));
    assert.deepEqual(kernelSpec, {
      argv: [
        rExecutable,
        "--slave",
        "-e",
        '.ow_library <- Sys.getenv("R_LIBS_USER", unset = NA_character_); if (is.na(.ow_library) || !dir.exists(.ow_library)) stop("Open Wrangler R acceptance library is unavailable."); .libPaths(unique(c(normalizePath(.ow_library, winslash = "/", mustWork = TRUE), .libPaths()))); IRkernel::main()',
        "--args",
        "{connection_file}"
      ],
      display_name: "R (Open Wrangler)",
      language: "R",
      env: { R_LIBS_USER: prepared.libraryDir }
    });
    assert.equal(kernelSpec.argv.at(-1), "{connection_file}");
    assert.equal(kernelSpec.argv.filter((value) => value === "{connection_file}").length, 1);
    assert.notEqual(kernelSpec.argv[0], rscript);
    assert.equal(kernelSpec.argv.includes("--vanilla"), false);
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
      assert.equal(invocation.input.environment.TMPDIR, join(privateRoot, "t"));
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
    assert.deepEqual(prepared.dependencyInstall.options, { timeoutMs: 600_000 });
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

test("released-Jupyter R readiness launches only the exact private kernelspec and fixed base-R marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-jupyter-r-ready-"));
  const python = join(directory, "python");
  try {
    await writeFile(python, "fake executable\n");
    await chmod(python, 0o700);
    const root = join(directory, "r");
    const prepared = {
      root,
      libraryDir: join(root, "l"),
      kernelId: "openwrangler-r-acceptance",
      kernelSpecPath: join(root, "d", "kernels", "openwrangler-r-acceptance", "kernel.json"),
      jupyterEnvironment: {
        dataDir: join(root, "d"),
        runtimeDir: join(root, "r")
      },
      dependencyProbe: { input: { environment: { R_LIBS_USER: join(root, "l") } } }
    };

    let invocation;
    for (const lineEnding of ["\n", "\r\n"]) {
      await probeJupyterAcceptanceRKernel(python, prepared, {
        async runCommand(input, options) {
          invocation = { input, options };
          return { stdout: `OPEN_WRANGLER_R_KERNEL_READY${lineEnding}`, stderr: "" };
        }
      });
    }
    const { input, options } = invocation;
    assert.equal(input.executable, python);
    const script = input.args[2];
    assert.deepEqual(input.args, [
      "-I",
      "-c",
      script,
      prepared.kernelId,
      join(prepared.jupyterEnvironment.dataDir, "kernels"),
      join(prepared.jupyterEnvironment.runtimeDir, "kernel-readiness.json"),
      join(prepared.root, "h")
    ]);
    assert.match(
      script,
      /KernelSpecManager\(kernel_dirs=\[kernel_dir\], ensure_native_kernel=False[\s\S]+client\.wait_for_ready\(timeout=12\)[\s\S]+__OW_RELEASED_R_KERNEL__[\s\S]+manager\.shutdown_kernel\(now=True\)/u
    );
    assert.deepEqual(options, { timeoutMs: 30_000, maxOutputBytes: 1_024 });
    assert.equal(input.environment.R_LIBS_USER, prepared.libraryDir);

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
  const modeStart = source.indexOf('if (acceptanceMode === "r-jupyter")');
  const supportedEditors = source.indexOf("const supportedEditorKeys", modeStart);
  assert.ok(modeStart >= 0 && supportedEditors > modeStart);
  assert.doesNotMatch(source.slice(modeStart, supportedEditors), /process\.env\.CI/u);
  assert.match(
    source,
    /remoteRJupyterEnabled =\s*acceptanceMode === "r-jupyter" && remoteJupyterEnabled && editor\.key === "vscode"/u
  );
  assert.match(source, /for \(const phase of Object\.keys\(resultPaths\)\) userDataForPhase\(phase\)/u);
  assert.match(source, /logRoot: resolve\(userDataForPhase\(activePhase\), "logs"\)/u);
  assert.doesNotMatch(source, /userDataByPhase\.get\(activePhase\)\s*\?\?/u);
  const pythonGuard = source.indexOf("(!isAbsolute(testPython) || !existsSync(testPython))");
  assert.ok(pythonGuard >= 0);
  assert.doesNotMatch(
    source.slice(source.lastIndexOf("if (", pythonGuard), pythonGuard),
    /acceptanceMode !== "r-jupyter"/u,
    "R Jupyter must reject a PATH-only Python before the private-kernel preflight."
  );

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
  assert.ok(
    readinessCheckpoint > setup && readinessProbe > readinessCheckpoint && readinessProbe < display,
    "The exact private R kernel must answer its base-R marker before an editor can start."
  );

  const phaseBranch = source.indexOf('if (jupyterExtensionInstallTarget && acceptanceMode === "r-jupyter")');
  const otherJupyterBranch = source.indexOf("} else if (jupyterExtensionInstallTarget", phaseBranch);
  assert.ok(phaseBranch >= 0 && otherJupyterBranch > phaseBranch);
  const rPhase = source.slice(phaseBranch, otherJupyterBranch);
  assert.match(rPhase, /phase: "jupyter-r"/u);
  assert.match(rPhase, /editor: "jupyter-r-remote"/u);
  assert.match(rPhase, /fixtureKind: "r"/u);
  assert.equal((source.match(/await runRemoteJupyterPhase\(\{/gu) ?? []).length, 2);
});

test("extension-host R acceptance routes the remote kernel and does not probe a host extension path", async () => {
  const source = await readFile(new URL("../src/test/extensionHost/index.ts", import.meta.url), "utf8");
  const writerStart = source.indexOf("function writeReleasedRNotebook(");
  const start = source.indexOf("async function exerciseReleasedRJupyterExtension(");
  const end = source.indexOf("async function exerciseReleasedRGridJourney(", start);
  assert.ok(writerStart >= 0 && start > writerStart && end > start);
  const writer = source.slice(writerStart, start);
  const remoteRJourney = source.slice(start, end);

  assert.match(source, /RELEASED_JUPYTER_REMOTE_R_KERNEL_LABEL = "R \(Open Wrangler Remote\)"/u);
  assert.match(source, /phase === "jupyter-r-remote"/u);
  assert.match(remoteRJourney, /registerReleasedRemoteJupyterServer\(jupyterApi, kernelTarget\)/u);
  assert.match(remoteRJourney, /assert\.equal\(setup\.remoteRunId, kernelTarget\.remote\.runId\)/u);
  assert.match(remoteRJourney, /waitForReleasedRRuntimeBindingCleanup\(notebook, cleanupEditor, phase\)/u);
  assert.doesNotMatch(writer, /hostExtensionVisible|extension\.extensionPath/u);
  assert.match(writer, /RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX/u);
  assert.match(
    writer,
    /cat\(\$\{JSON\.stringify\(RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX\)\}, \.ow_setup_stage, '\\\\n', sep = ''\)/u
  );
  assert.doesNotMatch(writer, /conditionMessage|\.ow_setup_error\$|print\(\.ow_setup_error/u);
  assert.match(remoteRJourney, /\[RELEASED_JUPYTER_R_SETUP_RESULT, RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX\]/u);
  assert.match(remoteRJourney, /const setupFailureStage = releasedNotebookRSetupFailureStage\(setupCell\.outputs\)/u);
  assert.match(remoteRJourney, /Released-Jupyter R setup returned a malformed fixed diagnostic\./u);

  const setupExecution = remoteRJourney.indexOf("await executeReleasedNotebookCell(");
  const exactRefocus = remoteRJourney.indexOf("const actionNotebookEditor = await showExactReleasedNotebook(notebook)");
  const firstToolbarAction = remoteRJourney.indexOf("picker = await activateReleasedNotebookVariableAction(");
  assert.ok(
    setupExecution >= 0 && exactRefocus > setupExecution && firstToolbarAction > exactRefocus,
    "The first R toolbar click must refocus the exact notebook after kernel setup."
  );
  assert.match(
    remoteRJourney.slice(exactRefocus, firstToolbarAction),
    /assert\.equal\(\s*actionNotebookEditor,\s*notebookEditor,/u
  );
});

test("Cursor uses one explicit representative R coverage profile while VS Code stays comprehensive", async () => {
  const source = await readFile(new URL("../src/test/extensionHost/index.ts", import.meta.url), "utf8");
  const profileStart = source.indexOf("type ReleasedRAcceptanceCoverageProfile =");
  const journeyStart = source.indexOf("async function exerciseReleasedRJupyterExtension(", profileStart);
  const journeyEnd = source.indexOf("\nasync function exerciseReleasedRInteractiveTerminalJourney(", journeyStart);
  assert.ok(profileStart >= 0 && journeyStart > profileStart && journeyEnd > journeyStart);
  const profiles = source.slice(profileStart, journeyStart);
  const journey = source.slice(journeyStart, journeyEnd);

  assert.match(
    profiles,
    /RELEASED_R_COMPREHENSIVE_COVERAGE[\s\S]*name: "comprehensive"[\s\S]*gridPaging: "all-blocks"[\s\S]*editing: "all-operations"[\s\S]*documents: "plain-and-literate"[\s\S]*openCollapseSessions: true[\s\S]*openNativeFramesInViewingMode: true[\s\S]*nativeFrameEditing: "rename-and-drop"/u
  );
  assert.match(
    profiles,
    /RELEASED_R_CURSOR_COVERAGE[\s\S]*name: "cursor-representative"[\s\S]*gridPaging: "single-round-trip"[\s\S]*editing: "rename-lifecycle"[\s\S]*documents: "plain-only"[\s\S]*openCollapseSessions: false[\s\S]*openNativeFramesInViewingMode: false[\s\S]*nativeFrameEditing: "one-operation-per-flavor"/u
  );
  assert.match(
    profiles,
    /process\.env\.OPEN_WRANGLER_TEST_EDITOR === "cursor"\s*\? RELEASED_R_CURSOR_COVERAGE\s*:\s*RELEASED_R_COMPREHENSIVE_COVERAGE/u
  );
  assert.doesNotMatch(
    journey,
    /OPEN_WRANGLER_TEST_EDITOR/u,
    "Editor-specific R coverage decisions belong in the named profile, not scattered through the journey."
  );
  assert.match(journey, /exerciseReleasedRGridJourney\(testing, workbench, base\.sessionId, coverage\.gridPaging\)/u);
  assert.match(
    journey,
    /if \(coverage\.editing === "all-operations"\)[\s\S]*exerciseReleasedREditingJourney\([\s\S]*else \{[\s\S]*exerciseReleasedRRepresentativeEditingJourney\(/u
  );
  assert.match(journey, /coverage\.documents === "plain-and-literate"/u);
  assert.match(journey, /if \(coverage\.openCollapseSessions\)/u);
  assert.match(journey, /if \(coverage\.openNativeFramesInViewingMode\)/u);
  assert.match(journey, /coverage\.nativeFrameEditing === "rename-and-drop"/u);
  for (const section of ["variable-discovery", "grid", "editing", "native-editing", "restart"]) {
    assert.match(
      journey,
      new RegExp(`recordReleasedRAcceptanceSection\\(phase, coverage, "${section}", "start"\\)`, "u")
    );
    assert.match(
      journey,
      new RegExp(`recordReleasedRAcceptanceSection\\(phase, coverage, "${section}", "complete"\\)`, "u")
    );
  }
  assert.match(
    journey,
    /await exerciseReleasedRInteractiveTerminalJourney\(testing, await connectToEditorWorkbench\(\)\)/u,
    "The local Cursor profile must still exercise the official R terminal and Operations sidebar."
  );

  const gridStart = source.indexOf("async function exerciseReleasedRGridJourney(");
  const gridEnd = source.indexOf("\nasync function exerciseReleasedRPersistentRowsJourney(", gridStart);
  const representativeStart = source.indexOf("async function exerciseReleasedRRepresentativeEditingJourney(");
  const representativeEnd = source.indexOf("\nasync function exerciseReleasedREditingJourney(", representativeStart);
  assert.ok(
    gridStart >= 0 && gridEnd > gridStart && representativeStart >= 0 && representativeEnd > representativeStart
  );
  const grid = source.slice(gridStart, gridEnd);
  const representative = source.slice(representativeStart, representativeEnd);
  assert.match(
    grid,
    /if \(paging === "all-blocks"\)[\s\S]*else \{[\s\S]*"the representative second R block"[\s\S]*"the representative restored R block"/u
  );
  assert.match(grid, /"Clear all"/u);
  assert.match(grid, /applyReleasedRQuickSort\(workbench, testing, "group", "ascending", \["group"\]\)/u);
  assert.match(grid, /applyReleasedRQuickSort\(workbench, testing, "score", "descending", \["score", "group"\]\)/u);
  assert.match(grid, /Move View Sort Up/u);
  assert.equal((representative.match(/previewReleasedRRename\(/gu) ?? []).length, 2);
  for (const marker of [
    "No value changes in this block",
    "assertReleasedRGeneratedCode",
    'executeCommand("openWrangler.selectStep"',
    "inspection.diff",
    'name: "Undo"'
  ]) {
    assert.ok(representative.includes(marker), `The representative R edit must retain ${JSON.stringify(marker)}.`);
  }
});

test("R editing acceptance reveals the capitalized column after temporary derived columns", async () => {
  const source = await readFile(new URL("../src/test/extensionHost/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function exerciseReleasedREditingJourney(");
  const end = source.indexOf("\nasync function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const journey = source.slice(start, end);

  const ceilingReveal = journey.indexOf('await ceilingColumnSearch.fill("score_ceiling")');
  const capitalizePreview = journey.indexOf('"The R Capitalize preview must reach its renderer."');
  const labelReveal = journey.indexOf("await capitalizeColumnSearch.fill(labelColumn.name)");
  const selectedReceipt = journey.indexOf(
    "testing.activeSession()?.viewState.selectedColumnId === labelColumn.id",
    labelReveal
  );
  const visibleValue = journey.indexOf('"the visible R Capitalize value in row 1"', selectedReceipt);
  const floorSelection = journey.indexOf('"selecting the visible R Floor result"');
  const floorRenderer = journey.indexOf('"the selected R Floor result"', floorSelection);
  const floorValue = journey.indexOf("the visible R Floor value in row ${row + 1}", floorRenderer);
  const ceilingSelection = journey.indexOf('"selecting the visible R Ceiling result"', floorValue);
  const ceilingRenderer = journey.indexOf('"the selected R Ceiling result"', ceilingSelection);
  const ceilingValue = journey.indexOf("the visible R Ceiling value in row ${row + 1}", ceilingRenderer);

  assert.ok(
    ceilingReveal >= 0 &&
      capitalizePreview > ceilingReveal &&
      labelReveal > capitalizePreview &&
      selectedReceipt > labelReveal &&
      visibleValue > selectedReceipt,
    "The R journey must reveal label through Column Search before reading its virtualized Capitalize cell."
  );
  assert.ok(
    floorSelection >= 0 &&
      floorRenderer > floorSelection &&
      floorValue > floorRenderer &&
      ceilingSelection > floorValue &&
      ceilingRenderer > ceilingSelection &&
      ceilingValue > ceilingRenderer,
    "The R journey must reacquire Floor and Ceiling after Column Search before reading their cells."
  );
});

test("R fill acceptance reacquires the renderer after preview and apply", async () => {
  const source = await readFile(new URL("../src/test/extensionHost/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function exerciseReleasedRFillMissingJourney(");
  const end = source.indexOf("\nasync function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const journey = source.slice(start, end);

  const dialogClosed = journey.indexOf('await dialog.waitFor({ state: "hidden", timeout: 10_000 });');
  const previewRenderer = journey.indexOf(
    'app = await releasedRSessionApp(workbench, testing, sessionId, "the native R Fill missing values preview");',
    dialogClosed
  );
  const draftReview = journey.indexOf('app.getByRole("region", { name: "Draft review" })', previewRenderer);
  const appliedState = journey.indexOf('"applying native R Fill missing values through Draft review"', draftReview);
  const appliedRenderer = journey.indexOf(
    'app = await releasedRSessionApp(workbench, testing, sessionId, "the applied native R Fill missing values step");',
    appliedState
  );
  const cleaningPlan = journey.indexOf('app.getByRole("group", { name: "Cleaning plan" })', appliedRenderer);
  const undo = journey.indexOf('app.getByRole("button", { name: "Undo", exact: true }).click()', cleaningPlan);

  assert.ok(
    dialogClosed >= 0 &&
      previewRenderer > dialogClosed &&
      draftReview > previewRenderer &&
      appliedState > draftReview &&
      appliedRenderer > appliedState &&
      cleaningPlan > appliedRenderer &&
      undo > cleaningPlan,
    "The R fill journey must reacquire its acknowledged renderer after both mutations."
  );
});

test("R view mutations reacquire the renderer before the next panel action", async () => {
  const source = await readFile(new URL("../src/test/extensionHost/index.ts", import.meta.url), "utf8");
  const assertOrder = (functionName, markers) => {
    const start = source.indexOf(`async function ${functionName}(`);
    const end = source.indexOf("\nasync function ", start + 1);
    assert.ok(start >= 0 && end > start, `${functionName} must exist.`);
    const body = source.slice(start, end);
    let previous = -1;
    for (const marker of markers) {
      const index = body.indexOf(marker, previous + 1);
      assert.ok(index > previous, `${functionName} must place ${JSON.stringify(marker)} after the prior boundary.`);
      previous = index;
    }
  };

  assertOrder("exerciseReleasedRJupyterExtension", [
    '"clearing the replayed R view before the cleaning journey"',
    '"the cleared R editing view"',
    "exerciseReleasedREditingJourney("
  ]);
  assertOrder("exerciseReleasedRGridJourney", [
    '"the selected native R score value to filter the complete frame"',
    '"the selected native R score filter"',
    'selectOption({ label: "group" })'
  ]);
  assertOrder("exerciseReleasedRPersistentRowsJourney", [
    '"the R group viewing filter"',
    '"the filtered R persistent-row view"',
    'name: "Close panel"',
    '"clearing the native R persistent-row acceptance view"',
    '"the cleared R persistent-row view"',
    'name: "Close panel"'
  ]);
  assertOrder("exerciseReleasedRRowReductionJourney", [
    '"the unrelated R row-reduction viewing filter"',
    '"the filtered R row-reduction view"',
    'name: "Close panel"',
    '"clearing the R row-reduction viewing filter"',
    '"the cleared R row-reduction view"',
    'name: "Close panel"'
  ]);
  assertOrder("exerciseReleasedREditingJourney", [
    '"the R notebook export viewing filter"',
    '"the filtered R notebook export view"',
    'name: "Close panel"',
    '"clearing the R notebook export view"',
    '"the cleared R notebook export view"',
    'name: "Close panel"'
  ]);
  assertOrder("captureReleasedRNotebookGroupByDraft", [
    '"clearing the representative R view before Group and aggregate"',
    '"the cleared representative R view"',
    'name: "Close panel"'
  ]);
  assertOrder("captureReleasedRJupyterWorkbench", [
    '"the first R media filter"',
    'app = await releasedRSessionApp(workbench, testing, sessionId, "the first R media filter");',
    'selectOption({ label: "market" })'
  ]);
  assertOrder("applyReleasedRQuickSort", [
    "await menu.menu.getByRole",
    "await waitFor(",
    "const sortedApp = await releasedRSessionApp",
    "await closedMenu.evaluate"
  ]);
});

test("R native-frame editing waits for its visible renderer before notebook probes", async () => {
  const source = await readFile(new URL("../src/test/extensionHost/index.ts", import.meta.url), "utf8");
  const journeyStart = source.indexOf("async function exerciseReleasedRJupyterExtension(");
  const journeyEnd = source.indexOf("\nasync function exerciseReleasedRDocumentJourney(", journeyStart);
  assert.ok(journeyStart >= 0 && journeyEnd > journeyStart);
  const journey = source.slice(journeyStart, journeyEnd);

  const frames = journey.indexOf("const additionalRFrames = [");
  const editingMode = journey.indexOf(
    'await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);',
    frames
  );
  const loop = journey.indexOf("for (const expected of additionalRFrames)", editingMode);
  const sessionReceipt = journey.indexOf(":editing-session-received`);", loop);
  const rendererReceipt = journey.indexOf("let app = await releasedRSessionApp(", sessionReceipt);
  const rendererCheckpoint = journey.indexOf(":editing-renderer-ready`);", rendererReceipt);
  const renamePreview = journey.indexOf("const previewed = await previewReleasedRRename(", rendererCheckpoint);
  const sourceProbe = journey.indexOf(":after-native-edit`);", renamePreview);
  const loopEnd = journey.indexOf('await configuration.update("notebookStartMode", "viewing"', loop);

  assert.ok(
    frames >= 0 &&
      editingMode > frames &&
      loop > editingMode &&
      sessionReceipt > loop &&
      rendererReceipt > sessionReceipt &&
      rendererCheckpoint > rendererReceipt &&
      renamePreview > rendererCheckpoint &&
      sourceProbe > renamePreview &&
      loopEnd > sourceProbe,
    "The native tibble/data.table editing loop must obtain a visible renderer before editing and probe the notebook only afterward."
  );
  assert.doesNotMatch(
    journey.slice(loop, rendererReceipt),
    /assertReleasedRRuntimeBinding\(/u,
    "A notebook execution before the first renderer receipt can retire Cursor's new panel."
  );
  assert.doesNotMatch(
    journey,
    /source-before-(?:filter|editing)-journey|media-source-before-capture/u,
    "The R journey must not execute notebook probes between opening a panel and completing its UI work."
  );
  assert.match(journey, /source-after-filter-journey/u);
  assert.match(journey, /source-after-editing-journey/u);
  assert.match(journey, /media-source-after-capture/u);
  assert.match(journey, /:after-native-edit/u);

  const editingJourneyStart = source.indexOf("async function exerciseReleasedREditingJourney(");
  const editingJourneyEnd = source.indexOf("\nasync function ", editingJourneyStart + 1);
  assert.ok(editingJourneyStart >= 0 && editingJourneyEnd > editingJourneyStart);
  assert.doesNotMatch(
    source.slice(editingJourneyStart, editingJourneyEnd),
    /assertReleasedRRuntimeBinding\(/u,
    "Notebook binding probes belong after the complete editing journey, not between UI operations."
  );

  const helperStart = source.indexOf("async function releasedRSessionApp(");
  const helperEnd = source.indexOf("\nasync function captureReleasedRJupyterWorkbench(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const sharedAcquisition = helper.indexOf("return synchronizedSessionApp(");
  const synchronization = helper.indexOf("await requireFreshExactSessionPanelHydration(", sharedAcquisition);
  const receipt = helper.indexOf("const receipt = testing.panelSynchronizationReceipt(sessionId);", synchronization);
  const reacquiredGrid = helper.indexOf(
    "await waitForOpenWranglerGridTarget(workbench, testing, sessionId, receipt)",
    receipt
  );
  const exactRenderer = helper.indexOf(
    "await exactSessionApp(target.frame, sessionId, receipt.syncId)",
    reacquiredGrid
  );
  const receiptRecheck = helper.indexOf("sameRendererSynchronizationReceipt(", exactRenderer);
  assert.ok(
    sharedAcquisition >= 0 &&
      synchronization > sharedAcquisition &&
      receipt > synchronization &&
      reacquiredGrid > receipt &&
      exactRenderer > reacquiredGrid &&
      receiptRecheck > exactRenderer,
    "A released R panel must synchronize once, bind the exact acknowledged renderer, and recheck its receipt."
  );
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
    assert.deepEqual(commands[3].input.args.slice(-11), [
      "ipykernel==6.30.1",
      "pandas==2.3.3",
      "polars==1.35.2",
      "duckdb==1.5.4",
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
