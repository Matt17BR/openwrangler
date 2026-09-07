import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  jupyterAcceptanceRKernelBootstrapStage,
  prepareJupyterAcceptanceREnvironment,
  probeJupyterAcceptanceRKernel,
  R_ACCEPTANCE_PACKAGE_VERSIONS,
  rAcceptanceRepositories
} from "./jupyter-acceptance-environment.mjs";
import { resolvePackagedRJourneySelection } from "./packaged-r-journey.mjs";

const notebookPackages = ["IRkernel", "jsonlite", "rlang", "Rcpp", "tibble", "data.table", "collapse", "nanoparquet"];

function provisioning(t) {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-r-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rscript = join(root, "Rscript");
  const rExecutable = join(root, "R");
  for (const path of [rscript, rExecutable]) writeFileSync(path, "executable fixture", { mode: 0o700 });
  const commands = [];
  return {
    root,
    directory: join(root, "private"),
    rscript,
    rExecutable,
    commands,
    options: {
      containedBy: root,
      environment: { PATH: "", R_LIBS: "foreign-library", R_PROFILE: "foreign-profile", RETAINED: "value" },
      async runCommand(input) {
        commands.push(input);
        return { stdout: rExecutable, stderr: "" };
      }
    }
  };
}

function commandCode(invocation) {
  assert.equal(invocation.input.args[0], "--vanilla");
  assert.equal(invocation.input.args[1], "-e");
  return invocation.input.args[2];
}

function preparedPackageInputs(prepared) {
  const install = commandCode(prepared.dependencyInstall);
  const probe = commandCode(prepared.dependencyProbe);
  const packageNames = /^\.ow_packages <- c\((.*)\)$/mu.exec(install);
  const expectedVersions = /^\.ow_expected <- c\((.*)\)$/mu.exec(probe);
  assert.ok(packageNames);
  assert.ok(expectedVersions);
  return {
    packages: JSON.parse(`[${packageNames[1]}]`),
    versions: Object.fromEntries(
      [...expectedVersions[1].matchAll(/("[^"]+") = ("[^"]+")/gu)].map((match) => [
        JSON.parse(match[1]),
        JSON.parse(match[2])
      ])
    )
  };
}

for (const nativeEditorTooling of [undefined, true, false]) {
  test(`prepared R dependency inputs and receipt agree for tooling=${nativeEditorTooling}`, async (t) => {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      ...(nativeEditorTooling === undefined ? {} : { nativeEditorTooling })
    });
    const packages = nativeEditorTooling === false ? notebookPackages : Object.keys(R_ACCEPTANCE_PACKAGE_VERSIONS);
    const versions = Object.fromEntries(packages.map((name) => [name, R_ACCEPTANCE_PACKAGE_VERSIONS[name]]));
    assert.deepEqual(preparedPackageInputs(prepared), { packages, versions });
    assert.deepEqual(prepared.packages, packages);
    assert.deepEqual(prepared.packageVersions, versions);
    assert.equal(prepared.packageRecord, packages.map((name) => `${name}=${versions[name]}`).join("\n"));
    for (const value of [prepared, prepared.packages, prepared.packageVersions]) assert.ok(Object.isFrozen(value));
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].executable, fixture.rscript);
    assert.equal(fixture.commands[0].environment.R_LIBS, undefined);
    assert.equal(fixture.commands[0].environment.R_PROFILE, undefined);
    assert.equal(prepared.rExecutable, fixture.rExecutable);
    for (const command of [prepared.dependencyInstall, prepared.dependencyProbe]) {
      assert.equal(command.input.executable, fixture.rscript);
      assert.equal(command.input.environment.R_LIBS_USER, prepared.libraryDir);
      assert.equal(command.input.environment.HOME, join(prepared.root, "h"));
      assert.equal(command.input.environment.RETAINED, "value");
      assert.equal(command.input.environment.R_LIBS, undefined);
    }
    const kernel = JSON.parse(readFileSync(prepared.kernelSpecPath, "utf8"));
    assert.deepEqual(kernel.argv, [fixture.rscript, "--vanilla", prepared.kernelBootstrapPath, "{connection_file}"]);
    assert.equal(kernel.env.R_LIBS_USER, prepared.libraryDir);
    assert.equal(prepared.jupyterEnvironment.rLibraryDir, prepared.libraryDir);
    assert.equal(prepared.dependencyProbe.options.timeoutMs, 30_000);
    assert.equal(prepared.dependencyInstall.options.timeoutMs, 1_200_000);
    assert.ok(Object.isFrozen(R_ACCEPTANCE_PACKAGE_VERSIONS));
    assert.equal(Object.keys(R_ACCEPTANCE_PACKAGE_VERSIONS).length, 11);
  });
}

test("invalid R tooling decisions fail before commands or private directories", async (t) => {
  const fixture = provisioning(t);
  for (const nativeEditorTooling of [null, 0, 1, "false", [], {}]) {
    await assert.rejects(
      prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
        ...fixture.options,
        nativeEditorTooling
      }),
      /native editor tooling decision/u
    );
    assert.equal(fixture.commands.length, 0);
    assert.equal(existsSync(fixture.directory), false);
  }
});

test("both R package scopes require the caller's contained private directory", async (t) => {
  const fixture = provisioning(t);
  const other = provisioning(t);
  for (const nativeEditorTooling of [false, true]) {
    await assert.rejects(
      prepareJupyterAcceptanceREnvironment(other.directory, fixture.rscript, {
        ...fixture.options,
        nativeEditorTooling
      }),
      /inside its caller-owned root/u
    );
    assert.equal(fixture.commands.length, 0);
    assert.equal(existsSync(other.directory), false);
  }
});

test("all R journey selectors retain their existing local and tooling boundaries", () => {
  const common = {
    acceptanceMode: "r-jupyter",
    requestedEditors: ["vscode"],
    remoteJupyterEnabled: false,
    platform: "linux"
  };
  for (const selector of [
    undefined,
    "core-operations",
    "categorical-operations",
    "value-operations",
    "pivot-wider",
    "kernel-restart",
    "native-frames",
    "interactive-terminal",
    "literate-documents"
  ]) {
    const selected = resolvePackagedRJourneySelection({ ...common, selector });
    assert.equal(selected.local, true);
    assert.equal(
      selected.nativeEditorTooling,
      selector === "interactive-terminal" || selector === "literate-documents"
    );
  }
  assert.equal(
    resolvePackagedRJourneySelection({ ...common, selector: "remote-r-jupyter", remoteJupyterEnabled: true }).local,
    false
  );
  assert.equal(resolvePackagedRJourneySelection({ ...common, acceptanceMode: "full" }).local, false);
  for (const options of [
    { selector: "unknown" },
    { selector: "core-operations", acceptanceMode: "full" },
    { selector: "core-operations", remoteJupyterEnabled: true },
    { selector: "remote-r-jupyter" }
  ])
    assert.throws(() => resolvePackagedRJourneySelection({ ...common, ...options }));
});

test("notebook roots retain supplemental installs and private dependency refusals on each platform", async (t) => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const fixture = provisioning(t);
    const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
      ...fixture.options,
      nativeEditorTooling: false,
      platform
    });
    const repositories = rAcceptanceRepositories(platform);
    assert.equal(prepared.repository, repositories.repository);
    assert.equal(prepared.supplementalRepository, repositories.supplementalRepository);
    const install = commandCode(prepared.dependencyInstall);
    assert.match(install, /\.ow_supplemental_packages <- c\("collapse", "nanoparquet"\)/u);
    assert.equal(install.includes('type = "source"'), platform === "darwin");
    assert.equal(install.includes('.ow_binary_supplemental_packages <- "nanoparquet"'), platform === "darwin");
    assert.match(install, /dependencies = NA/u);
    const probe = commandCode(prepared.dependencyProbe);
    assert.match(probe, /find\.package\(.ow_package, lib.loc = .ow_library, quiet = TRUE\)/u);
    assert.match(probe, /loadNamespace\(.ow_package, lib.loc = .ow_library\)/u);
    for (const status of [10, 11, 12, 13, 14, 15, 16, 17]) assert.ok(probe.includes(`status = ${status}L`));
    for (const factory of ["qDF", "qTBL", "qDT", "fgroup_by", "findex_by"])
      assert.ok(probe.includes(`collapse::${factory}(`));
  }
});

test("the selected R environment retains exact bootstrap ownership through readiness", async (t) => {
  const fixture = provisioning(t);
  const prepared = await prepareJupyterAcceptanceREnvironment(fixture.directory, fixture.rscript, {
    ...fixture.options,
    nativeEditorTooling: false
  });
  let probes = 0;
  const runCommand = async (input) => {
    probes += 1;
    assert.equal(input.environment.R_LIBS_USER, prepared.libraryDir);
    assert.equal(input.args[4], prepared.kernelSpecPath);
    appendFileSync(prepared.kernelBootstrapStagePath, "entered\nlibrary-ready\nirkernel-loaded\nmain-entered\n");
    return { stdout: "OPEN_WRANGLER_R_KERNEL_READY\n", stderr: "" };
  };
  await assert.rejects(
    probeJupyterAcceptanceRKernel(fixture.rscript, { ...prepared }, { runCommand }),
    /exact prepared environment/u
  );
  assert.equal(probes, 0);
  await probeJupyterAcceptanceRKernel(fixture.rscript, prepared, { runCommand });
  assert.equal(jupyterAcceptanceRKernelBootstrapStage(prepared), "not-entered");
  assert.equal(probes, 1);
  rmSync(prepared.kernelBootstrapStagePath);
  mkdirSync(prepared.kernelBootstrapStagePath);
  await assert.rejects(
    probeJupyterAcceptanceRKernel(fixture.rscript, prepared, { runCommand }),
    /bootstrap stage|identity/u
  );
  assert.equal(probes, 1);
});
