import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptancePythonForPhase,
  createJupyterAcceptanceKernelPython,
  probeJupyterAcceptancePython,
  writeJupyterAcceptanceEnvironment,
  writeRemoteJupyterAcceptanceEnvironment
} from "./jupyter-acceptance-environment.mjs";

const dependencyReport = (openwranglerRuntimePresent, overrides = {}) => ({
  ipykernel: "6.30.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  openwranglerRuntimePresent,
  ...overrides
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
  assert.equal(acceptancePythonForPhase("jupyter-remote", normalPython, kernelPython), normalPython);
  assert.throws(
    () => acceptancePythonForPhase("jupyter-allow", normalPython, undefined),
    /dedicated private kernel interpreter/u
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

test("released-Jupyter installs exact base versions into a clean run-owned kernel environment", async () => {
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
        if (input.label === "Released-Jupyter private kernel environment creation") {
          const venvDirectory = input.args.at(-1);
          mkdirSync(join(venvDirectory, "bin"), { recursive: true });
          writeFileSync(join(venvDirectory, "bin", "python"), "private interpreter placeholder\n");
        }
        if (input.label === "Released-Jupyter base dependency version probe") {
          return { stdout: JSON.stringify(dependencyReport(true)) };
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
    assert.equal(commands.length, 4);
    assert.equal(commands[0].input.executable, basePython);
    assert.match(commands[0].input.args.at(-1), /find_spec\("openwrangler_runtime"\)/u);
    assert.equal(commands[1].input.executable, basePython);
    assert.deepEqual(commands[1].input.args.slice(0, 3), ["-I", "-m", "venv"]);
    assert.equal(commands[2].input.executable, kernelPython);
    assert.deepEqual(commands[2].input.args.slice(0, 5), ["-I", "-m", "pip", "--isolated", "install"]);
    assert.ok(commands[2].input.args.includes("--only-binary=:all:"));
    assert.deepEqual(commands[2].input.args.slice(-3), ["ipykernel==6.30.1", "pandas==2.3.3", "polars==1.35.2"]);
    assert.equal(
      commands[2].input.args.some((value) => /openwrangler.runtime/iu.test(value)),
      false
    );
    assert.equal(commands[3].input.executable, kernelPython);
    assert.match(commands[3].input.args.at(-1), /find_spec\("openwrangler_runtime"\)/u);
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
        async runCommand() {
          calls += 1;
          return {
            stdout: JSON.stringify(dependencyReport(true, { pandas: "2.3.3; openwrangler-runtime" }))
          };
        }
      }),
      /safe pandas version/u
    );
    assert.equal(calls, 1);
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
