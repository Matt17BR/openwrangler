import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { classifyDependencyProbe, probeDependencies } from "../extension/pythonEnvironment";
import type { PythonDependency } from "../extension/pythonEnvironmentModel";

const execFileAsync = promisify(execFile);

interface VersionContract {
  dependency: PythonDependency;
  cases: { name: string; version: string; supported: boolean }[];
}

describe("selected-interpreter PEP 440 dependency probing", () => {
  it("trusts only the selected interpreter's compatibility decision", () => {
    const dependency = contract().dependency;
    expect(classifyDependencyProbe([dependency], { [dependency.importModule]: { supported: true } })).toEqual({
      available: [dependency.importModule],
      missing: []
    });
    for (const observed of [
      {},
      { [dependency.importModule]: { supported: false } },
      { [dependency.importModule]: { supported: "true" } }
    ]) {
      expect(classifyDependencyProbe([dependency], observed)).toEqual({
        available: [],
        missing: [dependency.installSpec]
      });
    }
  });

  it("matches the post-install PEP 440 contract in a real isolated probe", async () => {
    const fixture = contract();
    const root = await mkdtemp(path.join(tmpdir(), "openwrangler-pep440-probe-"));
    try {
      const environment = path.join(root, "venv");
      await execFileAsync(selectedPython(), ["-m", "venv", environment], { timeout: 30_000 });
      const executable = path.join(
        environment,
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
      );
      const { stdout } = await execFileAsync(
        executable,
        ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
        { timeout: 10_000 }
      );
      const purelib = stdout.trim();
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
      await expect(probeDependencies(executable, [fixture.dependency]), "shadowed import module").resolves.toEqual({
        available: [],
        missing: [fixture.dependency.installSpec]
      });
      await writeFile(recordPath, `${fixture.dependency.importModule}.py,,\n`, "utf8");
      const rejected = { available: [], missing: [fixture.dependency.installSpec] };

      await writeFile(modulePath, "__file__ = __file__ + '.moved'\n", "utf8");
      await expect(probeDependencies(executable, [fixture.dependency]), "path-changing module").resolves.toEqual(
        rejected
      );
      await writeFile(modulePath, "VALUE = 1\n", "utf8");

      const hardlinkSource = path.join(purelib, "hardlink-source.py");
      await unlink(modulePath);
      await writeFile(hardlinkSource, "VALUE = 1\n", "utf8");
      await link(hardlinkSource, modulePath);
      await expect(probeDependencies(executable, [fixture.dependency]), "hard-linked module").resolves.toEqual(
        rejected
      );
      await unlink(modulePath);
      await unlink(hardlinkSource);
      await writeFile(modulePath, "VALUE = 1\n", "utf8");

      if (process.platform !== "win32") {
        const symlinkSource = path.join(purelib, "symlink-source.py");
        await unlink(modulePath);
        await writeFile(symlinkSource, "VALUE = 1\n", "utf8");
        await symlink(symlinkSource, modulePath);
        await expect(probeDependencies(executable, [fixture.dependency]), "symlinked module").resolves.toEqual(
          rejected
        );
        await unlink(modulePath);
        await unlink(symlinkSource);
        await writeFile(modulePath, "VALUE = 1\n", "utf8");
      }

      const namespaceName = "openwrangler_namespace_probe";
      const namespaceRoot = path.join(purelib, namespaceName);
      await mkdir(namespaceRoot);
      await writeFile(path.join(namespaceRoot, "data.txt"), "namespace\n", "utf8");
      await writeFile(recordPath, `${namespaceName}/data.txt,,\n`, "utf8");
      await expect(
        probeDependencies(executable, [{ ...fixture.dependency, importModule: namespaceName }]),
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
        probeDependencies(executable, [{ ...fixture.dependency, importModule: archivedModule }]),
        "zip-imported module"
      ).resolves.toEqual(rejected);

      await writeFile(recordPath, `${fixture.dependency.importModule}.py,,\n`, "utf8");
      for (const entry of fixture.cases) {
        await writeFile(
          path.join(metadataRoot, "METADATA"),
          ["Metadata-Version: 2.1", `Name: ${fixture.dependency.distribution}`, `Version: ${entry.version}`, ""].join(
            "\n"
          ),
          "utf8"
        );
        await expect(probeDependencies(executable, [fixture.dependency]), entry.name).resolves.toEqual(
          entry.supported
            ? { available: [fixture.dependency.importModule], missing: [] }
            : { available: [], missing: [fixture.dependency.installSpec] }
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
