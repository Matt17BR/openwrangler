import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildKernelRuntimeBundle, readRuntimeFiles } from "../extension/notebooks/kernelRuntimeBundle";
import { releasedJupyterNotebookFixture } from "./extensionHost/releasedJupyterNotebookFixture";
import { releasedPySparkNotebookFixture } from "./extensionHost/releasedPySparkNotebookFixture";
import { resetKernelBridgeTestState } from "./kernelBridge.testFixtures";

const runtimeFiles = {
  "openwrangler_runtime/__init__.py": 'VERSION = "2.1.0"\n',
  "openwrangler_runtime/kernel_agent.py": "manager = object()\n",
  "openwrangler_runtime/notebook.py":
    "handles = {'frame': object()}\ncalls = 0\ndef register_formatters():\n    global calls\n    calls += 1\n    return True\n"
};

function runBootstrapPython(body: string, withoutSite = false): void {
  const result = spawnSync(
    process.env.OPEN_WRANGLER_TEST_PYTHON ?? "python3",
    ["-I", ...(withoutSite ? ["-S"] : []), "-"],
    {
      input: `import builtins, gc, os, pathlib, stat, sys, tempfile, types
with tempfile.TemporaryDirectory(prefix="ow-bootstrap-test-") as fixture:
    original_temp = tempfile.tempdir
    os.environ["LOCALAPPDATA"] = fixture
    parent = pathlib.Path(fixture) / "Temp"
    parent.mkdir(mode=0o700)
    tempfile.tempdir = str(parent)
    try:
${body
  .trim()
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
    finally:
        owner = sys.modules.get("openwrangler_runtime")
        provenance = getattr(owner, "__openwrangler_bundle_provenance__", None)
        if provenance is not None:
            provenance[1].cleanup()
        tempfile.tempdir = original_temp
`,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 128 * 1024,
      windowsHide: true
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

afterEach(resetKernelBridgeTestState);

describe("released notebook runtime origin receipts", () => {
  it.each([
    ["cold", false],
    ["ready", true],
    ["unrelated", false],
    ["legacy-marker", false],
    ["stale-digest", false],
    ["wrong-identity", false],
    ["missing-agent", false],
    ["mixed-agent", false],
    ["mixed-package", false],
    ["missing-path", false],
    ["expired-lease", false],
    ["unrelated-child", true]
  ] as const)("observes %s origin in both fixtures without changing runtime state", (kind, expected) => {
    const extensionPath = process.cwd();
    const target = { name: "fixture-kernel", label: "Fixture kernel" };
    const bundle = buildKernelRuntimeBundle(readRuntimeFiles(resolve(extensionPath, "python")));
    const cells = [
      releasedJupyterNotebookFixture("fixture-marker", target, extensionPath).cells[3]!.source.join(""),
      releasedPySparkNotebookFixture(extensionPath, target).cells[0]!.source.join("")
    ];
    runBootstrapPython(
      `
import contextlib, importlib.util, io, json
kind = ${JSON.stringify(kind)}
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
if kind not in ("cold", "unrelated", "legacy-marker"):
    assert namespace["__ow_bootstrap_runtime"](False) == "ready"
    owner = sys.modules["openwrangler_runtime"]
    provenance = owner.__openwrangler_bundle_provenance__
    if kind == "stale-digest":
        owner.__openwrangler_bundle_provenance__ = ("0" * 64, provenance[1], provenance[2])
    elif kind == "wrong-identity":
        owner.__openwrangler_bundle_provenance__ = (provenance[0], provenance[1], (provenance[2][0], provenance[2][1] + 1))
    elif kind == "missing-agent":
        del sys.modules["openwrangler_runtime.kernel_agent"]
    elif kind == "mixed-agent":
        sys.modules["openwrangler_runtime.kernel_agent"].__file__ = "/synthetic/unrelated.py"
    elif kind == "mixed-package":
        owner.__file__ = "/synthetic/unrelated.py"
    elif kind == "missing-path":
        sys.path.remove(provenance[1].name)
    elif kind == "expired-lease":
        provenance[1].cleanup()
    elif kind == "unrelated-child":
        child = types.ModuleType("openwrangler_runtime.unrelated")
        child.__file__ = "/synthetic/unrelated.py"
        sys.modules[child.__name__] = child
elif kind != "cold":
    unrelated = parent / "unrelated"
    package = unrelated / "openwrangler_runtime"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("FIXTURE = True\\n")
    sys.path.insert(0, str(unrelated))
    importlib.import_module("openwrangler_runtime")
source = {"values": [1, 2]}
agent = sys.modules.get("openwrangler_runtime.kernel_agent")
manager = agent.__dict__.get("_manager") if agent is not None else None
sessions = dict(manager.sessions) if manager is not None else None
receipts = []
for cell in ${JSON.stringify(cells)}:
    modules = {name: (id(module), tuple((key, id(value)) for key, value in module.__dict__.items()))
               for name, module in sys.modules.items() if name == "openwrangler_runtime" or name.startswith("openwrangler_runtime.")}
    paths = list(sys.path)
    contents = {str(path): path.read_bytes() for path in parent.rglob("*") if path.is_file()}
    scope = {"openwrangler_restart_marker": "fixture-marker", "source": source}
    if kind == "legacy-marker": scope["__ow_bundle_root"] = str(unrelated)
    with contextlib.redirect_stdout(io.StringIO()) as output:
        exec(cell, scope)
    receipt = json.loads(output.getvalue().split("__OW_RELEASED_RESTART__")[1])
    assert receipt["pid"] == os.getpid()
    assert receipt["runtime"] == (kind != "cold")
    assert receipt["setup"] == ("fixture-marker" if len(receipts) == 0 else None)
    assert {name: (id(module), tuple((key, id(value)) for key, value in module.__dict__.items()))
            for name, module in sys.modules.items() if name == "openwrangler_runtime" or name.startswith("openwrangler_runtime.")} == modules
    assert sys.path == paths
    assert {str(path): path.read_bytes() for path in parent.rglob("*") if path.is_file()} == contents
    assert scope["source"] is source and source == {"values": [1, 2]}
    if manager is not None:
        assert agent.__dict__["_manager"] is manager and manager.sessions == sessions
    receipts.append(receipt["bootstrap"])
assert receipts == [${expected ? "True" : "False"}] * 2, (kind, receipts)
`,
      true
    );
  });
});

describe("remote kernel runtime bootstrap", () => {
  it("binds deterministic source bytes to a full digest without referencing the extension filesystem", () => {
    const bundle = buildKernelRuntimeBundle(runtimeFiles);
    expect(bundle).toEqual(buildKernelRuntimeBundle(Object.fromEntries(Object.entries(runtimeFiles).reverse())));
    expect(bundle.bundleId).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      buildKernelRuntimeBundle({ ...runtimeFiles, "openwrangler_runtime/kernel_agent.py": "changed = True\n" }).bundleId
    ).not.toBe(bundle.bundleId);
    expect(bundle.code).toContain("base64.b64decode");
    expect(bundle.code).not.toContain("VERSION =");
    expect(bundle.code).not.toContain("extensionPath");
  });

  it("rejects incomplete or unsafe bundles", () => {
    expect(() => buildKernelRuntimeBundle({ "openwrangler_runtime/kernel_agent.py": "" })).toThrow(
      "missing openwrangler_runtime/__init__.py"
    );
    expect(() =>
      buildKernelRuntimeBundle({
        "openwrangler_runtime/__init__.py": "",
        "openwrangler_runtime/../escape.py": ""
      })
    ).toThrow("Unsafe bundled kernel runtime path");
  });

  it("reuses only the same private bundle across execution namespaces without losing managers or formatter handles", () => {
    const bundle = buildKernelRuntimeBundle(runtimeFiles);
    runBootstrapPython(`
first = {}
exec(${JSON.stringify(bundle.code)}, first)
assert first["__ow_bootstrap_runtime"](True) == "ready"
import openwrangler_runtime as owner
from openwrangler_runtime import kernel_agent, notebook
manager, handle = kernel_agent.manager, notebook.handles["frame"]
provenance = owner.__openwrangler_bundle_provenance__
root = pathlib.Path(provenance[1].name)
assert provenance[0] == ${JSON.stringify(bundle.bundleId)}
assert root.parent == parent
if os.name == "posix":
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
second = {}
exec(${JSON.stringify(bundle.code)}, second)
gc.collect()
assert second["__ow_bootstrap_runtime"](True) == "ready"
assert owner.__openwrangler_bundle_provenance__ is provenance
assert kernel_agent.manager is manager and notebook.handles["frame"] is handle
assert notebook.calls == 2
assert list(parent.iterdir()) == [root]
assert (root / "openwrangler_runtime/kernel_agent.py").is_file()
`);
  });

  it.each(["changed", "legacy", "partial", "missing-agent", "foreign-child"] as const)(
    "refuses %s loaded modules before changing import paths, source, or live handles",
    (kind) => {
      const bundle = buildKernelRuntimeBundle(runtimeFiles);
      const next =
        kind === "changed"
          ? buildKernelRuntimeBundle({
              ...runtimeFiles,
              "openwrangler_runtime/kernel_agent.py": "manager = object()\nCHANGED = True\n"
            })
          : bundle;
      runBootstrapPython(`
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
assert namespace["__ow_bootstrap_runtime"](True) == "ready"
import openwrangler_runtime as owner
from openwrangler_runtime import kernel_agent, notebook
lease = owner.__openwrangler_bundle_provenance__[1]
manager, handle = kernel_agent.manager, notebook.handles["frame"]
kind = ${JSON.stringify(kind)}
if kind == "legacy":
    del owner.__openwrangler_bundle_provenance__
elif kind == "partial":
    del sys.modules["openwrangler_runtime"]
elif kind == "missing-agent":
    del sys.modules["openwrangler_runtime.kernel_agent"]
elif kind == "foreign-child":
    child = types.ModuleType("openwrangler_runtime.foreign")
    child.__file__ = str(parent / "foreign.py")
    sys.modules[child.__name__] = child
modules = {name: module for name, module in sys.modules.items() if name.startswith("openwrangler_runtime")}
paths = list(sys.path)
contents = {str(path): path.read_bytes() for path in parent.rglob("*") if path.is_file()}
other_namespace = {}
exec(${JSON.stringify(next.code)}, other_namespace)
assert other_namespace["__ow_bootstrap_runtime"](True) == "outdated"
assert {name: module for name, module in sys.modules.items() if name.startswith("openwrangler_runtime")} == modules
assert sys.path == paths
assert {str(path): path.read_bytes() for path in parent.rglob("*") if path.is_file()} == contents
assert kernel_agent.manager is manager and notebook.handles["frame"] is handle
assert notebook.calls == 1
lease.cleanup()
`);
    }
  );

  it("ignores a prepopulated legacy cache and its completion marker", () => {
    const bundle = buildKernelRuntimeBundle(runtimeFiles);
    runBootstrapPython(`
legacy = parent / "openwrangler-runtime" / ${JSON.stringify(bundle.bundleId.slice(0, 16))}
package = legacy / "openwrangler_runtime"
package.mkdir(parents=True)
(package / "__init__.py").write_text("import builtins; builtins.ow_cache_canary = True\\n")
(legacy / ".complete").write_text("unverified")
contents = {str(path): path.read_bytes() for path in legacy.rglob("*") if path.is_file()}
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
assert namespace["__ow_bootstrap_runtime"](False) == "ready"
assert not hasattr(builtins, "ow_cache_canary")
assert {str(path): path.read_bytes() for path in legacy.rglob("*") if path.is_file()} == contents
import openwrangler_runtime
assert pathlib.Path(openwrangler_runtime.__file__).parent != package
`);
  });

  it.each(["kernel_agent", "__init__"] as const)(
    "preserves %s import errors and refuses surviving partial modules after owned cleanup",
    (failingModule) => {
      const bundle = buildKernelRuntimeBundle({
        ...runtimeFiles,
        "openwrangler_runtime/child.py": "value = object()\n",
        [`openwrangler_runtime/${failingModule}.py`]:
          'from . import child\nraise RuntimeError("owned import failure")\n'
      });
      runBootstrapPython(`
keep = parent / "keep.txt"
keep.write_text("unchanged")
paths = list(sys.path)
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
try:
    namespace["__ow_bootstrap_runtime"](False)
except RuntimeError as error:
    assert str(error) == "owned import failure"
else:
    raise AssertionError("Import failure was swallowed")
assert sys.path == paths and list(parent.iterdir()) == [keep]
assert keep.read_text() == "unchanged"
assert "openwrangler_runtime.child" in sys.modules
assert ("openwrangler_runtime" in sys.modules) == ${failingModule === "kernel_agent" ? "True" : "False"}
assert namespace["__ow_bootstrap_runtime"](False) == "outdated"
`);
    }
  );

  it("preserves formatter exceptions and the already verified package lifetime", () => {
    const bundle = buildKernelRuntimeBundle({
      ...runtimeFiles,
      "openwrangler_runtime/notebook.py":
        'def register_formatters():\n    raise RuntimeError("owned formatter failure")\n'
    });
    runBootstrapPython(`
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
try:
    namespace["__ow_bootstrap_runtime"](True)
except RuntimeError as error:
    assert str(error) == "owned formatter failure"
else:
    raise AssertionError("Formatter failure was swallowed")
import openwrangler_runtime as owner
root = pathlib.Path(owner.__openwrangler_bundle_provenance__[1].name)
assert (root / "openwrangler_runtime/notebook.py").is_file()
assert namespace["__ow_bootstrap_runtime"](False) == "ready"
`);
  });

  it("checks child provenance after optional formatter imports", () => {
    const bundle = buildKernelRuntimeBundle({
      ...runtimeFiles,
      "openwrangler_runtime/notebook.py":
        "import sys, types\ndef register_formatters():\n    sys.modules['openwrangler_runtime.foreign'] = types.ModuleType('openwrangler_runtime.foreign')\n"
    });
    runBootstrapPython(`
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
assert namespace["__ow_bootstrap_runtime"](True) == "outdated"
assert "openwrangler_runtime.foreign" in sys.modules
assert namespace["__ow_bootstrap_runtime"](False) == "outdated"
`);
  });

  it("refuses a replaced private directory without deleting loaded modules or replacement contents", () => {
    const bundle = buildKernelRuntimeBundle(runtimeFiles);
    runBootstrapPython(`
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
assert namespace["__ow_bootstrap_runtime"](False) == "ready"
import openwrangler_runtime as owner
from openwrangler_runtime import kernel_agent
root = pathlib.Path(owner.__openwrangler_bundle_provenance__[1].name)
original = parent / "original"
root.rename(original)
root.mkdir(mode=0o700)
canary = root / "canary"
canary.write_text("replacement")
paths, manager = list(sys.path), kernel_agent.manager
assert namespace["__ow_bootstrap_runtime"](False) == "outdated"
assert sys.path == paths and kernel_agent.manager is manager
assert canary.read_text() == "replacement"
assert (original / "openwrangler_runtime/kernel_agent.py").is_file()
`);
  });

  it.runIf(process.platform !== "win32")(
    "uses the canonical protected parent and ignores a legacy cache symlink",
    () => {
      const bundle = buildKernelRuntimeBundle(runtimeFiles);
      runBootstrapPython(`
alias = pathlib.Path(fixture) / "alias"
alias.symlink_to(parent, target_is_directory=True)
tempfile.tempdir = str(alias)
legacy = pathlib.Path(fixture) / "legacy"
legacy.mkdir()
(legacy / ".complete").write_text("unverified")
(parent / "openwrangler-runtime").symlink_to(legacy, target_is_directory=True)
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
assert namespace["__ow_bootstrap_runtime"](False) == "ready"
import openwrangler_runtime as owner
assert pathlib.Path(owner.__openwrangler_bundle_provenance__[1].name).parent == parent
assert list(legacy.iterdir()) == [legacy / ".complete"]
assert (parent / "openwrangler-runtime").is_symlink()
`);
    }
  );

  it.runIf(process.platform === "win32")(
    "refuses a custom Windows temporary path before importing or creating files",
    () => {
      const bundle = buildKernelRuntimeBundle(runtimeFiles);
      runBootstrapPython(`
custom = pathlib.Path(fixture) / "Custom"
custom.mkdir(mode=0o700)
tempfile.tempdir = str(custom)
paths = list(sys.path)
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
assert namespace["__ow_bootstrap_runtime"](False) == "unsafe_temp"
assert sys.path == paths and list(custom.iterdir()) == []
assert "openwrangler_runtime" not in sys.modules
`);
    }
  );

  it.runIf(process.platform !== "win32")(
    "refuses a writable non-sticky parent before creating files or importing",
    () => {
      const bundle = buildKernelRuntimeBundle(runtimeFiles);
      runBootstrapPython(`
parent.chmod(0o770)
paths = list(sys.path)
namespace = {}
exec(${JSON.stringify(bundle.code)}, namespace)
try:
    assert namespace["__ow_bootstrap_runtime"](False) == "unsafe_temp"
    assert sys.path == paths and list(parent.iterdir()) == []
    assert "openwrangler_runtime" not in sys.modules
finally:
    parent.chmod(0o700)
`);
    }
  );
});
