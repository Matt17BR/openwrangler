import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptancePythonForPhase,
  createRemoteJupyterAcceptanceToken,
  createJupyterAcceptanceKernelPython,
  probeJupyterAcceptancePython,
  writeJupyterAcceptanceEnvironment,
  writeRemoteJupyterAcceptanceDescriptor,
  writeRemoteJupyterAcceptanceEnvironment
} from "./jupyter-acceptance-environment.mjs";

const dependencyReport = (openwranglerRuntimePresent, overrides = {}) => ({
  ipykernel: "6.30.1",
  pandas: "2.3.3",
  polars: "1.35.2",
  openwranglerRuntimePresent,
  ...overrides
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
          if (input.label === "Released-Jupyter private kernel dependency installation") {
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
