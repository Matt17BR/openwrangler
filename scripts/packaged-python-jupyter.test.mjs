import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  packagedPythonJupyterEditorPlan,
  packagedPythonJupyterPySparkDistribution,
  resolvePackagedPythonJupyterProfile
} from "./packaged-python-jupyter.mjs";
import {
  acceptancePythonProfileModulesForTesting,
  packagedEditorPythonPreflightProfile
} from "./packaged-python-preflight.mjs";
import {
  createJupyterAcceptanceCoreKernelPython,
  createJupyterAcceptanceKernelPython,
  RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION
} from "./jupyter-acceptance-environment.mjs";

const focusedInput = {
  value: "python-notebooks",
  acceptanceMode: "full",
  jupyterExtensionEnabled: true,
  dataWranglerCoexistenceEnabled: false,
  remoteJupyterEnabled: false,
  requestedEditors: ["vscode"]
};
const notebookVersions = {
  ipykernel: "6.30.1",
  "jupyter-client": "8.9.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  duckdb: "1.5.4",
  fsspec: "2026.7.0",
  pytz: "2026.3.post1"
};

// Package installation is represented at the existing command boundary; real
// temporary paths still pass through production private-root identity checks.
function provisioning(t, { versions = notebookVersions, runtimePresent = false, javaAvailable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-python-notebook-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "kernel");
  const commands = [];
  const artifactDistributions = [];
  const options = {
    containedBy: root,
    environment: { PATH: "", JAVA_HOME: join(root, "no-java") },
    async acquirePySparkArtifact(_directory, distribution) {
      artifactDistributions.push(distribution);
      throw new Error("test stopped at Spark artifact acquisition");
    },
    async runCommand(input) {
      commands.push(input);
      if (input.args.includes("-XshowSettings:properties")) {
        if (!javaAvailable) throw new Error("test Java unavailable");
        return { stdout: "", stderr: "java.specification.version = 17\njava.version = 17.0.1\n" };
      }
      if (input.args.includes("venv")) {
        const python = join(input.args.at(-1), process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        mkdirSync(dirname(python), { recursive: true });
        writeFileSync(python, "private interpreter fixture", { mode: 0o700 });
      }
      if (input.args.includes("-c")) {
        return { stdout: JSON.stringify({ ...versions, openwranglerRuntimePresent: runtimePresent }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }
  };
  return { root, directory, commands, options, artifactDistributions };
}

test("focused Python notebooks retains both real journeys and needs only a bootstrap host", () => {
  const profile = resolvePackagedPythonJupyterProfile(focusedInput);
  const plan = packagedPythonJupyterEditorPlan(profile, "vscode", false);
  assert.deepEqual(plan, {
    phases: ["jupyter-deny", "jupyter-allow"],
    remote: false,
    allowSelector: undefined,
    pysparkSelector: undefined,
    integrationOnly: true
  });
  assert.equal(
    packagedPythonJupyterPySparkDistribution(profile, RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION),
    undefined
  );
  const host = packagedEditorPythonPreflightProfile({ ...focusedInput, pythonJupyterProfile: profile });
  assert.equal(host, "jupyter-bootstrap");
  assert.deepEqual(acceptancePythonProfileModulesForTesting(host), ["venv", "ensurepip"]);
});

test("focused Python notebooks rejects requests for coverage it cannot run", () => {
  for (const invalid of [
    { value: "unknown" },
    { acceptanceMode: "platform-smoke" },
    { jupyterExtensionEnabled: false },
    { dataWranglerCoexistenceEnabled: true },
    { remoteJupyterEnabled: true },
    { requestedEditors: undefined },
    { requestedEditors: ["cursor"] },
    { requestedEditors: ["vscode", "cursor"] }
  ]) {
    assert.throws(() => resolvePackagedPythonJupyterProfile({ ...focusedInput, ...invalid }));
  }
});

test("default and prerelease-denial profiles preserve their existing qualification scope", () => {
  assert.deepEqual(packagedPythonJupyterEditorPlan(undefined, "vscode", true), {
    phases: ["jupyter-deny", "jupyter-allow", "jupyter-pyspark"],
    remote: true,
    allowSelector: undefined,
    pysparkSelector: undefined,
    integrationOnly: false
  });
  const profile = resolvePackagedPythonJupyterProfile({ ...focusedInput, value: "pyspark-prerelease-denial" });
  assert.deepEqual(packagedPythonJupyterEditorPlan(profile, "vscode", false), {
    phases: ["jupyter-pyspark"],
    remote: false,
    allowSelector: undefined,
    pysparkSelector: "pyspark-prerelease-denial",
    integrationOnly: true
  });
  assert.equal(
    packagedPythonJupyterPySparkDistribution(profile, RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION),
    RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION
  );
  assert.equal(
    packagedEditorPythonPreflightProfile({ ...focusedInput, pythonJupyterProfile: undefined }),
    "editor-jupyter"
  );
});

test("ordinary notebook environment pins every local engine without Java, Spark or a host engine probe", async (t) => {
  const fixture = provisioning(t);
  const python = await createJupyterAcceptanceKernelPython(fixture.directory, process.execPath, {
    ...fixture.options,
    includePySpark: false
  });
  assert.ok(existsSync(python));
  assert.equal(fixture.artifactDistributions.length, 0);
  assert.equal(fixture.commands.length, 3);
  const [venv, install, probe] = fixture.commands;
  assert.deepEqual(venv.args.slice(0, 3), ["-I", "-m", "venv"]);
  assert.equal(venv.executable, process.execPath);
  assert.equal(install.executable, python);
  assert.ok(install.args.includes("--isolated"));
  assert.ok(install.args.includes("--only-binary=:all:"));
  assert.deepEqual(
    install.args.filter((arg) => arg.includes("==")),
    Object.entries(notebookVersions).map(([name, version]) => `${name}==${version}`)
  );
  assert.equal(probe.executable, python);
  for (const name of Object.keys(notebookVersions))
    assert.ok(probe.args.at(-1).includes(`import ${name.replaceAll("-", "_")}`));
  assert.doesNotMatch(probe.args.at(-1), /import (?:pyspark|py4j|pyarrow|grpc)/u);
});

for (const dependency of ["polars", "duckdb", "fsspec", "pytz"]) {
  test(`ordinary notebook environment rejects missing and wrong ${dependency}`, async (t) => {
    for (const version of [undefined, "0.0.1"]) {
      const fixture = provisioning(t, { versions: { ...notebookVersions, [dependency]: version } });
      await assert.rejects(
        createJupyterAcceptanceKernelPython(fixture.directory, process.execPath, {
          ...fixture.options,
          includePySpark: false
        }),
        new RegExp(dependency, "u")
      );
      assert.equal(fixture.artifactDistributions.length, 0);
    }
  });
}

test("ordinary notebook environment rejects an already installed Open Wrangler runtime", async (t) => {
  const fixture = provisioning(t, { runtimePresent: true });
  await assert.rejects(
    createJupyterAcceptanceKernelPython(fixture.directory, process.execPath, {
      ...fixture.options,
      includePySpark: false
    }),
    /exposes openwrangler_runtime/u
  );
});

test(
  "full environment still requires Java before creating its private environment",
  { skip: process.platform !== "linux" },
  async (t) => {
    const fixture = provisioning(t);
    await assert.rejects(
      createJupyterAcceptanceKernelPython(fixture.directory, process.execPath, fixture.options),
      /Java/u
    );
    assert.equal(existsSync(fixture.directory), false);
    assert.equal(fixture.commands.length, 1);
  }
);

test(
  "full and prerelease environments still install Spark support and acquire their sealed artifact",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const distribution of [undefined, RELEASED_PYSPARK_PRERELEASE_DENIAL_DISTRIBUTION]) {
      const fixture = provisioning(t, { javaAvailable: true });
      await assert.rejects(
        createJupyterAcceptanceKernelPython(fixture.directory, process.execPath, {
          ...fixture.options,
          pysparkDistribution: distribution
        }),
        /test stopped at Spark artifact acquisition/u
      );
      assert.equal(fixture.artifactDistributions.length, 1);
      const actualDistribution = fixture.artifactDistributions[0];
      if (distribution === undefined) {
        assert.equal(actualDistribution.mode, "stable-qualification");
        assert.equal(actualDistribution.version, "4.2.0");
      } else {
        assert.deepEqual(actualDistribution, distribution);
      }
      const install = fixture.commands.find((command) => command.args.includes("install"));
      for (const name of ["py4j", "pyarrow", "grpcio", "grpcio-status", "protobuf"]) {
        assert.ok(install.args.some((argument) => argument.startsWith(`${name}==`)));
      }
    }
  }
);

test("core environment keeps its smaller package boundary", async (t) => {
  const fixture = provisioning(t);
  await createJupyterAcceptanceCoreKernelPython(fixture.directory, process.execPath, fixture.options);
  assert.equal(fixture.artifactDistributions.length, 0);
  const install = fixture.commands.find((command) => command.args.includes("install"));
  assert.deepEqual(
    install.args.filter((argument) => argument.includes("==")),
    ["ipykernel==6.30.1", "jupyter-client==8.9.1", "pandas==2.3.3"]
  );
});
