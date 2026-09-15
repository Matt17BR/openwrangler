import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  classifyDependencyProbe,
  probeDependencies,
  PYTHON_DEPENDENCY_VERSION_MAX_LENGTH,
  type PythonEnvironment
} from "../extension/pythonEnvironment";
import type { PythonDependency } from "../extension/pythonEnvironmentModel";

const execFileAsync = promisify(execFile);

interface VersionContract {
  maximumVersionLength: number;
  dependency: PythonDependency;
  cases: { name: string; version: string; supported: boolean }[];
}

describe("selected-interpreter PEP 440 dependency probing", () => {
  it("trusts only the selected interpreter's compatibility decision", () => {
    const dependency = contract().dependency;
    expect(classifyDependencyProbe([dependency], [true])).toEqual({
      missing: []
    });
    for (const observed of [false, "true"] as const) {
      expect(classifyDependencyProbe([dependency], [observed] as readonly boolean[])).toEqual({
        missing: [dependency.installSpec]
      });
    }
    const ordered = [dependency, { ...dependency, installSpec: "middle" }, { ...dependency, installSpec: "last" }];
    expect(classifyDependencyProbe(ordered, [false, true, false])).toEqual({
      missing: [dependency.installSpec, "last"]
    });
  });

  it("matches the post-install PEP 440 contract in a real isolated probe", async () => {
    const fixture = contract();
    expect(fixture.maximumVersionLength).toBe(PYTHON_DEPENDENCY_VERSION_MAX_LENGTH);
    const root = await mkdtemp(path.join(tmpdir(), "openwrangler-pep440-probe-"));
    try {
      const environmentRoot = path.join(root, "venv");
      await execFileAsync(selectedPython(), ["-m", "venv", environmentRoot], { timeout: 30_000 });
      const executable = path.join(
        environmentRoot,
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
      );
      const { stdout } = await execFileAsync(
        executable,
        [
          "-I",
          "-c",
          [
            "import json,os,sys,sysconfig",
            "executable=os.path.abspath(sys.executable); root=os.path.realpath(os.path.abspath(sys.prefix))",
            "e=os.stat(executable); r=os.stat(root)",
            "print(json.dumps({'purelib':sysconfig.get_path('purelib'),'environment':{",
            "'executable':executable,'executableIdentity':{",
            "'device':str(e.st_dev),'inode':str(e.st_ino),'size':str(e.st_size),",
            "'mtimeNs':str(e.st_mtime_ns),'ctimeNs':str(e.st_ctime_ns)},",
            "'version':'.'.join(str(p) for p in sys.version_info[:3]),",
            "'packageRoot':root,'packageRootIdentity':{'device':str(r.st_dev),'inode':str(r.st_ino)},",
            "'source':'configuration'}}))"
          ].join("\n")
        ],
        { timeout: 10_000 }
      );
      const { purelib, environment } = JSON.parse(stdout) as {
        purelib: string;
        environment: PythonEnvironment;
      };
      const probe = (dependencies: readonly PythonDependency[]) =>
        probeDependencies(
          environment,
          dependencies,
          path.join(process.cwd(), "python", "openwrangler_runtime", "dependency_guard.py")
        );
      const modulePath = path.join(purelib, `${fixture.dependency.importModule}.py`);
      await writeFile(modulePath, "VALUE = 1\n", "utf8");
      const metadataRoot = path.join(purelib, `${fixture.dependency.importModule}-0.dist-info`);
      await mkdir(metadataRoot);
      const metadataPath = path.join(metadataRoot, "METADATA");
      const recordPath = path.join(metadataRoot, "RECORD");
      const ownedRoot = path.join(purelib, "owned-distribution-module");
      await mkdir(ownedRoot);
      await writeFile(path.join(ownedRoot, `${fixture.dependency.importModule}.py`), "VALUE = 2\n", "utf8");
      await writeFile(
        metadataPath,
        ["Metadata-Version: 2.1", `Name: ${fixture.dependency.distribution}`, "Version: 1.5.4", ""].join("\n"),
        "utf8"
      );
      await writeFile(recordPath, `owned-distribution-module/${fixture.dependency.importModule}.py,,\n`, "utf8");
      await expect(probe([fixture.dependency]), "shadowed import module").resolves.toEqual({
        missing: [fixture.dependency.installSpec]
      });
      await writeFile(recordPath, `${fixture.dependency.importModule}.py,,\n`, "utf8");
      const rejected = { missing: [fixture.dependency.installSpec] };

      await writeFile(modulePath, "__file__ = __file__ + '.moved'\n", "utf8");
      await expect(probe([fixture.dependency]), "path-changing module").resolves.toEqual(rejected);
      await writeFile(modulePath, "VALUE = 1\n", "utf8");

      if (process.platform === "win32") {
        await writeFile(
          modulePath,
          ["import os", '__file__ = os.path.join(os.path.dirname(__file__), ".", os.path.basename(__file__))', ""].join(
            "\n"
          ),
          "utf8"
        );
        await expect(probe([fixture.dependency]), "dot-component module origin").resolves.toEqual(rejected);

        const redundant = path.join(purelib, "origin-redundant");
        await mkdir(redundant);
        await writeFile(
          modulePath,
          [
            "import os",
            `__file__ = os.path.join(os.path.dirname(__file__), ${JSON.stringify(path.basename(redundant))}, "..", os.path.basename(__file__))`,
            ""
          ].join("\n"),
          "utf8"
        );
        await expect(probe([fixture.dependency]), "redundant module origin").resolves.toEqual(rejected);
        await writeFile(modulePath, "VALUE = 1\n", "utf8");
      }
      const changingPackage = path.join(purelib, fixture.dependency.importModule);
      await unlink(modulePath);
      for (const change of ["sibling", "ancestor-replacement"] as const) {
        await mkdir(changingPackage);
        const mutationMarker = path.join(root, `observed-${change}`);
        await writeFile(
          path.join(changingPackage, "__init__.py"),
          [
            "import os, sys",
            "_probe_file = __file__",
            "_probe_parent = os.path.dirname(__file__)",
            "_probe_parent_stat = os.stat(_probe_parent)",
            "def _probe_leaf_state():",
            " v = os.stat(_probe_file)",
            " return (v.st_dev,v.st_ino,v.st_mode,v.st_nlink,v.st_size,v.st_mtime_ns,v.st_ctime_ns)",
            "_probe_before = _probe_leaf_state()",
            "_probe_changed = False",
            "def _probe_mutate():",
            " global _probe_changed",
            " _probe_changed = True",
            ...(change === "sibling"
              ? [
                  " os.mkdir(os.path.join(_probe_parent,'sibling'))",
                  " os.utime(_probe_parent,ns=(_probe_parent_stat.st_atime_ns,_probe_parent_stat.st_mtime_ns+2000000000))",
                  " assert os.stat(_probe_parent).st_mtime_ns != _probe_parent_stat.st_mtime_ns",
                  " assert _probe_leaf_state() == _probe_before"
                ]
              : [
                  " os.rename(_probe_parent,_probe_parent+'.moved')",
                  " os.mkdir(_probe_parent)",
                  " with open(_probe_file,'w') as output: output.write('VALUE = 2\\n')"
                ]),
            ` with open(${JSON.stringify(mutationMarker)},'w') as marker: marker.write('changed')`,
            "_probe_original_open = os.open",
            "def _probe_open(filename,*args,**kwargs):",
            " descriptor = _probe_original_open(filename,*args,**kwargs)",
            " if filename == '__init__.py' and not _probe_changed: _probe_mutate()",
            " return descriptor",
            "def _probe_trace(frame,event,arg):",
            " if event == 'line' and frame.f_code.co_name == '_windows_regular_module_file_identity' and frame.f_locals.get('is_file') and not _probe_changed: _probe_mutate()",
            " return _probe_trace",
            "if os.name == 'nt': sys.settrace(_probe_trace)",
            "else: os.open = _probe_open",
            ""
          ].join("\n"),
          "utf8"
        );
        await writeFile(recordPath, `${fixture.dependency.importModule}/__init__.py,,\n`, "utf8");
        await expect(probe([fixture.dependency]), change).resolves.toEqual(
          change === "sibling" ? { missing: [] } : rejected
        );
        expect(readFileSync(mutationMarker, "utf8")).toBe("changed");
        await rm(changingPackage, { recursive: true });
        await rm(`${changingPackage}.moved`, { recursive: true, force: true });
      }
      await writeFile(modulePath, "VALUE = 1\n", "utf8");
      await writeFile(recordPath, `${fixture.dependency.importModule}.py,,\n`, "utf8");
      const hardlinkSource = path.join(purelib, "hardlink-source.py");
      await unlink(modulePath);
      await writeFile(hardlinkSource, "VALUE = 1\n", "utf8");
      await link(hardlinkSource, modulePath);
      await expect(probe([fixture.dependency]), "hard-linked module").resolves.toEqual({
        missing: []
      });
      await unlink(modulePath);
      await unlink(hardlinkSource);
      await writeFile(modulePath, "VALUE = 1\n", "utf8");

      if (process.platform !== "win32") {
        const symlinkSource = path.join(purelib, "symlink-source.py");
        await unlink(modulePath);
        await writeFile(symlinkSource, "VALUE = 1\n", "utf8");
        await symlink(symlinkSource, modulePath);
        await expect(probe([fixture.dependency]), "symlinked module").resolves.toEqual(rejected);
        await unlink(modulePath);
        await unlink(symlinkSource);
        await writeFile(modulePath, "VALUE = 1\n", "utf8");
      }

      const linkedPackageSource = path.join(root, "linked-package-source");
      const linkedPackage = path.join(purelib, fixture.dependency.importModule);
      await unlink(modulePath);
      await mkdir(linkedPackageSource);
      await writeFile(path.join(linkedPackageSource, "__init__.py"), "VALUE = 1\n", "utf8");
      await symlink(linkedPackageSource, linkedPackage, process.platform === "win32" ? "junction" : "dir");
      await writeFile(recordPath, `${fixture.dependency.importModule}/__init__.py,,\n`, "utf8");
      await expect(probe([fixture.dependency]), "symlinked package directory").resolves.toEqual(rejected);
      await unlink(linkedPackage);
      await writeFile(modulePath, "VALUE = 1\n", "utf8");

      const namespaceName = "openwrangler_namespace_probe";
      const namespaceRoot = path.join(purelib, namespaceName);
      await mkdir(namespaceRoot);
      await writeFile(path.join(namespaceRoot, "data.txt"), "namespace\n", "utf8");
      await writeFile(recordPath, `${namespaceName}/data.txt,,\n`, "utf8");
      await expect(
        probe([{ ...fixture.dependency, importModule: namespaceName }]),
        "namespace module"
      ).resolves.toEqual(rejected);

      const archiveName = "openwrangler-probe-modules.zip";
      const archivePath = path.join(purelib, archiveName);
      const archivedModule = "openwrangler_archived_probe";
      await execFileAsync(
        executable,
        [
          "-I",
          "-c",
          "import sys,zipfile; zipfile.ZipFile(sys.argv[1],'w').writestr(sys.argv[2]+'.py','VALUE = 1\\n')",
          archivePath,
          archivedModule
        ],
        { timeout: 10_000 }
      );
      await writeFile(path.join(purelib, "openwrangler-archive.pth"), `${archivePath}\n`, "utf8");
      await writeFile(recordPath, `${archiveName}/${archivedModule}.py,,\n`, "utf8");
      await expect(
        probe([{ ...fixture.dependency, importModule: archivedModule }]),
        "zip-imported module"
      ).resolves.toEqual(rejected);

      await writeFile(recordPath, `${fixture.dependency.importModule}.py,,\n`, "utf8");
      const exactAtLimit = "1+" + "a".repeat(PYTHON_DEPENDENCY_VERSION_MAX_LENGTH - 2);
      const exactOverLimit = `${exactAtLimit}a`;
      for (const [version, supported] of [
        [exactAtLimit, true],
        [exactOverLimit, false]
      ] as const) {
        await writeFile(
          metadataPath,
          ["Metadata-Version: 2.1", `Name: ${fixture.dependency.distribution}`, `Version: ${version}`, ""].join("\n"),
          "utf8"
        );
        const dependency = {
          ...fixture.dependency,
          installSpec: `${fixture.dependency.distribution}==${version}`,
          exactVersion: version,
          minimumVersion: undefined,
          maximumVersionExclusive: undefined
        };
        await expect(probe([dependency]), `descriptor length ${version.length}`).resolves.toEqual(
          supported ? { missing: [] } : { missing: [dependency.installSpec] }
        );
      }
      for (const entry of fixture.cases) {
        await writeFile(
          path.join(metadataRoot, "METADATA"),
          ["Metadata-Version: 2.1", `Name: ${fixture.dependency.distribution}`, `Version: ${entry.version}`, ""].join(
            "\n"
          ),
          "utf8"
        );
        await expect(probe([fixture.dependency]), entry.name).resolves.toEqual(
          entry.supported ? { missing: [] } : { missing: [fixture.dependency.installSpec] }
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function contract(): VersionContract {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "fixtures", "dependency-version-contract.json"), "utf8")
  ) as VersionContract;
}

function selectedPython(): string {
  return (
    process.env.OPEN_WRANGLER_TEST_PYTHON ??
    process.env.OPEN_WRANGLER_PYTHON ??
    (process.platform === "win32" ? "python" : "python3")
  );
}
