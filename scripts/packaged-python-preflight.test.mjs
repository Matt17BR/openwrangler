import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ACCEPTANCE_PYTHON_DEPENDENCY_ERROR,
  ACCEPTANCE_PYTHON_INTERPRETER_ERROR,
  acceptancePythonProbeSourceForTesting,
  acceptancePythonProfileModulesForTesting,
  packagedEditorPythonPreflightProfile,
  preflightAcceptancePython,
  resolveAcceptancePython,
  runAcceptancePythonPreflightCli
} from "./packaged-python-preflight.mjs";

function preparedTree() {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-python-preflight-"));
  const paths = {
    root,
    explicit: join(root, "explicit-python"),
    hostedRoot: join(root, "hosted"),
    hosted: join(root, "hosted", "bin", "python"),
    virtualRoot: join(root, "virtual"),
    virtual: join(root, "virtual", "bin", "python"),
    local: join(root, ".venv", "bin", "python")
  };
  for (const directory of [join(paths.hostedRoot, "bin"), join(paths.virtualRoot, "bin"), join(root, ".venv", "bin")]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const python of [paths.explicit, paths.hosted, paths.virtual, paths.local]) {
    writeFileSync(python, "prepared interpreter placeholder\n");
  }
  return paths;
}

test("acceptance Python resolution is explicit, hosted, active-venv, then exact repository venv", () => {
  const paths = preparedTree();
  try {
    const resolveWith = (environment) =>
      resolveAcceptancePython({ profile: "editor", repositoryRoot: paths.root, environment, platform: "linux" });
    assert.equal(
      resolveWith({
        OPEN_WRANGLER_TEST_PYTHON: paths.explicit,
        pythonLocation: paths.hostedRoot,
        VIRTUAL_ENV: paths.virtualRoot
      }),
      paths.explicit
    );
    assert.equal(resolveWith({ pythonLocation: paths.hostedRoot, VIRTUAL_ENV: paths.virtualRoot }), paths.hosted);
    assert.equal(resolveWith({ VIRTUAL_ENV: paths.virtualRoot }), paths.virtual);
    assert.equal(resolveWith({ PATH: "/never/searched" }), paths.local);

    for (const environment of [
      { OPEN_WRANGLER_TEST_PYTHON: "python3", pythonLocation: paths.hostedRoot },
      { OPEN_WRANGLER_TEST_PYTHON: join(paths.root, "missing"), pythonLocation: paths.hostedRoot },
      { pythonLocation: "relative-hosted", VIRTUAL_ENV: paths.virtualRoot },
      { pythonLocation: join(paths.root, "missing-hosted"), VIRTUAL_ENV: paths.virtualRoot },
      { VIRTUAL_ENV: "relative-virtual" }
    ]) {
      assert.throws(
        () => resolveWith(environment),
        (error) => {
          assert.equal(error.code, ACCEPTANCE_PYTHON_INTERPRETER_ERROR);
          assert.match(error.message, /^OW_ACCEPTANCE_PYTHON_INTERPRETER:/u);
          return true;
        }
      );
    }
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("fixed dependency profiles match ordinary, released-Jupyter, remote-only, and visual owners", () => {
  assert.deepEqual(acceptancePythonProfileModulesForTesting("interpreter-only"), []);
  assert.deepEqual(acceptancePythonProfileModulesForTesting("repository-command"), []);
  assert.deepEqual(acceptancePythonProfileModulesForTesting("editor"), [
    "pandas",
    "polars",
    "duckdb",
    "fsspec",
    "openpyxl",
    "pyarrow"
  ]);
  assert.deepEqual(acceptancePythonProfileModulesForTesting("jupyter-host"), ["jupyter_client"]);
  assert.deepEqual(acceptancePythonProfileModulesForTesting("jupyter-bootstrap"), [
    "ipykernel",
    "pandas",
    "polars",
    "duckdb",
    "fsspec"
  ]);
  assert.deepEqual(acceptancePythonProfileModulesForTesting("visual"), [
    "pandas",
    "polars",
    "duckdb",
    "fsspec",
    "nbformat",
    "nbclient",
    "ipykernel",
    "jupyter_client",
    "openwrangler_runtime"
  ]);
});

test("repository scripts that execute Python use the deterministic prepared-interpreter resolver", () => {
  for (const file of ["run-python.mjs", "run-pyright.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /resolveAndPreflightAcceptancePython\(\{[\s\S]*profile: "repository-command"/u, file);
    assert.doesNotMatch(source, /["']python3["']|\?\?\s*["']python["']|\bPATH\b/u, file);
  }
});

test("packaged editor modes choose the one fixed prerequisite profile they execute", () => {
  const profile = (acceptanceMode, overrides = {}) =>
    packagedEditorPythonPreflightProfile({
      acceptanceMode,
      jupyterExtensionEnabled: false,
      remoteOnly: false,
      literateDocuments: false,
      ...overrides
    });
  assert.equal(profile("full"), "editor");
  assert.equal(profile("full", { jupyterExtensionEnabled: true }), "editor-jupyter");
  assert.equal(profile("data-wrangler-coexistence", { jupyterExtensionEnabled: true }), "jupyter-bootstrap");
  assert.equal(profile("r-jupyter"), "jupyter-host");
  assert.equal(profile("r-jupyter", { literateDocuments: true }), "jupyter-host-literate");
  assert.equal(profile("r-jupyter", { remoteOnly: true }), "interpreter-only");
});

test("the bounded isolated probe emits fixed interpreter and dependency classifications", () => {
  const paths = preparedTree();
  try {
    let invocation;
    preflightAcceptancePython(paths.explicit, "editor", (executable, args, options) => {
      invocation = { executable, args, options };
    });
    assert.deepEqual(invocation, {
      executable: paths.explicit,
      args: [
        "-I",
        "-c",
        acceptancePythonProbeSourceForTesting,
        resolve(process.cwd(), "python"),
        "pandas",
        "polars",
        "duckdb",
        "fsspec",
        "openpyxl",
        "pyarrow"
      ],
      options: { stdio: "ignore", timeout: 15_000, windowsHide: true }
    });
    assert.match(acceptancePythonProbeSourceForTesting, /\(3, 10\).*\(3, 14\)/u);
    assert.match(acceptancePythonProbeSourceForTesting, /version\(name\) != "2026\.7\.0"/u);

    for (const [status, code] of [
      [20, ACCEPTANCE_PYTHON_DEPENDENCY_ERROR],
      [undefined, ACCEPTANCE_PYTHON_INTERPRETER_ERROR]
    ]) {
      assert.throws(
        () =>
          preflightAcceptancePython(paths.explicit, "editor", () => {
            const error = new Error("host-specific missing Polars detail");
            error.status = status;
            throw error;
          }),
        (error) => {
          assert.equal(error.code, code);
          assert.match(error.message, new RegExp(`^${code}:`, "u"));
          assert.doesNotMatch(error.message, /host-specific|missing Polars/u);
          return true;
        }
      );
    }
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("visual CLI checks the same explicit override and complete import set as capture", () => {
  const paths = preparedTree();
  try {
    let invocation;
    assert.equal(
      runAcceptancePythonPreflightCli(["visual"], {
        repositoryRoot: paths.root,
        environment: { OPEN_WRANGLER_PYTHON: paths.explicit, pythonLocation: paths.hostedRoot },
        platform: "linux",
        execute(executable, args) {
          invocation = { executable, args };
        }
      }),
      paths.explicit
    );
    assert.equal(invocation.executable, paths.explicit);
    assert.deepEqual(invocation.args.slice(4), acceptancePythonProfileModulesForTesting("visual"));
    assert.throws(() => runAcceptancePythonPreflightCli(["editor"]), /usage/u);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("Windows hosted and active-venv roots use their exact layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-python-preflight-windows-"));
  const hostedRoot = resolve(root, "hosted");
  const virtualRoot = resolve(root, "virtual");
  const hosted = resolve(hostedRoot, "python.exe");
  const virtual = resolve(virtualRoot, "Scripts", "python.exe");
  try {
    mkdirSync(hostedRoot, { recursive: true });
    mkdirSync(resolve(virtualRoot, "Scripts"), { recursive: true });
    writeFileSync(hosted, "prepared interpreter placeholder\n");
    writeFileSync(virtual, "prepared interpreter placeholder\n");
    const resolveWith = (environment) =>
      resolveAcceptancePython({ profile: "editor", repositoryRoot: root, platform: "win32", environment });
    assert.equal(resolveWith({ pythonLocation: hostedRoot, VIRTUAL_ENV: virtualRoot }), hosted);
    assert.equal(resolveWith({ VIRTUAL_ENV: virtualRoot }), virtual);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
